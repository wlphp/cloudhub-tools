import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import crypto from "node:crypto";
import { test } from "node:test";
import { createCloudSyncService, defaults, mergeConfig, readLimited, signedHeaders, targetUrl, validatePackage } from "../../web-api/services/cloud-sync.mjs";

function packageFixture() {
  const database = Buffer.from("SQLite format 3\0non-sensitive-fixture"), key = Buffer.alloc(32, 73);
  const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const manifest = Buffer.from(JSON.stringify({ format: "cloudhub-tools-database-migration", version: 1, database_sha256: hash(database), key_sha256: hash(key) }));
  const lengths = Buffer.alloc(12); lengths.writeBigUInt64LE(BigInt(database.length)); lengths.writeUInt32LE(key.length, 8);
  const header = Buffer.alloc(12); header.write("CHDBMIG1"); header.writeUInt32LE(manifest.length, 8);
  return Buffer.concat([header, manifest, lengths, database, key]);
}
const configFixture = endpoint => ({ ...defaults, endpoint, username: "fixture-user", password: "non-sensitive-fixture", allowInsecure: true });
function serviceFixture(fetchRemote) {
  let stored;
  return createCloudSyncService({ load: () => stored ? structuredClone(stored) : null, persist: config => { stored = structuredClone(config); }, ...(fetchRemote ? { fetchRemote } : {}) });
}

test("S3 signature agrees with the native independently verified fixture", () => {
  const config = { ...defaults, method: "s3", region: "test-region", accessKeyId: "fixture-access", secretKey: "fixture-signing" };
  const headers = signedHeaders(config, "PUT", new URL("https://storage.example:9443/bucket/folder%20name/database.chdb"), Buffer.from("fixture-backup"), "20261026T120000Z");
  assert.match(headers.Authorization, /Signature=c63e054765ada4c911fc1a2ec1dd5eaf79e55a3aee0d13681f942abad53044ce$/);
  assert.match(headers.Authorization, /Credential=fixture-access\/20261026\/test-region\/s3\/aws4_request/);
  const endpoint = { ...config, endpoint: "https://storage.example/dav/", bucket: "fixture-bucket", remoteRoot: "folder with spaces" };
  assert.equal(targetUrl(endpoint).href, "https://storage.example/dav/fixture-bucket/folder%20with%20spaces/v1/default/database.chdb");
  assert.equal(targetUrl({ ...endpoint, pathStyle: false }).hostname, "fixture-bucket.storage.example");
});

test("validation retains credentials only for the same identity and rejects unsafe input", () => {
  const config = mergeConfig(configFixture("https://storage.example/dav/"));
  assert.equal(mergeConfig({ ...config, password: "" }, config).password, config.password);
  assert.throws(() => mergeConfig({ ...config, endpoint: "https://different.example", password: "" }, config), /请填写/);
  for (const endpoint of ["https://user:fixture@storage.example", "https://storage.example/?key=fixture", "file:///tmp", "http://storage.example"]) {
    assert.throws(() => mergeConfig({ ...config, endpoint, allowInsecure: false }));
  }
  for (const remoteRoot of ["../outside", "/absolute", "folder//nested", "folder\\nested"]) assert.throws(() => mergeConfig({ ...config, remoteRoot }));
  assert.throws(() => mergeConfig({ ...config, allowInsecure: "true" }));
  const forced = mergeConfig({ ...config, autoSync: true, passwordProtected: true, backupPassword: "fixture-password" });
  assert.equal(forced.autoSync, false); assert.equal(forced.passwordProtected, false); assert.equal(forced.backupPassword, "");
});

test("backup validation catches corruption and bounded readers reject oversized input", async () => {
  const fixture = packageFixture(); validatePackage(fixture);
  const damaged = Buffer.from(fixture); damaged[damaged.length - 1] ^= 1;
  assert.throws(() => validatePackage(damaged), /校验失败/);
  assert.throws(() => validatePackage(Buffer.alloc(60)), /chdb/);
  assert.throws(() => validatePackage(fixture.subarray(0, 30)));
  await assert.rejects(readLimited([Buffer.alloc(5), Buffer.alloc(6)], 10), /256 MB/);
});

test("WebDAV performs real conditional uploads/downloads and refuses stale overwrites", async t => {
  const fixture = packageFixture(); let remote = null, version = 0, redirect = false;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("fixture-user:non-sensitive-fixture").toString("base64")}`);
    if (redirect) { res.writeHead(302, { Location: "http://127.0.0.1:1/leak" }); res.end("remote-secret-body"); return; }
    if (req.method === "PROPFIND") { res.writeHead(207); res.end(); return; }
    if (req.method === "MKCOL") { res.writeHead(405); res.end(); return; }
    if (req.method === "HEAD") { res.writeHead(remote ? 200 : 404, remote ? { ETag: `"v${version}"` } : {}); res.end(); return; }
    if (req.method === "GET") { res.writeHead(200, { ETag: `"v${version}"` }); res.end(remote); return; }
    if (req.method === "PUT") {
      const body = await readLimited(req);
      if ((remote && req.headers["if-match"] !== `"v${version}"`) || (!remote && req.headers["if-none-match"] !== "*")) { res.writeHead(412); res.end(); return; }
      remote = body; version++; res.writeHead(201, { ETag: `"v${version}"` }); res.end(); return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = configFixture(`http://127.0.0.1:${server.address().port}/dav`), service = serviceFixture();
  assert.equal(service.state().configured, false);
  await service.save(config); await service.test(config);
  const view = await service.upload(async () => {
    assert.equal(service.state().status.busy, true);
    assert.equal(service.state().status.progress.phase, "preparing");
    await assert.rejects(service.upload(fixture), /正在执行/);
    return fixture;
  });
  assert.equal(view.status.busy, false); assert.ok(view.status.lastUpload);
  assert.equal(view.config.password, undefined); assert.equal(view.config.hasPassword, true);
  assert.equal(service.reveal(config, "password"), config.password);
  assert.throws(() => service.reveal({ ...config, username: "other" }, "password"));
  assert.deepEqual(remote, fixture); assert.deepEqual(await service.download(), fixture);
  await service.upload(fixture);
  assert.equal(requests.filter(req => req.method === "PUT")[1].headers["if-match"], '"v1"');
  version++;
  await assert.rejects(service.upload(fixture), /已发生变化/);
  assert.equal(service.state().status.busy, false);
  assert.ok(requests.some(req => req.method === "MKCOL" && req.url === "/dav/cloudhub-sync/v1/default/"));
  redirect = true;
  await assert.rejects(service.test(config), error => /重定向/.test(error.message) && !error.message.includes("remote-secret-body"));
});

test("concurrent actions fail explicitly and unexpected backend errors stay private", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const service = serviceFixture(async () => { await waiting; return new Response(null, { status: 207 }); });
  const config = configFixture("https://storage.example");
  await service.save(config);
  const pending = service.test(config);
  await assert.rejects(service.save(config), /正在执行/);
  release(); await pending;
  const failure = createCloudSyncService({ load: () => { throw new Error("private local path and payload"); }, persist: () => {} });
  await assert.rejects(failure.save(config), error => !error.message.includes("private"));
});

test("transfer progress counts bytes, waits for acknowledgement and clears on failure", async () => {
  const fixture = packageFixture();
  let acknowledge, sent;
  const sentSignal = new Promise(resolve => { sent = resolve; });
  const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
  const service = serviceFixture(async (_url, init) => {
    if (init.method === "MKCOL") return new Response(null, { status: 201 });
    if (init.method === "HEAD") return new Response(null, { status: 404 });
    const chunks = [];
    for await (const chunk of init.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), fixture);
    assert.equal(init.headers["Content-Length"], String(fixture.length));
    sent(); await acknowledgement;
    return new Response(null, { status: 503 });
  });
  await service.save(configFixture("https://storage.example"));
  const pending = service.upload(fixture);
  await sentSignal;
  assert.deepEqual(service.state().status.progress, { phase: "confirming", transferred: fixture.length, total: fixture.length });
  assert.equal(service.state().status.busy, true);
  assert.equal(service.state().status.lastUpload, null);
  acknowledge();
  await assert.rejects(pending, /云同步请求失败/);
  assert.equal(service.state().status.progress, null);
  assert.equal(service.state().status.busy, false);
});

test("download reports partial bytes with known and unknown size before validating", async () => {
  for (const knownSize of [true, false]) {
    const fixture = packageFixture(), split = Math.floor(fixture.length / 2);
    let continueReading, started;
    const reading = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { continueReading = resolve; });
    const source = new ReadableStream({
      async start(controller) {
        controller.enqueue(fixture.subarray(0, split));
        await gate;
        controller.enqueue(fixture.subarray(split)); controller.close();
      },
    });
    const service = serviceFixture(async () => new Response(source, { headers: knownSize ? { "Content-Length": String(fixture.length) } : {} }));
    await service.save(configFixture("https://storage.example"));
    const pending = service.download();
    // Yield until the first chunk has passed through the bounded reader.
    setImmediate(started); await reading;
    assert.deepEqual(service.state().status.progress, { phase: "downloading", transferred: split, total: knownSize ? fixture.length : null });
    assert.equal(service.state().status.lastDownload, null);
    continueReading();
    assert.deepEqual(await pending, fixture);
    assert.equal(service.state().status.progress, null);
    assert.ok(service.state().status.lastDownload);
  }
});
