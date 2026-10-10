import { readBody, sendError, send } from "../core/http.mjs";
import { callAuthenticator } from "../services/authenticator.mjs";

const operations = new Set(["status", "unlock", "lock", "list", "touch", "codes", "save", "remove", "advance", "prepare", "import", "cancel", "export"]);
export async function handleAuthenticatorRoute(req, res, url) {
  if (url.pathname !== "/api/authenticator") return false;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { sendError(res, 405, "authenticator-error", "验证器仅支持 POST 请求"); return true; }
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "") || !String(req.headers["content-type"] || "").startsWith("application/json")) {
    sendError(res, 403, "authenticator-error", "验证器仅接受本机 JSON 请求"); return true;
  }
  try {
    const body = JSON.parse(await readBody(req, 48 * 1024 * 1024));
    if (!body || typeof body !== "object" || Object.keys(body).some(key => !["op", "args"].includes(key)) || !operations.has(body.op) || !body.args || typeof body.args !== "object" || Array.isArray(body.args)) {
      sendError(res, 400, "authenticator-error", "验证器请求无效"); return true;
    }
    send(res, 200, await callAuthenticator(body.op, body.args));
  } catch (error) {
    const safe = error.code === "authenticator-error" || error.code === "authenticator-locked" || /^(请先运行 cargo build|本机验证器进程|验证器操作|验证器请求)/.test(error.message || "");
    sendError(res, 400, error.code === "authenticator-locked" ? error.code : "authenticator-error", safe ? error.message : "验证器请求格式无效或执行失败");
  }
  return true;
}
