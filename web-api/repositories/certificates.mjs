import { database } from "../core/database.mjs";

// Read only public metadata: never select encrypted material or provider errors.
export function listCertificateSummaries(db = database()) {
  const exists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const items = exists("certificates") ? db.prepare(`SELECT id,provider,primary_domain,domains_json,status,issuer,serial_number,not_before,not_after,updated_at FROM certificates ORDER BY updated_at DESC`).all().map((row) => ({
    id: row.id, syncId: "", provider: row.provider, primaryDomain: row.primary_domain,
    domains: JSON.parse(row.domains_json), status: row.status, issuer: row.issuer,
    serialNumber: row.serial_number, notBefore: row.not_before, notAfter: row.not_after, updatedAt: row.updated_at,
  })) : [];
  if (exists("certificate_snapshots")) {
    const excluded = exists("certificate_sync_identity") ? " WHERE sync_id NOT IN (SELECT sync_id FROM certificate_sync_identity)" : "";
    for (const row of db.prepare(`SELECT rowid,metadata_json FROM certificate_snapshots${excluded}`).all()) {
      const item = JSON.parse(row.metadata_json);
      items.push({ id: -row.rowid, syncId: item.syncId, provider: item.provider, primaryDomain: item.primaryDomain,
        domains: item.domains, status: item.status, issuer: item.issuer, serialNumber: item.serialNumber,
        notBefore: item.notBefore, notAfter: item.notAfter, updatedAt: item.updatedAt });
    }
  }
  return items.sort((a,b) => b.updatedAt - a.updatedAt);
}
