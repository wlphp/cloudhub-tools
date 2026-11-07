import assert from "node:assert/strict";
import { handleDatabaseMigrationRoutes } from "../../web-api/core/database-migration.mjs";
for (const pathname of ["/api/database-import/preview", "/api/database-import/confirm", "/api/database-import/cancel"]) {
  let status;
  const response = { setHeader(name, value) { assert.equal(name, "Cache-Control"); assert.equal(value, "no-store"); } };
  const result = await handleDatabaseMigrationRoutes({ method: "POST" }, response, { pathname }, (_res, code, body) => { status = code; assert.match(body.error, /备份预览或恢复失败/); }, () => { throw new Error("unexpected write"); });
  assert.equal(result, true); assert.equal(status, 400);
}
assert.equal(await handleDatabaseMigrationRoutes({ method: "GET" }, {}, { pathname: "/unrelated" }, () => { throw new Error("unexpected response"); }), false);
console.log("Database migration routes keep malformed-request errors safe");
