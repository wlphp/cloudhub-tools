import { database } from "../core/database.mjs";

export function getAccountSecretRecord(id) {
  return database().prepare(`
    SELECT id,account_name,cloud_type,access_key_id,secret_ciphertext,credential_meta,region_id,enabled
    FROM cloud_accounts WHERE id=?
  `).get(id) || null;
}

export function getAccountType(id) {
  return database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id) || null;
}

export function getAccountRegion(id) {
  return database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(id) || null;
}

export function getAccountTypeAndRegion(id) {
  return database().prepare("SELECT cloud_type,region_id FROM cloud_accounts WHERE id=?").get(id) || null;
}

export function getAccountForUpdate(id) {
  return database().prepare("SELECT secret_ciphertext,credential_meta FROM cloud_accounts WHERE id=?").get(id) || null;
}

export function saveAccountRecord({ id, values, now }) {
  const db = database();
  let accountId = id;
  if (accountId) {
    db.prepare("UPDATE cloud_accounts SET account_name=?,cloud_type=?,group_name=?,access_key_id=?,secret_ciphertext=?,credential_meta=?,region_id=?,sort_order=?,enabled=?,remark=?,updated_at=? WHERE id=?").run(...values, accountId);
  } else {
    db.prepare("INSERT INTO cloud_accounts(account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(...values, now);
    accountId = Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
  }
  const row = db.prepare("SELECT id,account_name,cloud_type,group_name,access_key_id,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE id=?").get(accountId);
  return row ? { ...row, enabled: Boolean(row.enabled) } : null;
}

export function importAccountRecords(records, now = Date.now()) {
  const db = database();
  const importMany = db.transaction((items) => {
    const find = db.prepare("SELECT id FROM cloud_accounts WHERE access_key_id=?");
    const update = db.prepare("UPDATE cloud_accounts SET account_name=?,cloud_type=?,group_name=?,secret_ciphertext=?,credential_meta=?,region_id=?,sort_order=?,enabled=?,remark=?,updated_at=? WHERE id=?");
    const insert = db.prepare("INSERT INTO cloud_accounts(account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const item of items) {
      const existing = find.get(item.access_key_id);
      const values = [item.account_name, item.cloud_type, item.group_name, item.secret, item.credential_meta, item.region_id, item.sort_order, item.enabled, item.remark, now];
      if (existing) update.run(...values, existing.id);
      else insert.run(item.account_name, item.cloud_type, item.group_name, item.access_key_id, item.secret, item.credential_meta, item.region_id, item.sort_order, item.enabled, item.remark, now, now);
    }
    return items.length;
  });
  return importMany(records);
}

export function listAccounts(keyword = "") {
  const value = String(keyword || "").trim();
  const rows = database().prepare(`
    SELECT id,account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at
    FROM cloud_accounts WHERE ? = '' OR account_name LIKE ? OR access_key_id LIKE ? OR COALESCE(group_name,'') LIKE ? ORDER BY sort_order ASC, updated_at DESC
  `).all(value, `%${value}%`, `%${value}%`, `%${value}%`);
  return rows.map((row) => ({
    id: row.id,
    account_name: row.account_name,
    cloud_type: row.cloud_type,
    group_name: row.group_name,
    access_key_id: row.access_key_id,
    credential_meta: row.credential_meta,
    region_id: row.region_id,
    sort_order: row.sort_order ?? 0,
    enabled: Boolean(row.enabled),
    remark: row.remark,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function deleteAccount(id) {
  const result = database().prepare("DELETE FROM cloud_accounts WHERE id=?").run(id);
  return result.changes ? { ok: true } : null;
}
