import { send } from "../core/http.mjs";
import { listCertificateSummaries } from "../repositories/certificates.mjs";

export function handleLocalRoutes(req, res, url, services) {
  if (url.pathname === "/api/certificate-summaries") {
    if (req.method !== "GET") return send(res, 405, { error: "证书信息仅支持读取" });
    if ([...url.searchParams].length) return send(res, 400, { error: "证书读取参数无效" });
    return send(res, 200, (services.listCertificateSummaries ?? listCertificateSummaries)());
  }
  const { listAssets, deleteAsset, listApiLogs, clearApiLogs, clearOperationLogs, listManagedHosts, listPanelConnections } = services;
  if (req.method === "GET" && url.pathname === "/api/managed-hosts") {
    return send(res, 200, listManagedHosts());
  }
  if (req.method === "GET" && url.pathname === "/api/panel-connections") {
    return send(res, 200, listPanelConnections());
  }
  if (req.method === "GET" && url.pathname === "/api/local-assets") {
    return send(res, 200, listAssets(url.searchParams.has("account_id") ? Number(url.searchParams.get("account_id")) : null, url.searchParams.get("resource_type") || null));
  }
  if (req.method === "DELETE" && url.pathname === "/api/local-assets") {
    const accountId = Number(url.searchParams.get("account_id"));
    const resourceType = String(url.searchParams.get("resource_type") || "").trim();
    const assetKey = String(url.searchParams.get("asset_key") || "").trim();
    if (!Number.isInteger(accountId) || accountId <= 0 || !resourceType || !assetKey) return send(res, 400, { error: "缺少本地资产标识" });
    const result = deleteAsset(accountId, resourceType, assetKey);
    if (!result.changes) return send(res, 404, { error: "本地资产记录不存在" });
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/api-logs") return send(res, 200, listApiLogs({ keyword: url.searchParams.get("keyword"), status: url.searchParams.get("status"), limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") }));
  if (req.method === "DELETE" && url.pathname === "/api/api-logs") return send(res, 200, { deleted: Number(clearApiLogs().changes || 0) });
  if (req.method === "DELETE" && url.pathname === "/api/operation-logs") return send(res, 200, { deleted: Number(clearOperationLogs().changes || 0) });
  return false;
}
