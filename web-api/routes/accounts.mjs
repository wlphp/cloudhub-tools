import { readBody, send, sendUnsupportedInPreview } from "../core/http.mjs";

export async function handleAccountRoutes(req, res, url, services) {
  const { accounts, saveAccount, database } = services;

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    send(res, 200, accounts(url.searchParams.get("keyword") || "", false));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/accounts") {
    try {
      send(res, 200, saveAccount(JSON.parse(await readBody(req))));
    } catch (error) {
      const status = Number(error?.statusCode);
      send(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 400, { error: error.message || "保存账号失败" });
    }
    return true;
  }
  if (req.method === "DELETE" && url.pathname === "/api/accounts") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      send(res, 400, { error: "账号 ID 无效" });
      return true;
    }
    const result = database().prepare("DELETE FROM cloud_accounts WHERE id=?").run(id);
    send(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: "云账号不存在" });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/account-secret") {
    sendUnsupportedInPreview(res, "读取账号 Secret");
    return true;
  }
  return false;
}
