import { readBody, send } from "../core/http.mjs";

export async function handleAccountRoutes(req, res, url, services) {
  const { accounts, saveAccount, database, decryptSecret, encryptSecret, verifyAccount } = services;

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
    const row = database().prepare("SELECT secret_ciphertext FROM cloud_accounts WHERE id=?").get(Number(url.searchParams.get("id")));
    send(res, row ? 200 : 404, row ? decryptSecret(row.secret_ciphertext) : { error: "账号不存在" });
    return true;
  }
    if (req.method === "POST" && url.pathname === "/api/verify-account") {
      try {
        const payload = JSON.parse(await readBody(req));
        const id = Number(payload.account_id);
        if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: "账号 ID 无效" });
        const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
        if (!account) return send(res, 404, { error: "云账号不存在" });
        return send(res, 200, await verifyAccount(id, account.cloud_type));
      } catch (error) { return send(res, 400, { error: error.message || "天翼云账号验证失败" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/export") {
      const selectedIds = new Set(
        url.searchParams
          .getAll("id")
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0),
      );
      return send(res, 200, {
        format: "cloudhub-tools-account-export",
        version: 2,
        encryption: "plaintext",
        secret_exported: true,
        exported_at: new Date().toISOString(),
        accounts: accounts("", true).filter((account) => !selectedIds.size || selectedIds.has(account.id)),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      const payload = JSON.parse(await readBody(req));
      const incoming = Array.isArray(payload) ? payload : payload.accounts;
      if (!Array.isArray(incoming))
        return send(res, 400, { error: "文件格式无效，需要 accounts 数组" });
      if (!incoming.length) return send(res, 400, { error: "导入文件中没有云账号" });
      const invalidIndex = incoming.findIndex((item) => !item?.account_name || !item?.access_key_id || !item?.access_key_secret);
      if (invalidIndex >= 0) return send(res, 400, { error: `第 ${invalidIndex + 1} 条账号缺少完整密钥信息` });
      const db = database();
      const now = Date.now();
      let imported = 0;
      const find = db.prepare(
        "SELECT id FROM cloud_accounts WHERE access_key_id=?",
      );
      const update = db.prepare(
        "UPDATE cloud_accounts SET account_name=?,cloud_type=?,group_name=?,secret_ciphertext=?,credential_meta=?,region_id=?,sort_order=?,enabled=?,remark=?,updated_at=? WHERE id=?",
      );
      const insert = db.prepare(
        "INSERT INTO cloud_accounts(account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const item of incoming) {
        const secret = encryptSecret(item.access_key_secret);
        const existing = find.get(item.access_key_id);
        if (existing)
          update.run(
            item.account_name,
            item.cloud_type || "aliyun",
            item.group_name || null,
            secret,
            ["oracle", "azure", "gcp"].includes(item.cloud_type) ? item.credential_meta || null : null,
            item.region_id || null,
            Math.max(0, Number(item.sort_order) || 0),
            item.enabled === false ? 0 : 1,
            item.remark || null,
            now,
            existing.id,
          );
        else
          insert.run(
            item.account_name,
            item.cloud_type || "aliyun",
            item.group_name || null,
            item.access_key_id,
            secret,
            ["oracle", "azure", "gcp"].includes(item.cloud_type) ? item.credential_meta || null : null,
            item.region_id || null,
            Math.max(0, Number(item.sort_order) || 0),
            item.enabled === false ? 0 : 1,
            item.remark || null,
            now,
            now,
          );
        imported++;
      }
      return send(res, 200, { imported });
    }
  return false;
}
