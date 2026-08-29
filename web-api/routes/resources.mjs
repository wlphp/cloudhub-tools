import { send } from "../core/http.mjs";

export async function handleResourceRoutes(req, res, url, services) {
  const { database, cloudResources, esaOverview } = services;
  if (req.method === "GET" && url.pathname === "/api/cloud-resources") {
    const type = url.searchParams.get("type") || "domain";
    const id = Number(url.searchParams.get("id"));
    const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
    if (!account) {
      send(res, 404, { error: "云账号不存在" });
      return true;
    }
    send(res, 200, await cloudResources(id, type));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/esa-overview") {
    send(res, 200, await esaOverview(
      Number(url.searchParams.get("id")),
      url.searchParams.get("range") || "today",
      url.searchParams.get("site_id") || "",
    ));
    return true;
  }
  return false;
}
