import { database } from "../core/database.mjs";

export function listBalances() {
  const rows = database()
    .prepare("SELECT b.payload_json FROM cloud_account_balances b JOIN cloud_accounts a ON a.id=b.account_id WHERE a.deleted_at IS NULL ORDER BY b.fetched_at DESC")
    .all();
  return rows
    .map((row) => {
      try { return JSON.parse(row.payload_json); } catch { return null; }
    })
    .filter(Boolean);
}

export function saveBalance(accountId, cloudType, payload, fetchedAt) {
  database()
    .prepare("INSERT INTO cloud_account_balances(account_id,cloud_type,payload_json,fetched_at) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET cloud_type=excluded.cloud_type,payload_json=excluded.payload_json,fetched_at=excluded.fetched_at")
    .run(accountId, cloudType, JSON.stringify(payload), fetchedAt);
}

export function deleteBalance(accountId) {
  database().prepare("DELETE FROM cloud_account_balances WHERE account_id=?").run(accountId);
}
