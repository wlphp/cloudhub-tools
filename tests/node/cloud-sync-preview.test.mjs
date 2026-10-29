import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import crypto from "node:crypto";
import { test } from "node:test";
import { createCloudSyncService, createCloudSyncChannels, defaults, mergeConfig, readLimited, signedHeaders, targetUrl, validatePackage } from "../../web-api/services/cloud-sync.mjs";

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

test("channels migrate legacy settings and isolate credentials, objects and status", async () => {
  let stored = configFixture("https://first.example/dav");
  const objects = new Map();
  const channels = createCloudSyncChannels({
    load: () => structuredClone(stored), persist: config => { stored = structuredClone(config); },
    fetchRemote: async (url, init) => {
      const key = url.href, existing = objects.get(key);
      const expected = url.hostname === "first.example" ? "non-sensitive-fixture" : "second-fixture-password";
      assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`fixture-user:${expected}`).toString("base64")}`);
      if (init.method === "MKCOL") return new Response(null, { status: 405 });
      if (init.method === "HEAD") return new Response(null, { status: existing ? 200 : 404 });
      if (init.method === "GET") return existing ? new Response(existing, { headers: { ETag: '"fixture"' } }) : new Response(null, { status: 404 });
      assert.equal(init.method, "PUT");
      objects.set(key, Buffer.isBuffer(init.body) ? init.body : await readLimited(init.body));
      return new Response(null, { status: 201, headers: { ETag: '"fixture"' } });
    },
  });
  assert.equal(channels.list()[0].config.name, "默认渠道");
  const secondId = "22222222-2222-4222-8222-222222222222";
  const second = channels.channel(secondId);
  await assert.rejects(second.save({ ...configFixture("https://second.example/dav"), id: secondId, name: "备用渠道", password: "" }), /请填写/);
  await second.save({ ...configFixture("https://second.example/dav"), id: secondId, name: "备用渠道", password: "second-fixture-password" });
  const first = channels.channel();
  assert.equal(channels.list().length, 2);
  assert.ok(stored.channels);
  await first.upload(packageFixture());
  assert.equal(second.state().status.lastUpload, null);
  assert.equal((await first.versions()).length, 1);
  assert.equal((await second.versions()).length, 0);
  await second.upload(packageFixture());
  const selected = (await second.versions())[0];
  assert.deepEqual(await second.download(selected.id), packageFixture());
  assert.equal(first.state().status.lastDownload, null);
  await assert.rejects(first.download(selected.id), /不存在/);
  assert.equal(JSON.stringify(channels.list()).includes("second-fixture-password"), false);
  let release;
  const pending = channels.run(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(channels.run(() => channels.remove(secondId)), /正在执行/);
  release(); await pending;
  const count = objects.size;
  await channels.run(() => channels.remove(secondId));
  assert.equal(channels.list().length, 1);
  assert.equal(objects.size, count);
  assert.throws(() => channels.channel("../private"), /渠道无效/);
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
  for (const tables of [[],["../private"],"memo_notes",[123],Array(33).fill("memo_notes")]) assert.throws(()=>mergeConfig({...config,tables}));
  assert.deepEqual(mergeConfig({...config,tables:["memo_notes"]}).tables,["memo_notes"]);
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

test("WebDAV preserves versions, selects downloads and retains legacy backups", async t => {
  const fixture = packageFixture(); let version = 0, redirect = false;
  const objects = new Map([["/dav/cloudhub-sync/v1/default/database.chdb", { bytes: fixture, tag: '"legacy"' }]]);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("fixture-user:non-sensitive-fixture").toString("base64")}`);
    if (redirect) { res.writeHead(302, { Location: "http://127.0.0.1:1/leak" }); res.end("remote-secret-body"); return; }
    if (req.method === "PROPFIND") { res.writeHead(207); res.end(); return; }
    if (req.method === "MKCOL") { res.writeHead(405); res.end(); return; }
    const remote = objects.get(req.url);
    if (req.method === "HEAD" || req.method === "GET") { res.writeHead(remote ? 200 : 404, remote ? { ETag: remote.tag } : {}); res.end(req.method === "GET" ? remote?.bytes : undefined); return; }
    if (req.method === "PUT") {
      const body = await readLimited(req);
      if ((remote && req.headers["if-match"] !== remote.tag) || (!remote && req.headers["if-none-match"] !== "*")) { res.writeHead(412); res.end(); return; }
      version++; objects.set(req.url, { bytes: body, tag: `"v${version}"` }); res.writeHead(201, { ETag: `"v${version}"` }); res.end(); return;
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
  assert.deepEqual(await service.download(), fixture);
  const first = (await service.versions())[0];
  assert.ok(first.machineName.endsWith("-dev")); assert.ok(first.uploadedAt);
  assert.deepEqual(await service.download(first.id), fixture);
  await new Promise(resolve => setTimeout(resolve, 5));
  await service.upload(fixture);
  const versions = await service.versions();
  assert.equal(versions.length, 3); assert.equal(versions[1].id, first.id);
  assert.notEqual(versions[0].id, first.id);
  assert.equal(versions[2].id, "database.chdb");
  assert.deepEqual(await service.download(first.id), fixture);
  assert.deepEqual(await service.download(versions[0].id), fixture);
  assert.equal(objects.size, 4);
  await assert.rejects(service.download("../versions.json"), /版本无效/);
  const indexWrites = requests.filter(req => req.method === "PUT" && req.url.endsWith("versions.json"));
  assert.equal(indexWrites[0].headers["if-none-match"], "*");
  assert.ok(indexWrites[1].headers["if-match"]);
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

test("two S3 devices merge racing index updates without losing either backup", async () => {
  const objects = new Map();
  let counter = 0, conflicts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  let initialReads = 0;
  const fetchRemote = async (url, init) => {
    const key = url.pathname, existing = objects.get(key);
    assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 /);
    if (init.method === "HEAD") return new Response(null, { status: existing ? 200 : 404 });
    if (init.method === "GET") {
      if (!existing && key.endsWith("versions.json") && initialReads < 2) {
        if (++initialReads === 2) release();
        await gate;
      }
      return existing ? new Response(existing.bytes, { headers: { ETag: existing.tag } }) : new Response(null, { status: 404 });
    }
    assert.equal(init.method, "PUT");
    const bytes = Buffer.isBuffer(init.body) ? init.body : await readLimited(init.body);
    const current = objects.get(key);
    if ((current && init.headers["If-Match"] !== current.tag) || (!current && init.headers["If-None-Match"] !== "*")) {
      conflicts++; return new Response(null, { status: 412 });
    }
    const tag = `"${++counter}"`; objects.set(key, { bytes, tag });
    return new Response(null, { status: 201, headers: { ETag: tag } });
  };
  const first = serviceFixture(fetchRemote), second = serviceFixture(fetchRemote);
  const config = { ...defaults, method: "s3", endpoint: "https://storage.example", bucket: "fixture-bucket", accessKeyId: "fixture-access", secretKey: "fixture-signing" };
  await first.save(config); await second.save(config);
  await Promise.all([first.upload(packageFixture()), second.upload(packageFixture())]);
  const versions = await first.versions();
  assert.equal(versions.length, 2); assert.notEqual(versions[0].id, versions[1].id);
  assert.equal(conflicts, 1);
  for (const version of versions) assert.deepEqual(await second.download(version.id), packageFixture());
});

test("invalid remote version metadata cannot select arbitrary remote paths", async () => {
  const service = serviceFixture(async () => new Response(JSON.stringify([{ id: "../private", machineName: "fixture", uploadedAt: "2026-10-29T12:00:00Z" }]), { headers: { ETag: '"fixture"' } }));
  await service.save(configFixture("https://storage.example"));
  await assert.rejects(service.versions(), /版本无效/);
});

test("index uploads confirm committed writes after a lost acknowledgement", async () => {
  for (const committed of [true, false]) {
    let index = null, backupWrites = 0, indexWrites = 0;
    const service = serviceFixture(async (url, init) => {
      if (init.method === "MKCOL") return new Response(null, { status: 405 });
      if (init.method === "GET") return index
        ? new Response(index, { headers: { ETag: '"fixture-index"' } })
        : new Response(null, { status: 404 });
      assert.equal(init.method, "PUT");
      if (url.pathname.endsWith("/versions.json")) {
        indexWrites++;
        assert.ok(Buffer.isBuffer(init.body));
        assert.equal(init.duplex, undefined);
        assert.equal(init.headers["Content-Type"], "application/json");
        assert.equal(init.headers["Content-Length"], String(init.body.length));
        if (committed) index = init.body;
        throw new TypeError("private endpoint and credentials", { cause: { code: "UND_ERR_SOCKET" } });
      }
      backupWrites++;
      assert.equal(init.duplex, "half");
      assert.deepEqual(await readLimited(init.body), packageFixture());
      return new Response(null, { status: 201 });
    });
    await service.save(configFixture("https://storage.example"));
    if (committed) {
      await service.upload(packageFixture());
      assert.ok(service.state().status.lastUpload);
      assert.equal(service.state().status.error, null);
    } else {
      await assert.rejects(service.upload(packageFixture()), error =>
        /备份文件已上传，但版本目录登记失败/.test(error.message)
        && /连接在请求过程中中断/.test(error.message) && !error.message.includes("private"));
      assert.equal(service.state().status.lastUpload, null);
    }
    assert.equal(backupWrites, 1);
    assert.equal(indexWrites, 1);
    assert.equal(service.state().status.busy, false);
    assert.equal(service.state().status.progress, null);
  }
});

test("connection errors expose safe categories without endpoint or credentials", async () => {
  for (const [code, message] of [["ENOTFOUND", "域名解析失败"], ["ECONNREFUSED", "拒绝连接"], ["ETIMEDOUT", "请求超时"], ["CERT_HAS_EXPIRED", "证书校验失败"]]) {
    const service = serviceFixture(async () => {
      throw new TypeError("private endpoint and credentials", { cause: { code } });
    });
    await service.save(configFixture("https://storage.example"));
    await assert.rejects(service.test(configFixture("https://storage.example")), error =>
      error.message.includes(message) && !error.message.includes("private"));
  }
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
