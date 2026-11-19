import { readBody, send, sendUnsupportedInPreview } from "../core/http.mjs";
import { getAccountForUpdate } from "../repositories/accounts.mjs";
import { deleteBalance } from "../repositories/balances.mjs";

export async function handleAccountRoutes(req, res, url, services) {
  const { accounts, saveAccount, deleteAccount } = services;

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    send(res, 200, accounts(url.searchParams.get("keyword") || "", false));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/accounts") {
    try {
      const input = JSON.parse(await readBody(req));
      const inputId = Number(input?.id);
      const before = Number.isInteger(inputId) && inputId > 0 ? getAccountForUpdate(inputId) : null;
      const saved = saveAccount(input);
      if (saved && (!before || before.cloud_type !== saved.cloud_type || before.access_key_id !== saved.access_key_id || String(input.access_key_secret || "").trim())) {
        deleteBalance(saved.id);
      }
      send(res, 200, saved);
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
    const result = deleteAccount(id);
    if (result) deleteBalance(id);
    send(res, result ? 200 : 404, result || { error: "云账号不存在" });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/account-secret") {
    sendUnsupportedInPreview(res, "读取账号 Secret");
    return true;
  }
  return false;
}
