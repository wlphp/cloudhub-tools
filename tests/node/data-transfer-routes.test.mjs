import assert from "node:assert/strict";
import { handleDatabaseMigrationRoutes } from "../../web-api/core/database-migration.mjs";
for (const pathname of ["/api/database-import/preview", "/api/database-import/confirm", "/api/database-import/cancel"]) {
  let status;
  const result = await handleDatabaseMigrationRoutes({ method: "POST" }, {}, { pathname }, (_res, code, body) => { status = code; assert.match(body.error, /浏览器预览不支持/); }, () => { throw new Error("unexpected write"); });
  assert.equal(result, true); assert.equal(status, 501);
}
assert.equal(await handleDatabaseMigrationRoutes({ method: "GET" }, {}, { pathname: "/unrelated" }, () => { throw new Error("unexpected response"); }), false);
console.log("Native-only migration route behavior passed");
