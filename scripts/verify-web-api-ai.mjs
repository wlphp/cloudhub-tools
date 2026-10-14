import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cloudhub-ai-check-"));
process.env.LOCALAPPDATA = scratch;
const dataDir = path.join(scratch, "CloudHubTools");
fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir, ".key"), crypto.randomBytes(32));
// Start with the previous schema to verify preservation of saved profiles.
const oldDb = new DatabaseSync(path.join(dataDir, "cloudhub_tools.sqlite3"));
oldDb.exec("CREATE TABLE ai_profiles(id TEXT PRIMARY KEY,name TEXT,protocol TEXT,base_url TEXT,model TEXT,key_ciphertext TEXT,enabled INTEGER,is_default INTEGER,timeout_seconds INTEGER,max_output_tokens INTEGER,allow_loopback_http INTEGER,updated_at INTEGER)");
oldDb.close();
const { handleAiRoutes } = await import("../web-api/routes/ai.mjs");
const { closeDatabase } = await import("../web-api/core/database.mjs");
const requests = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  requests.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url.endsWith("/models") ? { data: [{ id: "fixture" }] } : { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ summary: "测试通过", fields: {}, items: [], warnings: [], evidence: [] }) } }] }));
});
const server = http.createServer(async (req, res) => { await handleAiRoutes(req, res, new URL(req.url, "http://localhost")); });
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await listen(upstream); await listen(server);
const base = `http://127.0.0.1:${server.address().port}`;
const service = `http://127.0.0.1:${upstream.address().port}`;
const call = async (route, input) => {
  const res = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return { status: res.status, value: await res.json() };
};
try {
  const id = crypto.randomUUID();
  const profile = { id, name: "测试服务", protocol: "openai_chat", baseUrl: service, model: "fixture", models: ["fixture"], apiKey: "test-only-fixture-key", enabled: true, isDefault: true, timeoutSeconds: 60, maxOutputTokens: 1024, allowLoopbackHttp: true };
  const saved = await call("/api/ai/profiles", profile);
  assert.equal(saved.status, 200);
  assert.equal(JSON.stringify(saved.value).includes(profile.apiKey), false);
  const input = { requestId: crypto.randomUUID(), profileId: id, expectedRevision: saved.value.updatedAt, task: "connection", text: "测试连接" };
  assert.equal((await call("/api/ai/run", input)).status, 200);
  assert.equal((await call("/api/ai/models", { ...input, draft: { protocol: "openai_chat", baseUrl: service + "/draft", timeoutSeconds: 60, allowLoopbackHttp: true, apiKey: "test-only-draft-key" } })).status, 200);
  assert.equal(requests.at(-1).url, "/draft/v1/models");
  assert.equal(requests.at(-1).authorization, "Bearer test-only-draft-key");
  const before = requests.length;
  assert.equal((await call("/api/ai/reveal", { id, expectedRevision: input.expectedRevision + 1 })).status, 400);
  assert.equal((await call("/api/ai/profiles", { ...profile, baseUrl: "http://example.test" })).status, 400);
  assert.equal((await call("/api/ai/profiles", { ...profile, timeoutSeconds: "invalid" })).status, 400);
  assert.equal((await call("/api/ai/profiles", { ...profile, models: Array.from({ length: 20 }, (_, i) => `fixture-${i}`) })).status, 400);
  assert.equal((await call("/api/ai/models", { ...input, draft: { protocol: "openai_chat", baseUrl: "https://other.test", timeoutSeconds: 60, allowLoopbackHttp: false } })).status, 400);
  assert.equal((await call("/api/ai/run", { ...input, text: "password: test-only-fixture-key" })).status, 400);
  assert.equal((await call("/api/ai/run", { ...input, image: {} })).status, 400);
  assert.equal(requests.length, before);
  console.log("Web AI checks passed: legacy schema, profile save, text request, draft model query, limits, revision, credential origin and unsupported images");
} finally {
  server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  closeDatabase();
  if (path.dirname(scratch) !== path.resolve(os.tmpdir())) throw new Error("Unexpected test directory");
  fs.rmSync(scratch, { recursive: true, force: true });
}
