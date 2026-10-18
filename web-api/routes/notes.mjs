import { readBody, sendError, send, sendUnsupportedInPreview } from "../core/http.mjs";
import { database } from "../core/database.mjs";
import {
  snapshot, save, remove, restore, purge, saveGroupName, deleteGroup,
  completeReminder, dismiss, snoozeReminder,
} from "../repositories/notes.mjs";

const operations = new Set(["snapshot", "save", "delete", "restore", "purge", "group_save", "group_delete", "reminder_complete", "reminder_snooze", "reminder_dismiss"]);

function isClientError(error) {
  return Boolean(error && (error.code === "notes" || error.statusCode === 413));
}

function errorMessage(error) {
  if (error && error.code === "notes") return error.message;
  if (error && error.statusCode === 413) return "备忘录请求过大";
  return "备忘录请求格式无效或执行失败";
}

/** Opens the 备忘录 section in the main window; the preview has no windows. */
export function handleNotesOpenRoute(req, res, url) {
  if (url.pathname !== "/api/notes-open" || req.method !== "POST") return false;
  res.setHeader("Cache-Control", "no-store");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "")) {
    sendError(res, 403, "unsupported-in-preview", "备忘录仅接受本机请求"); return true;
  }
  sendUnsupportedInPreview(res, "备忘录窗口", "浏览器预览请直接点击左侧「备忘录」入口");
  return true;
}

export async function handleNotesRoute(req, res, url) {
  if (url.pathname !== "/api/notes") return false;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { sendError(res, 405, "notes", "备忘录仅支持 POST 请求"); return true; }
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "") || !String(req.headers["content-type"] || "").startsWith("application/json")) {
    sendError(res, 403, "notes", "备忘录仅接受本机 JSON 请求"); return true;
  }
  try {
    const body = JSON.parse(await readBody(req, 16 * 1024 * 1024));
    if (!body || typeof body !== "object" || Object.keys(body).some((key) => !["op", "args"].includes(key)) || !operations.has(body.op) || !body.args || typeof body.args !== "object" || Array.isArray(body.args)) {
      sendError(res, 400, "notes", "备忘录请求无效"); return true;
    }
    const db = database();
    const now = Date.now();
    const args = body.args;
    let result;
    switch (body.op) {
      case "snapshot": result = snapshot(db, now); break;
      case "save": result = save(db, args.input, now); break;
      case "delete": result = remove(db, args.ids, now); break;
      case "restore": result = restore(db, args.ids, now); break;
      case "purge": result = purge(db, args.ids); break;
      case "group_save": result = saveGroupName(db, args.name, now); break;
      case "group_delete": result = deleteGroup(db, args.name, args.target, now); break;
      case "reminder_complete": completeReminder(db, args.id, now); result = null; break;
      case "reminder_snooze": result = snoozeReminder(db, args.id, args.minutes, now); break;
      case "reminder_dismiss": result = dismiss(db, args.id, now); break;
      default: sendError(res, 400, "notes", "备忘录请求无效"); return true;
    }
    send(res, 200, result ?? null);
  } catch (error) {
    sendError(res, isClientError(error) ? 400 : 500, "notes", errorMessage(error));
  }
  return true;
}
