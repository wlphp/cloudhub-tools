import test from "node:test";
import assert from "node:assert/strict";
import { createWorker, workerAccess, workerInput, dnsBody, identifier, pages, project, responseError } from "../web-api/providers/cloudflare.mjs";
import { saveAccount } from "../web-api/services/accounts.mjs";

test("Worker access reads live settings without mutating resources", async () => {
  const calls = [];
  const result = await workerAccess(1, "a".repeat(32), { name: "demo" }, async (...args) => {
    calls.push(args);
    return { result: args[2].endsWith("/scripts/demo/subdomain") ? { enabled: true } : { subdomain: "example" } };
  });
  assert.deepEqual(result, { enabled: true, url: "https://demo.example.workers.dev" });
  assert.ok(calls.every(call => call[1] === "GET"));
  assert.equal(calls.length, 2);
});

test("Worker access distinguishes disabled, unconfigured, malformed and denied settings", async () => {
  let calls = 0;
  assert.deepEqual(await workerAccess(1, "a".repeat(32), { name: "demo" }, async () => { calls++; return { result: { enabled: false } }; }), { enabled: false });
  assert.equal(calls, 1);
  const unconfigured = await workerAccess(1, "a".repeat(32), { name: "demo" }, async (_id, _method, path) => ({ result: path.includes("/scripts/") ? { enabled: true } : { subdomain: "" } }));
  assert.match(unconfigured.warning, /尚未配置/);
  assert.equal(unconfigured.url, undefined);
  for (const invalid of ["evil.test/path", "-invalid", null]) {
    await assert.rejects(workerAccess(1, "a".repeat(32), { name: "demo" }, async (_id, _method, path) => ({ result: path.includes("/scripts/") ? { enabled: true } : { subdomain: invalid } })), /格式无效/);
  }
  await assert.rejects(workerAccess(1, "a".repeat(32), { name: "../bad" }, async () => { throw new Error("must not fetch"); }), /名称无效/);
  await assert.rejects(workerAccess(1, "a".repeat(32), { name: "demo" }, async () => { throw new Error("Cloudflare HTTP 403"); }), /403/);
});

test("Cloudflare errors provide safe operation guidance by status", () => {
  for (const [status, hint] of [[401, "失效"], [403, "权限不足"], [404, "资源不存在"], [429, "请求过于频繁"], [503, "服务暂时异常"]]) {
    const message = responseError(status, { success: false, errors: [{ code: 10000, message: "untrusted provider text" }] });
    assert.ok(message.includes(hint));
    assert.ok(!message.includes("untrusted provider text"));
  }
});

test("Worker input rejects invalid names, empty code and UTF-8 byte overflow", () => {
  const input = { name: "demo-worker", code: "export default {fetch(){return new Response('ok')}}" };
  assert.equal(workerInput(input), "demo-worker");
  assert.equal(workerInput({ ...input, name: "a" }), "a");
  for (const name of ["", "Upper", "a_b", "-demo", "demo-", "a/b", "a".repeat(64)]) assert.throws(() => workerInput({ ...input, name }));
  for (const code of [" ", "\0", "中".repeat(349526)]) assert.throws(() => workerInput({ ...input, code }));
});

test("Worker creation checks live names before any upload", async () => {
  const calls = [];
  await assert.rejects(createWorker(1, "a".repeat(32), { name: "demo", code: "export default {}" }, async (...args) => {
    calls.push(args); return { result: [{ id: "demo" }] };
  }), /同名/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "GET");
});

test("Worker uploads module metadata and code, then enables the address", async () => {
  const calls = [];
  const code = "export default {fetch(){return new Response('你好')}}";
  const result = await createWorker(1, "a".repeat(32), { name: "demo", code }, async (...args) => {
    calls.push(args);
    return { result: args[2].endsWith("/workers/subdomain") ? { subdomain: "example" } : [] };
  });
  assert.equal(result.url, "https://demo.example.workers.dev");
  assert.deepEqual(calls.map(c => c[1]), ["GET", "PUT", "POST", "GET"]);
  const form = calls[1][4];
  assert.equal(await form.get("worker.mjs").text(), code);
  assert.equal(form.get("worker.mjs").type, "application/javascript+module");
  assert.equal(JSON.parse(await form.get("metadata").text()).main_module, "worker.mjs");
  assert.deepEqual(calls[2][4], { enabled: true, previews_enabled: false });
});

test("Worker upload failure stops, address failure reports deployed with a warning", async () => {
  let calls = 0;
  await assert.rejects(createWorker(1, "a".repeat(32), { name: "demo", code: "export default {}" }, async () => {
    if (++calls === 1) return { result: [] };
    throw new Error("upload failed");
  }), /upload failed/);
  assert.equal(calls, 2);
  calls = 0;
  const result = await createWorker(1, "a".repeat(32), { name: "demo", code: "export default {}" }, async () => {
    if (++calls < 3) return { result: [] };
    throw new Error("untrusted provider text");
  });
  assert.equal(result.success, true);
  assert.match(result.warning, /代码已部署/);
  assert.ok(!result.warning.includes("untrusted provider text"));
  assert.equal(result.url, undefined);
});

test("Cloudflare errors expose only status and numeric codes", () => {
  for (const status of [401, 403, 429, 503, 200]) {
    const message = responseError(status, { success: false, errors: [{ code: 10000, message: "untrusted provider text" }] });
    assert.match(message, new RegExp(`HTTP ${status}`));
    assert.match(message, /10000/);
    assert.ok(!message.includes("untrusted provider text"));
  }
  assert.match(responseError(200, null), /格式/);
  assert.equal(responseError(200, { success: true }), null);
});

test("Cloudflare account identity change requires a newly provided token", () => {
  const repository = { getAccountForUpdate: () => ({ cloud_type: "aliyun", access_key_id: "previous-account" }) };
  assert.throws(() => saveAccount({ id: 1, account_name: "example", cloud_type: "cloudflare", access_key_id: "a".repeat(32) }, { accountRepository: repository }), /重新填写 API Token/);
  assert.throws(() => saveAccount({ account_name: "example", cloud_type: "cloudflare", access_key_id: "invalid" }, {}), /Account ID/);
});

test("Cloudflare validates DNS payloads and removes unapproved fields", () => {
  const input = { type: "A", name: "example.test", content: "192.0.2.1", ttl: 300, proxied: true, extra: "discard" };
  assert.deepEqual(dnsBody(input), { type: "A", name: "example.test", content: "192.0.2.1", ttl: 1, proxied: true });
  for (const patch of [{ content: "invalid" }, { ttl: 20 }, { name: "x/../y" }, { type: "TXT", proxied: true }, { type: "MX", proxied: false, priority: -1 }]) assert.throws(() => dnsBody({ ...input, ...patch }));
  assert.throws(() => identifier("../accounts"));
  assert.throws(() => identifier("x".repeat(32)));
  assert.deepEqual(project({ name: "demo", deployment_configs: { env_vars: { PRIVATE: "hidden" } } }, ["name"]), { name: "demo" });
});

test("Cloudflare follows numbered pages even when provider returns fewer rows than requested", async () => {
  const requests = [];
  const rows = await pages(async query => { requests.push(query); return { result: [{ name: `page-${query.page}` }], result_info: { total_pages: 2 } }; });
  assert.equal(rows.length, 2);
  assert.deepEqual(requests.map(q => q.page), [1, 2]);
});

test("R2 follows cursor and refuses a repeated cursor", async () => {
  const requests = [];
  const rows = await pages(async q => { requests.push(q); return { result: { buckets: [{ name: q.cursor ? "second" : "first" }] }, result_info: { cursor: q.cursor ? undefined : "next-page" } }; }, { buckets: true });
  assert.equal(rows.length, 2);
  assert.deepEqual(requests, [{}, { cursor: "next-page" }]);
  await assert.rejects(pages(async () => ({ result: { buckets: [] }, result_info: { cursor: "same" } }), { buckets: true }), /游标/);
  await assert.rejects(pages(async () => ({ result: {} })), /格式/);
});
