// 浏览器预览降级：Claude Code 供应商只读写用户主目录下的 settings.json，
// 与其他原生专属能力一致，预览层不支持而不是伪造结果。
import { readBody, sendError, send, sendUnsupportedInPreview } from "../core/http.mjs";

const operations = new Set(["list", "current_settings"]);

export async function handleClaudeProvidersRoute(req, res, url) {
  if (url.pathname !== "/api/claude-providers") return false;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { sendError(res, 405, "claude-providers", "供应商接口仅支持 POST 请求"); return true; }
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "") || !String(req.headers["content-type"] || "").startsWith("application/json")) {
    sendError(res, 403, "claude-providers", "供应商接口仅接受本机 JSON 请求"); return true;
  }
  try {
    const body = JSON.parse(await readBody(req, 1024 * 1024));
    if (!body || typeof body !== "object" || !operations.has(body.op)) { sendError(res, 400, "claude-providers", "供应商请求无效"); return true; }
    // list 也拒绝：预览库没有供应商表，返回空列表会让界面看起来「已连接」但其实不能切换。
    sendUnsupportedInPreview(res, "Claude Code 供应商管理", "浏览器预览不支持读写 Claude Code 配置，请在桌面客户端中打开软件商店");
    return true;
  } catch {
    sendError(res, 500, "claude-providers", "供应商请求格式无效或执行失败");
  }
  return true;
}
