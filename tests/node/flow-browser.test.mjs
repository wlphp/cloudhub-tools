import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

// Import the repository only after isolating every filesystem dependency.
const directory = mkdtempSync(path.join(tmpdir(), "cloudhub-flow-test-"));
process.env.LOCALAPPDATA = directory;
mkdirSync(path.join(directory, "CloudHubTools"));
writeFileSync(path.join(directory, "CloudHubTools", ".key"), randomBytes(32));
const { createFlowRepository } = await import("../../web-api/repositories/flow.mjs");
const { createFlowService, validateFlowConnection, flowDomain, flowInteger, flowPipelineQuery } = await import("../../web-api/providers/flow.mjs");
const { handleFlowRoutes } = await import("../../web-api/routes/flow.mjs");
const { applyWebCors } = await import("../../web-api/core/security.mjs");
after(() => rmSync(directory, { recursive: true, force: true }));

function fixture(fetcher) {
  const db = new DatabaseSync(":memory:");
  const repo = createFlowRepository(() => db);
  const token = randomBytes(32).toString("hex");
  const connection = repo.save(validateFlowConnection({ name: "验证组织", edition: "central", organizationId: "org-test", token }));
  const calls = [];
  const service = createFlowService(repo, async (url, options) => {
    assert.ok(options.headers["x-yunxiao-token"] === token);
    assert.equal(options.redirect, "error");
    assert.equal(url.origin, "https://openapi-rdc.aliyuncs.com");
    calls.push({ url, method: options.method, body: options.body });
    return fetcher(url, options, token);
  });
  return { db, repo, service, calls, token, connection };
}
const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const args = { connectionId: 1, pipelineId: "pipeline-test", runId: "run-test", jobId: "job-test" };

test("pipeline refresh persists encrypted pages, keeps them on failure, and isolates connection/filter/page", async () => {
  let online = true;
  const f = fixture((_url, _options, token) => online ? json([{ pipelineId: "pipeline-test", pipelineName: `验证流水线 ${token}`, status: "SUCCESS" }]) : new Response("offline", { status: 503 }));
  const query = { ...args, page: 1, perPage: 30, keyword: "验证", groupId: "7" };
  try {
    const key = flowPipelineQuery(query).key;
    const initial = await f.service.pipelines(query);
    const saved = f.repo.pipelineCache(1, key);
    assert.deepEqual(saved.pipelines, initial);
    assert.ok(saved.updatedAt > 0);
    assert.ok(!JSON.stringify(saved).includes(f.token));
    const ciphertext = f.db.prepare("SELECT payload_ciphertext FROM flow_pipeline_cache").get().payload_ciphertext;
    assert.ok(!ciphertext.includes("验证流水线"));
    assert.equal(f.repo.pipelineCache(2, key).updatedAt, null);
    assert.equal(f.repo.pipelineCache(1, flowPipelineQuery({ ...query, page: 2 }).key).updatedAt, null);
    assert.equal(f.repo.pipelineCache(1, flowPipelineQuery({ ...query, groupId: "8" }).key).updatedAt, null);
    online = false;
    await assert.rejects(f.service.pipelines(query));
    assert.deepEqual(f.repo.pipelineCache(1, key), saved);
    f.db.prepare("UPDATE flow_connections SET updated_at=updated_at+1 WHERE id=1").run();
    f.repo.savePipelineCache(1, key, [], f.connection.updatedAt);
    assert.deepEqual(f.repo.pipelineCache(1, key), saved);
    f.repo.save(validateFlowConnection({ ...f.connection, token: "", organizationId: "org-other" }));
    assert.equal(f.repo.pipelineCache(1, key).updatedAt, null);
    f.repo.savePipelineCache(1, key, initial, f.repo.get(1).updatedAt);
    f.repo.remove(1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM flow_pipeline_cache").get().count, 0);
  } finally { f.db.close(); }
});

test("pipeline cache survives closing and reopening the local database", () => {
  const file = path.join(directory, "cache.sqlite3");
  let db = new DatabaseSync(file);
  const repo = createFlowRepository(() => db);
  const token = randomBytes(32).toString("hex");
  const connection = repo.save(validateFlowConnection({ name: "持久化测试", edition: "central", organizationId: "org-test", token }));
  const key = flowPipelineQuery({ connectionId: connection.id }).key;
  repo.savePipelineCache(connection.id, key, [{ pipelineId: "persisted", pipelineName: "已保存流水线" }], connection.updatedAt);
  db.close();
  db = new DatabaseSync(file);
  try { assert.equal(repo.pipelineCache(connection.id, key).pipelines[0].pipelineName, "已保存流水线"); } finally { db.close(); }
});

test("connection CRUD encrypts PAT, preserves it on blank edit, and never returns ciphertext", () => {
  const f = fixture(() => json([]));
  try {
    const ciphertext = f.db.prepare("SELECT token_ciphertext FROM flow_connections").get().token_ciphertext;
    assert.ok(!ciphertext.includes(f.token));
    assert.ok(f.repo.load(1).token === f.token);
    const edited = f.repo.save(validateFlowConnection({ ...f.connection, name: "重命名组织", token: "" }));
    assert.equal(edited.name, "重命名组织");
    assert.ok(edited.updatedAt > f.connection.updatedAt);
    assert.ok(f.repo.load(1).token === f.token);
    for (const value of [f.connection, edited, f.repo.list()]) {
      assert.ok(!JSON.stringify(value).includes(f.token));
      assert.ok(!JSON.stringify(value).includes(ciphertext));
    }
    assert.equal(f.repo.save({ ...validateFlowConnection({ ...f.connection, token: "" }), id: 999 }), null);
    assert.equal(f.repo.remove(1), true);
    assert.equal(f.repo.load(1), null);
  } finally { f.db.close(); }
});

test("invalid hosts, credential headers, organization IDs, and pagination never reach the provider", async () => {
  for (const domain of ["http://openapi-rdc.aliyuncs.com", "https://127.0.0.1", "https://openapi-rdc.aliyuncs.com.evil.test", "https://user:pass@openapi-rdc.aliyuncs.com", "https://openapi-rdc.aliyuncs.com/path", "https://openapi-rdc.aliyuncs.com:8443"]) assert.throws(() => flowDomain(domain));
  for (const value of [true, [], {}, null, "1e2", "0", "-1", "1.5"]) assert.throws(() => flowInteger(value, "ID"));
  const f = fixture(() => { throw new Error("should not fetch"); });
  try {
    await assert.rejects(f.service.runs({ ...args, pipelineId: "../outside" }), /格式无效/);
    await assert.rejects(f.service.pipelines({ ...args, page: 1, perPage: 31 }), /每页条数/);
    await assert.rejects(f.service.pipelines({ ...args, groupId: "bad/id" }), /分组 ID/);
    await assert.rejects(f.service.start({ ...args, paramsJson: "[]" }), /JSON 对象/);
    await assert.rejects(f.service.start({ ...args, paramsJson: "x".repeat(16385) }), /16 KB/);
    assert.equal(f.calls.length, 0);
  } finally { f.db.close(); }
});

test("queries, details, grouped pipelines, steps, paginated logs and explicit start match native contracts", async () => {
  const f = fixture((url, options, token) => {
    if (options.method === "POST") { assert.deepEqual(JSON.parse(options.body), { params: '{"envs":{"target":"test"}}' }); return json({ pipelineRunId: 88 }); }
    if (url.pathname.endsWith("pipelineGroups")) return json([{ id: 7, name: "开发分组" }]);
    if (url.pathname.endsWith("pipelines")) return json([{ pipelineId: 123, pipelineName: "验证流水线", status: "SUCCESS" }]);
    if (url.pathname.endsWith("/runs")) return json([{ pipelineRunId: 42, status: "SUCCESS" }]);
    if (url.pathname.endsWith("/steps")) return json({ data: { buildId: 9, steps: [{ stepIndex: 0, stepName: "构建" }] } });
    if (url.pathname.endsWith("/step/log")) return json({ log: { logs: `完成 ${token} password=hidden`, more: true, last: 50 } });
    if (url.pathname.includes("members:readByUser")) return json({ email: "test@example.com" });
    return json({ pipelineRun: { pipelineRunId: 42, status: "SUCCESS", creatorAccountId: "user-test", stages: [{ stageInfo: { name: "构建阶段", jobs: [{ id: "job-test", endTime: 100 }] } }], sources: [{ type: "git", data: { repo: "repo-test", branch: "main", commint: { shortId: "abcdef", message: "更新" } } }] } });
  });
  try {
    assert.deepEqual(await f.service.groups(args), [{ groupId: "7", groupName: "开发分组" }]);
    assert.equal((await f.service.pipelines({ ...args, groupId: "7", keyword: "验证", page: 2, perPage: 10 }))[0].pipelineId, "123");
    assert.equal(f.calls.at(-1).url.searchParams.get("pipelineName"), "验证");
    assert.equal(f.calls.at(-1).url.searchParams.get("groupId"), "7");
    assert.equal((await f.service.runs(args))[0].pipelineRunId, "42");
    const detail = await f.service.run(args);
    assert.equal(detail.endTime, 100);
    assert.equal(detail.creatorEmail, "test@example.com");
    assert.equal(detail.sources[0].commitId, "abcdef");
    assert.equal((await f.service.latest(args)).pipelineRunId, "42");
    assert.deepEqual(await f.service.steps(args), [{ stepIndex: 0, buildId: 9, name: "构建", status: null }]);
    const logs = await f.service.log({ ...args, stepIndex: 0, buildId: 9, offset: 0, limit: 100 });
    assert.equal(logs.nextOffset, 50);
    assert.equal(logs.more, true);
    assert.ok(!logs.logs.includes(f.token));
    assert.ok(!logs.logs.includes("hidden"));
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
    assert.equal(await f.service.start({ ...args, paramsJson: '{"envs":{"target":"test"}}' }), "88");
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
  } finally { f.db.close(); }
});

test("deployment job logs follow the desktop deployment machine fallback", async () => {
  const f = fixture((url) => {
    if (url.pathname.endsWith("/runs/run-test")) return json({ stages: [{ jobs: [{ id: "job-test", result: JSON.stringify({ deployment: { deployOrderId: "deploy-test" } }) }] }] });
    if (url.pathname.endsWith("/deploy/deploy-test")) return json({ data: { deployOrder: { deployMachineInfo: { deployMachines: [{ machineSn: "machine-test", ip: "192.0.2.1" }] } } } });
    if (url.pathname.endsWith("/machine/machine-test/log")) return json({ data: { deployMachineLog: { deployLog: "部署成功" } } });
    throw new Error("unexpected endpoint");
  });
  try { assert.equal((await f.service.jobLog(args)).logs, "主机 192.0.2.1\n部署成功"); } finally { f.db.close(); }
});

test("HTTP routes preserve CORS, sanitize failures, reject invalid JSON, and have no PAT reveal route", async () => {
  let status = 200;
  const f = fixture((_url, _options, token) => status === 200 ? json([]) : new Response(token, { status }));
  const server = http.createServer(async (req, res) => {
    if (!applyWebCors(req, res).allowed) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, "http://127.0.0.1");
    if (!await handleFlowRoutes(req, res, url, f.repo, f.service)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options = {}) => fetch(base + route, { ...options, headers: { Origin: "http://127.0.0.1:1420", "Content-Type": "application/json", ...options.headers } });
  try {
    const response = await request("/api/flow-connections");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:1420");
    assert.ok(!(await response.text()).includes(f.token));
    for (const body of ["null", "[]", "{"]) assert.equal((await request("/api/flow-test", { method: "POST", body })).status, 400);
    assert.equal((await request("/api/flow-connections", { method: "POST", body: JSON.stringify({ ...f.connection, token: "" }) })).status, 200);
    assert.ok(f.repo.load(1).token === f.token);
    assert.equal((await request("/api/flow-test", { method: "POST", body: '{"id":1}' })).status, 200);
    assert.equal((await request("/api/flow-pipelines?connectionId=1&page=1&perPage=30")).status, 200);
    const cached = await request("/api/flow-pipeline-cache?connectionId=1&page=1&perPage=30");
    assert.equal(cached.status, 200);
    const snapshot = await cached.json();
    assert.deepEqual(snapshot.pipelines, []);
    assert.ok(snapshot.updatedAt > 0);
    for (const value of [401, 403, 429, 500]) {
      status = value;
      const response = await request("/api/flow-test", { method: "POST", body: '{"id":1}' });
      assert.equal(response.status, value === 500 ? 502 : value);
      assert.ok(!(await response.text()).includes(f.token));
    }
    assert.equal((await request("/api/flow-token?id=1")).status, 404);
    assert.equal((await request("/api/flow-connections", { headers: { Origin: "https://untrusted.example" } })).status, 403);
    assert.equal((await request("/api/flow-connections?id=1", { method: "DELETE" })).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); f.db.close(); }
});
