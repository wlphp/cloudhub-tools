import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { deployVless, validateConfig } from "../worker-templates/vless/deploy.mjs";

const input = { accountId: "a".repeat(32), zoneId: "b".repeat(32), hostname: "node.example.test", workerName: "vless-test", thirdParty: false };
function responder(calls, override = () => undefined) {
  return async (method, endpoint, body, query) => {
    calls.push({ method, endpoint, body, query });
    const other = override(method, endpoint, body);
    if (other !== undefined) return other;
    if (endpoint === `zones/${input.zoneId}`) return { result: { name: "example.test", status: "active", account: { id: input.accountId } } };
    return { result: [] };
  };
}

test("VLESS template requires validated domain, identity and explicit third-party choice", () => {
  validateConfig(input);
  for (const patch of [{ hostname: "https://node.example.test" }, { hostname: "a..test" }, { hostname: "a.example.test/" }, { zoneId: "../zone" }, { workerName: "name_bad" }, { thirdParty: "true" }]) assert.throws(() => validateConfig({ ...input, ...patch }));
});

test("VLESS preflight rejects wrong account, inactive zone, unrelated domain and occupied resources before writes", async () => {
  for (const [endpoint, data] of [
    [`zones/${input.zoneId}`, { result: { name: "example.test", status: "active", account: { id: "c".repeat(32) } } }],
    [`zones/${input.zoneId}`, { result: { name: "example.test", status: "pending", account: { id: input.accountId } } }],
    [`accounts/${input.accountId}/workers/scripts`, { result: [{ id: input.workerName }] }],
    [`zones/${input.zoneId}/dns_records`, { result: [{ id: "occupied" }] }],
    [`accounts/${input.accountId}/workers/domains`, { result: [{ hostname: input.hostname }] }],
  ]) {
    const calls = [];
    await assert.rejects(deployVless(input, responder(calls, (_m, path) => path === endpoint ? data : undefined)));
    assert.ok(calls.every(call => call.method === "GET"));
  }
  const calls = [];
  await assert.rejects(deployVless({ ...input, hostname: "node.notexample.test" }, responder(calls)), /子域名/);
  assert.equal(calls.length, 1);
});

test("VLESS injects independent generated secrets, binds chosen hostname and returns protected subscription", async () => {
  const calls = [];
  const result = await deployVless(input, responder(calls));
  const upload = calls.find(call => call.body instanceof FormData);
  const metadata = JSON.parse(await upload.body.get("metadata").text());
  const bindings = Object.fromEntries(metadata.bindings.map(binding => [binding.name, binding]));
  assert.equal(bindings.UUID.type, "secret_text");
  assert.equal(bindings.SUB_TOKEN.type, "secret_text");
  assert.notEqual(bindings.UUID.text.replaceAll("-", ""), bindings.SUB_TOKEN.text);
  assert.equal(bindings.THIRD_PARTY.text, "false");
  const code = await upload.body.get("worker.mjs").text();
  assert.ok(!code.includes(bindings.UUID.text));
  assert.ok(!code.includes(bindings.SUB_TOKEN.text));
  assert.equal(result.subscriptionUrl, `https://${input.hostname}/sub/${bindings.SUB_TOKEN.text}`);
  assert.equal(calls.at(-1).body.hostname, input.hostname);
  assert.equal(calls.at(-1).body.zone_id, input.zoneId);
  assert.equal(calls.filter(call => call.method !== "GET").length, 2);
});

test("VLESS domain binding failure preserves deployment and subscription recovery path", async () => {
  const calls = [];
  const result = await deployVless(input, responder(calls, (method, endpoint) => {
    if (method === "PUT" && endpoint.endsWith("/workers/domains")) throw new Error("untrusted provider detail");
  }));
  assert.equal(result.success, true);
  assert.match(result.warning, /域名绑定未完成/);
  assert.match(result.subscriptionPath, /^\/sub\/[a-f0-9]{32}$/);
  assert.equal(result.subscriptionUrl, undefined);
  assert.ok(!result.warning.includes("untrusted"));
});

test("Worker HTTP handler hides subscription without random path and disables third-party defaults", async () => {
  const source = await readFile(new URL("../worker-templates/vless/worker.mjs", import.meta.url), "utf8");
  const worker = (await import(`data:text/javascript,${encodeURIComponent(source.replace("import { connect } from 'cloudflare:sockets';", "const connect = () => { throw new Error('No network in test'); };"))}`)).default;
  const env = { UUID: randomUUID(), SUB_TOKEN: randomBytes(16).toString("hex"), THIRD_PARTY: "false" };
  for (const pathname of ["/", "/sub/wrong", "/favicon.ico"]) {
    const response = await worker.fetch(new Request(`https://node.example.test${pathname}`), env);
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes(env.UUID));
  }
  const response = await worker.fetch(new Request(`https://node.example.test/sub/${env.SUB_TOKEN}`), env);
  assert.equal(response.status, 200);
  const yaml = await response.text();
  assert.ok(yaml.includes(env.UUID));
  assert.match(yaml, /server: node.example.test/);
  assert.ok(!yaml.includes("bestcf.030101.xyz"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await worker.fetch(new Request("https://node.example.test/"), {})).status, 503);
});

test("Standalone package validates CLI arguments without credentials or network", () => {
  const help = spawnSync(process.execPath, ["worker-templates/vless/deploy.mjs", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法/);
  const bad = spawnSync(process.execPath, ["worker-templates/vless/deploy.mjs", "--bad"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /参数无效/);
});
