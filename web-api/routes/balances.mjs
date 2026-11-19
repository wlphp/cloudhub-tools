import { readBody, send } from "../core/http.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";
import { listBalances, saveBalance } from "../repositories/balances.mjs";
import { financeForAccount } from "../providers/finance.mjs";
import { supportsBalance } from "../providers/finance-core.mjs";

export async function handleBalanceRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/account-balances") {
    return send(res, 200, listBalances());
  }
  if (req.method === "POST" && url.pathname === "/api/account-balance-refresh") {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "余额刷新请求格式无效" }); }
    const id = Number(payload?.account_id);
    if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: "账号 ID 无效" });
    const row = getAccountSecretRecord(id);
    if (!row) return send(res, 404, { error: "云账号不存在" });
    const result = await financeForAccount(row);
    if (supportsBalance(row.cloud_type)) saveBalance(id, row.cloud_type, result, result.fetched_at);
    return send(res, 200, result);
  }
  return false;
}
