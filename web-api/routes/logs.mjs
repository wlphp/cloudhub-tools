import { send } from "../core/http.mjs";

export function handleLogRoutes(req, res, url, { database }) {
  if (req.method === "GET" && url.pathname === "/api/api-logs") {
    const rows = database()
      .prepare("SELECT l.id,l.account_id,a.account_name,l.endpoint,l.action,l.request_params,l.response_params,l.status,l.message,l.created_at FROM api_logs l LEFT JOIN cloud_accounts a ON a.id=l.account_id ORDER BY l.created_at DESC LIMIT 500")
      .all();
    send(res, 200, rows);
    return true;
  }
  if (req.method === "DELETE" && url.pathname === "/api/api-logs") {
    const result = database().prepare("DELETE FROM api_logs").run();
    send(res, 200, { deleted: Number(result.changes || 0) });
    return true;
  }
  if (req.method === "DELETE" && url.pathname === "/api/operation-logs") {
    const result = database().prepare("DELETE FROM operation_logs").run();
    send(res, 200, { deleted: Number(result.changes || 0) });
    return true;
  }
  return false;
}
