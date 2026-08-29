import { readBody, send } from "../core/http.mjs";

export async function handleAssetRoutes(req, res, url, services) {
  const { database, localAssets, syncCloudAssets } = services;

  if (req.method === "GET" && url.pathname === "/api/local-assets") {
    const accountId = url.searchParams.has("account_id")
      ? Number(url.searchParams.get("account_id"))
      : null;
    send(res, 200, localAssets(accountId, url.searchParams.get("resource_type") || null));
    return true;
  }
  if (req.method === "DELETE" && url.pathname === "/api/local-assets") {
    const accountId = Number(url.searchParams.get("account_id"));
    const resourceType = String(url.searchParams.get("resource_type") || "").trim();
    const assetKey = String(url.searchParams.get("asset_key") || "").trim();
    if (!Number.isInteger(accountId) || accountId <= 0 || !resourceType || !assetKey) {
      send(res, 400, { error: "缺少本地资产标识" });
      return true;
    }
    const result = database()
      .prepare("DELETE FROM cloud_assets WHERE account_id=? AND resource_type=? AND asset_key=?")
      .run(accountId, resourceType, assetKey);
    send(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: "本地资产记录不存在" });
    return true;
  }
    if (req.method === "POST" && url.pathname === "/api/sync-assets") {
      const payload = JSON.parse(await readBody(req));
      return send(res, 200, await syncCloudAssets(Number(payload.account_id), Array.isArray(payload.resource_types) ? payload.resource_types : []));
    }
  return false;
}
