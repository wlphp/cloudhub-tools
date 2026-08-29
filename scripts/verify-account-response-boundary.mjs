import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [routesSource, serviceSource] = await Promise.all([
  readFile(new URL("../web-api/routes/accounts.mjs", import.meta.url), "utf8"),
  readFile(new URL("../web-api/services/accounts.mjs", import.meta.url), "utf8"),
]);

const regularListRoute = routesSource.match(
  /if \(req\.method === "GET" && url\.pathname === "\/api\/accounts"\) \{([\s\S]*?)\n  \}/,
);
assert.ok(regularListRoute, "缺少常规账号列表路由");
assert.match(regularListRoute[1], /accounts\(url\.searchParams\.get\("keyword"\) \|\| "", false\)/, "常规账号列表必须显式关闭密钥导出");

const listFunction = serviceSource.match(/function list\(keyword = "", includeSecret = false\) \{([\s\S]*?)\n  \}\n\n  function save/);
assert.ok(listFunction, "缺少账号列表服务");
assert.doesNotMatch(listFunction[1], /const account = \{[^}]*secret_ciphertext/s, "常规账号 DTO 不得包含密文");
assert.match(listFunction[1], /if \(includeSecret\) account\.access_key_secret = decryptSecret\(row\.secret_ciphertext\)/, "密钥只能在显式导出分支解密");

console.log("账号常规列表响应未包含密文或明文密钥；显式导出分支仍受 includeSecret 控制。");
