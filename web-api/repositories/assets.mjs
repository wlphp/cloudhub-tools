import { database } from "../core/database.mjs";

export function listAssets(accountId, resourceType) {
  const rows = database().prepare("SELECT account_id,resource_type,asset_key,region_id,payload_json,fetched_at FROM cloud_assets WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR resource_type=?) ORDER BY resource_type,asset_key")
    .all(accountId ?? null, accountId ?? null, resourceType ?? null, resourceType ?? null);
  return rows.map((row) => ({ account_id: row.account_id, resource_type: row.resource_type, asset_key: row.asset_key, region_id: row.region_id, payload: JSON.parse(row.payload_json), fetched_at: row.fetched_at }));
}

export function deleteAsset(accountId, resourceType, assetKey) {
  return database().prepare("DELETE FROM cloud_assets WHERE account_id=? AND resource_type=? AND asset_key=?").run(accountId, resourceType, assetKey);
}

export function updateServerName(accountId, instanceId, instanceName) {
  const db = database();
  const row = db.prepare("SELECT payload_json FROM cloud_assets WHERE account_id=? AND resource_type='ecs' AND asset_key=?").get(accountId, instanceId);
  if (!row) return;
  const payload = JSON.parse(row.payload_json);
  payload.InstanceName = instanceName;
  db.prepare("UPDATE cloud_assets SET payload_json=? WHERE account_id=? AND resource_type='ecs' AND asset_key=?").run(JSON.stringify(payload), accountId, instanceId);
}
