import test from "node:test";
import assert from "node:assert/strict";
import { dnsBody, identifier, pages, project, responseError } from "../web-api/providers/cloudflare.mjs";
import { saveAccount } from "../web-api/services/accounts.mjs";

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
