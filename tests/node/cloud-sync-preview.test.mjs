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

test("version deletion validates exact paths, preserves concurrent index additions and is retryable", async () => {
  const id = "backup-11111111-1111-4111-8111-111111111111.chdb";
  const other = "backup-22222222-2222-4222-8222-222222222222.chdb";
  const version = id => ({ id, machineName: "fixture", uploadedAt: "2026-10-30T01:00:00Z" });
  let index = [version(id)], writes = 0, deleted = [], requests = 0;
  const service = serviceFixture(async (url, init) => {
    requests++;
    if (init.method === "DELETE") { deleted.push(url.pathname); return new Response(null, { status: deleted.length === 1 ? 204 : 404 }); }
    if (init.method === "GET") return new Response(JSON.stringify(index), { headers: { ETag: `"${writes}"` } });
    if (init.method === "PUT") {
      assert.equal(init.headers["If-Match"], `"${writes}"`);
      if (writes++ === 0) { index.push(version(other)); return new Response(null, { status: 412 }); }
      index = JSON.parse(init.body.toString()); return new Response(null, { status: 200 });
    }
    throw new Error("unexpected method");
  });
  await service.save(configFixture("https://dav.example.test"));
  for (const invalid of [undefined, null, "", "../database.chdb", `${id}.json`, "versions.json"]) {
    await assert.rejects(service.deleteVersion(invalid), /参数无效|版本无效/);
  }
  assert.equal(requests, 0);
  await service.deleteVersion(id);
  assert.deepEqual(index.map(item => item.id), [other]);
  assert.equal(writes, 2);
  assert.deepEqual(deleted, [`/cloudhub-sync/v1/default/${id}`]);
  await service.deleteVersion(id);
  await service.deleteVersion("database.chdb");
  assert.equal(writes, 2);
  assert.equal(deleted.at(-1), "/cloudhub-sync/v1/default/database.chdb");
});

test("denied deletion keeps metadata and never exposes vendor response bodies", async () => {
  const methods = [];
  const service = serviceFixture(async (_url, init) => {
    methods.push(init.method); return new Response("private-vendor-response", { status: 403 });
  });
  await service.save(configFixture("https://dav.example.test"));
  await assert.rejects(service.deleteVersion("backup-11111111-1111-4111-8111-111111111111.chdb"), error => {
    assert.doesNotMatch(error.message, /private-vendor-response/); return /权限|认证/.test(error.message);
  });
  assert.deepEqual(methods, ["DELETE"]);
});

test("OSS removes version objects and hides removed legacy entries without rewriting shared indexes", async () => {
  const id = "backup-11111111-1111-4111-8111-111111111111.chdb";
  const base = "/cloudhub-sync/v1/default/";
  const legacy = [{ id, machineName: "fixture", uploadedAt: "2026-10-30T01:00:00Z" }];
  const objects = new Map([[`${base}versions.json`, Buffer.from(JSON.stringify(legacy))], [`${base}${id}`, packageFixture()]]);
  const deleted = [];
  const service = serviceFixture(async (url, init) => {
    assert.notEqual(init.method, "PUT");
    if (init.method === "DELETE") {
      assert.match(init.headers.Authorization, /^OSS /);
      deleted.push(url.pathname); return new Response(null, { status: objects.delete(url.pathname) ? 204 : 404 });
    }
    if (url.pathname === "/") {
      const keys = [...objects.keys()].filter(key => key.startsWith(`${base}backup-`)).sort();
      return new Response(`<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>${keys.map(key => `<Contents><Key>${encodeURIComponent(key.slice(1))}</Key></Contents>`).join("")}</ListBucketResult>`);
    }
    const body = objects.get(url.pathname);
    return new Response(init.method === "HEAD" ? null : body, { status: body ? 200 : 404 });
  });
  await service.save({ ...defaults, method: "oss", endpoint: "https://oss-cn-beijing.aliyuncs.com", bucket: "fixture-bucket", region: "cn-beijing", accessKeyId: "fixture-access", secretKey: "fixture-signing" });
  assert.deepEqual(await service.versions(), legacy);
  await service.deleteVersion(id);
  assert.deepEqual(await service.versions(), []);
  assert.deepEqual(deleted, [`${base}${id}`, `${base}${id}.json`]);
  assert.deepEqual(JSON.parse(objects.get(`${base}versions.json`)), legacy);
});

test("S3 signature agrees with the native independently verified fixture", () => {
  const config = { ...defaults, method: "s3", region: "test-region", accessKeyId: "fixture-access", secretKey: "fixture-signing" };
  const headers = signedHeaders(config, "PUT", new URL("https://storage.example:9443/bucket/folder%20name/database.chdb"), Buffer.from("fixture-backup"), "20261026T120000Z");
  assert.match(headers.Authorization, /Signature=c63e054765ada4c911fc1a2ec1dd5eaf79e55a3aee0d13681f942abad53044ce$/);
  assert.match(headers.Authorization, /Credential=fixture-access\/20261026\/test-region\/s3\/aws4_request/);
  const endpoint = { ...config, endpoint: "https://storage.example/dav/", bucket: "fixture-bucket", remoteRoot: "folder with spaces" };
  assert.equal(targetUrl(endpoint).href, "https://storage.example/dav/fixture-bucket/folder%20with%20spaces/v1/default/database.chdb");
  assert.equal(targetUrl({ ...endpoint, pathStyle: false }).hostname, "fixture-bucket.storage.example");
});

test("OSS uses bucket hosts once and signs the actual MIME type with OSS authentication", () => {
  const config = { ...defaults, method: "s3", bucket: "fixture-bucket", region: "cn-beijing", accessKeyId: "fixture-access", secretKey: "fixture-signing", remoteRoot: "folder with spaces" };
  for (const [storageMethod, endpoint] of ["s3", "oss"].flatMap(method => ["https://oss-cn-beijing.aliyuncs.com", "https://fixture-bucket.oss-cn-beijing.aliyuncs.com"].map(endpoint => [method, endpoint]))) {
    for (const pathStyle of [true, false]) {
      const settings = { ...config, endpoint, pathStyle, method: storageMethod };
      const url = targetUrl(settings);
      assert.equal(url.href, "https://fixture-bucket.oss-cn-beijing.aliyuncs.com/folder%20with%20spaces/v1/default/database.chdb");
      assert.equal(targetUrl(settings, false).href, "https://fixture-bucket.oss-cn-beijing.aliyuncs.com/");
      const headers = signedHeaders(settings, "PUT", url, Buffer.from("fixture-backup"), "20261030T020000Z");
      // Independently calculated using .NET HMACSHA1.
      assert.equal(headers.Authorization, "OSS fixture-access:77DFBf0D8JRsN04phrbXWl0DNcA=");
      assert.equal(headers.Date, "Fri, 30 Oct 2026 02:00:00 GMT");
      assert.equal(headers["x-amz-date"], undefined);
      for (const method of ["GET", "HEAD", "PUT"]) {
        const index = new URL("versions.json", url);
        const result = signedHeaders(settings, method, index, Buffer.alloc(0), "20261030T020000Z");
        const mime = method === "PUT" ? "application/json" : "";
        const signature = crypto.createHmac("sha1", settings.secretKey).update(`${method}\n\n${mime}\n${result.Date}\n/fixture-bucket/folder with spaces/v1/default/versions.json`).digest("base64");
        assert.equal(result.Authorization, `OSS fixture-access:${signature}`);
      }
    }
  }
  const lookalike = { ...config, endpoint: "https://oss-cn-beijing.aliyuncs.com.example.org" };
  assert.match(signedHeaders(lookalike, "PUT", targetUrl(lookalike)).Authorization, /^AWS4-HMAC-SHA256/);
});

test("dedicated OSS channels validate, save and retain credentials by identity", async () => {
  const service = serviceFixture();
  const config = { ...defaults, method: "oss", endpoint: "https://oss-cn-beijing.aliyuncs.com", bucket: "fixture-bucket", region: "cn-beijing", accessKeyId: "fixture-access", secretKey: "fixture-signing" };
  const view = await service.save(config);
  assert.equal(view.config.method, "oss");
  assert.equal(view.config.hasSecretKey, true);
  assert.equal(JSON.stringify(view).includes("fixture-signing"), false);
  await service.save({ ...config, secretKey: "" });
  assert.equal(service.reveal(config, "secretKey"), "fixture-signing");
  assert.throws(() => mergeConfig({ ...config, endpoint: "https://storage.example" }), /OSS/);
  assert.throws(() => mergeConfig({ ...config, endpoint: "https://oss-cn-beijing.aliyuncs.com.example.org" }), /OSS/);
});

test("OSS upload errors classify bounded vendor bodies without exposing raw values", async () => {
  const config = { ...defaults, method: "oss", endpoint: "https://oss-cn-beijing.aliyuncs.com", bucket: "fixture-bucket", region: "cn-beijing", accessKeyId: "fixture-access", secretKey: "fixture-signing" };
  for (const [body, code] of [
    ["<Error><Code>InvalidRequest</Code><Message>private-fixture</Message><StringToSign>private-fixture</StringToSign></Error>", "InvalidRequest"],
    ["<Code>private-fixture</Code>", "Unknown"],
    ["<Code>InvalidRequest", "Unknown"],
    ["x".repeat(17 * 1024) + "<Code>InvalidRequest</Code>", "Unknown"],
  ]) {
    const service = serviceFixture(async () => new Response(body, { status: 400 }));
    await service.save(config);
    await assert.rejects(service.upload(packageFixture()), error => {
      assert.match(error.message, /上传文件/);
      assert.ok(error.message.includes(`OSS ${code}`));
      assert.match(error.message, /HTTP 400/);
      assert.equal(error.message.includes("private-fixture"), false);
      assert.equal(error.message.includes("fixture-signing"), false);
      return true;
    });
  }
});

test("OSS uses signed native overwrite protection and independent paginated version records", async () => {
  const config = { ...defaults, method: "oss", endpoint: "https://oss-cn-beijing.aliyuncs.com", bucket: "fixture-bucket", region: "cn-beijing", accessKeyId: "fixture-access", secretKey: "fixture-signing", remoteRoot: "folder with spaces" };
  const legacy = { id: "backup-11111111-1111-4111-8111-111111111111.chdb", machineName: "legacy-fixture", uploadedAt: "2026-10-29T12:00:00Z" };
  const basePath = "/folder%20with%20spaces/v1/default/", objects = new Map([
    [`${basePath}versions.json`, Buffer.from(JSON.stringify([legacy]))],
    [`${basePath}${legacy.id}`, packageFixture()],
  ]);
  let pages = 0;
  const fetchRemote = async (url, init) => {
    assert.equal(init.headers["If-Match"], undefined);
    assert.equal(init.headers["If-None-Match"], undefined);
    if (init.method === "PUT") {
      assert.equal(init.headers["x-oss-forbid-overwrite"], "true");
      assert.equal(init.headers["x-amz-date"], undefined);
      assert.notEqual(url.pathname, `${basePath}versions.json`);
      const canonical = `PUT\n\n${init.headers["Content-Type"]}\n${init.headers.Date}\nx-oss-forbid-overwrite:true\n/fixture-bucket${decodeURIComponent(url.pathname)}`;
      const signature = crypto.createHmac("sha1", config.secretKey).update(canonical).digest("base64");
      assert.equal(init.headers.Authorization, `OSS fixture-access:${signature}`);
      const body = Buffer.isBuffer(init.body) ? init.body : await readLimited(init.body);
      assert.equal(init.headers["Content-Length"], String(body.length));
      if (objects.has(url.pathname)) return new Response("<Code>FileAlreadyExists</Code>", { status: 409 });
      objects.set(url.pathname, body);
      return new Response(null, { status: 200, headers: { ETag: '"fixture"' } });
    }
    if (init.method === "GET" && url.pathname === "/") {
      pages++;
      assert.equal(url.searchParams.get("encoding-type"), "url");
      assert.equal(url.searchParams.get("prefix"), "folder with spaces/v1/default/backup-");
      const keys = [...objects.keys()].map(key => decodeURIComponent(key.slice(1))).filter(key => key.startsWith(url.searchParams.get("prefix")) && key > url.searchParams.get("marker")).sort();
      const key = keys[0], truncated = keys.length > 1;
      return new Response(`<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextMarker>${encodeURIComponent(key)}</NextMarker>` : ""}${key ? `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>` : ""}</ListBucketResult>`);
    }
    const body = objects.get(url.pathname);
    // Read-only legacy indexes do not need ETags on OSS.
    return new Response(init.method === "HEAD" ? null : body, { status: body ? 200 : 404 });
  };
  const first = serviceFixture(fetchRemote), second = serviceFixture(fetchRemote);
  await first.save(config); await second.save(config);
  await Promise.all([first.upload(packageFixture()), second.upload(packageFixture())]);
  const versions = await first.versions();
  assert.equal(versions.length, 3); assert.equal(new Set(versions.map(v => v.id)).size, 3);
  assert.deepEqual(versions.find(v => v.id === legacy.id), legacy);
  assert.equal(pages, 5);
  assert.deepEqual(JSON.parse(objects.get(`${basePath}versions.json`).toString()), [legacy]);
  for (const version of versions) assert.deepEqual(await second.download(version.id), packageFixture());
});

test("OSS confirms only the exact metadata record after a lost acknowledgement", async () => {
  const config = { ...defaults, method: "oss", endpoint: "https://oss-cn-beijing.aliyuncs.com", bucket: "fixture-bucket", region: "cn-beijing", accessKeyId: "fixture-access", secretKey: "fixture-signing" };
  for (const committed of [true, false]) {
    let record;
    const service = serviceFixture(async (url, init) => {
      if (init.method === "GET") return record ? new Response(record) : new Response(null, { status: 404 });
      if (!url.pathname.endsWith(".json")) { await readLimited(init.body); return new Response(null); }
      if (committed) record = init.body;
      throw new TypeError("private-fixture", { cause: { code: "UND_ERR_SOCKET" } });
    });
    await service.save(config);
    if (committed) { await service.upload(packageFixture()); assert.ok(service.state().status.lastUpload); }
    else await assert.rejects(service.upload(packageFixture()), /备份文件已上传，但版本目录登记失败/);
  }
});

test("OSS rejects out-of-scope, non-advancing and malformed remote version lists", async () => {
  const config = { ...defaults, method: "oss", endpoint: "https://oss-cn-beijing.aliyuncs.com", bucket: "fixture-bucket", region: "cn-beijing", accessKeyId: "fixture-access", secretKey: "fixture-signing" };
  const prefix = "cloudhub-sync/v1/default/backup-";
  const validKey = `${prefix}11111111-1111-4111-8111-111111111111.chdb.json`;
  for (const xml of [
    "<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated><NextMarker></NextMarker></ListBucketResult>",
    `<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated><Contents><Key>../private.json</Key></Contents></ListBucketResult>`,
    `<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated><Contents><Key>${validKey.replace("backup-", "backup-/../../")}</Key></Contents></ListBucketResult>`,
    `<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated><Contents><Key>&external;</Key></Contents></ListBucketResult>`,
  ]) {
    let recordReads = 0;
    const service = serviceFixture(async (url) => {
      if (url.pathname.endsWith("versions.json")) return new Response(null, { status: 404 });
      if (url.pathname === "/") return new Response(xml);
      recordReads++; throw new Error("must not fetch arbitrary keys");
    });
    await service.save(config);
    await assert.rejects(service.versions(), /OSS 版本|备份版本无效/);
    assert.equal(recordReads, 0);
  }
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
  assert.equal(first.passwordProtected, false);
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
