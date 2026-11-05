import { randomBytes } from "node:crypto";
import { readBody, send, sendError } from "../core/http.mjs";

const MEMBER_API = "https://yun.wlphp.com/php/api.php";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SESSIONS = 1_000;
const sessions = new Map();
const OP_ALIASES = new Map([
  ["member_me", "me"],
  ["member.me", "me"],
  ["member_send_code", "send_code"],
  ["auth.send_code", "send_code"],
  ["member_login", "login"],
  ["auth.login", "login"],
  ["member_avatar", "avatar"],
  ["member.avatar", "avatar"],
  ["member_nickname", "nickname"],
  ["member.nickname", "nickname"],
  ["member_bio", "bio"],
  ["member.bio", "bio"],
  ["member_login_logs", "login_logs"],
  ["member.login_logs", "login_logs"],
  ["member_messages", "messages"],
  ["member.messages", "messages"],
  ["member_message", "message"],
  ["member.message", "message"],
  ["member_messages_read_all", "messages_read_all"],
  ["member.messages_read_all", "messages_read_all"],
  ["member_logout", "logout"],
  ["auth.logout", "logout"],
]);

function respond(res, status, value) {
  send(res, status, value);
  return true;
}

function validEmail(value) {
  if (typeof value !== "string" || value.length > 254 || !/^[\x21-\x7e]+$/.test(value)) return false;
  const parts = value.split("@");
  return parts.length === 2 && Boolean(parts[0]) && parts[1].includes(".");
}

function bearerTokenIssue(value) {
  if (typeof value !== "string") return "token-not-string";
  if (value.length < 16 || value.length > 4_096) return "token-length-invalid";
  if (!/^[\x21-\x7e]+$/.test(value)) return "token-contains-unsafe-characters";
  return null;
}

function sessionCookieHeader(headers) {
  const cookieLines = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie") || "").split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
  const pairs = [];
  for (const line of cookieLines) {
    const pair = line.split(";", 1)[0].trim();
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (separator <= 0 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) continue;
    if (pair.length > 2_048 || pairs.length >= 16) return "";
    pairs.push(pair);
  }
  const value = pairs.join("; ");
  return value.length <= 4_096 ? value : "";
}

function safeMember(data) {
  const value = data?.member;
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.id) || value.id <= 0
    || !validEmail(value.email) || typeof value.nickname !== "string" || [...value.nickname].length > 20 || /[\u0000-\u001f\u007f]/.test(value.nickname)
    || (value.bio !== undefined && (typeof value.bio !== "string" || [...value.bio].length > 100 || /[\p{Cc}\p{Cs}]/u.test(value.bio.replaceAll("\n", ""))))
    || !Number.isInteger(value.avatar_key) || value.avatar_key < 1 || value.avatar_key > 12
    || typeof value.is_vip !== "boolean" || typeof value.is_admin !== "boolean"
    || (value.is_experience_officer !== undefined && typeof value.is_experience_officer !== "boolean")
    || value.is_admin !== (value.id === 1) || value.status !== "active"
    || typeof value.created_at !== "string" || value.created_at.length > 32 || /[\u0000-\u001f\u007f]/.test(value.created_at)
    || !(value.last_login_at === null || (typeof value.last_login_at === "string" && value.last_login_at.length <= 32 && !/[\u0000-\u001f\u007f]/.test(value.last_login_at)))) {
    throw new Error("会员资料格式无效");
  }
  return {
    id: value.id,
    email: value.email,
    nickname: value.nickname.trim() || "匿名用户",
    bio: typeof value.bio === "string" ? value.bio : "",
    avatar_key: value.avatar_key,
    is_vip: value.is_vip,
    is_experience_officer: value.is_experience_officer === true,
    is_admin: value.is_admin,
    status: value.status,
    created_at: value.created_at,
    last_login_at: value.last_login_at,
  };
}

function safeLoginRecords(data) {
  if (!Array.isArray(data?.items) || data.items.length > 20) throw new Error("登录记录格式无效");
  return data.items.map((record) => {
    if (!record || !["login", "register", "logout", "send_code"].includes(record.event)
      || !["success", "failed"].includes(record.result) || typeof record.ip !== "string" || record.ip.length > 45
      || !["native", "web"].includes(record.client_type) || typeof record.created_at !== "string" || record.created_at.length > 32
      || /[\u0000-\u001f\u007f]/.test(record.ip) || /[\u0000-\u001f\u007f]/.test(record.created_at)) {
      throw new Error("登录记录格式无效");
    }
    return { event: record.event, result: record.result, ip: record.ip, client_type: record.client_type, created_at: record.created_at };
  });
}

function apiError(status, action) {
  if (status === 401) return "登录已失效，请重新登录";
  if (status === 422 && action === "member.nickname") return "昵称需为1到20个字符，且不能包含控制字符";
  if (status === 422 && action === "member.bio") return "个人简介最多100个字符，且不能包含控制字符";
  if (status === 422) return "邮箱或验证码无效、过期，请检查后重新获取";
  if (status === 429) return "操作太频繁，请稍后再试";
  if (status === 403) return "该会员不可用，请联系管理员";
  if (status === 404) return "会员服务接口版本不匹配，请更新客户端";
  if (status >= 500) return "会员服务发生内部错误，请稍后重试";
  return "会员服务请求失败，请稍后重试";
}

async function requestMember(action, { payload, token, cookie, csrf, captureSession = false } = {}) {
  const method = payload && !["member.login_logs", "member.messages"].includes(action) ? "POST" : "GET";
  let response;
  try {
    response = await fetch(`${MEMBER_API}?action=${encodeURIComponent(action)}${["member.login_logs", "member.messages"].includes(action) ? `&page=${encodeURIComponent(String(payload.page))}` : ""}`, {
      method,
      headers: {
        "X-CloudHub-Client": "web",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...(payload && !["member.login_logs", "member.messages"].includes(action) ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload && !["member.login_logs", "member.messages"].includes(action) ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(35_000),
      redirect: "error",
    });
  } catch {
    throw Object.assign(new Error("会员服务连接失败，请检查网络后重试"), { diagnostic: "upstream-network-error", action });
  }
  if (response.status === 401) throw Object.assign(new Error(apiError(401, action)), { status: 401 });
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error("会员服务响应无效");
  let text;
  try { text = await response.text(); } catch { throw new Error("会员服务响应读取失败"); }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("会员服务响应无效");
  let result;
  try { result = JSON.parse(text); } catch { throw Object.assign(new Error("会员服务尚未就绪，请稍后重试"), { diagnostic: "upstream-invalid-response", action, upstreamStatus: response.status }); }
  if (!response.ok || result?.ok !== true || !result.data || typeof result.data !== "object") {
    throw Object.assign(new Error(apiError(response.status, action)), {
      diagnostic: response.ok ? "upstream-api-error" : "upstream-http-status",
      action,
      upstreamStatus: response.status,
    });
  }
  return captureSession ? { data: result.data, cookie: sessionCookieHeader(response.headers) } : result.data;
}

function readSession(sessionId) {
  const now = Date.now();
  for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  if (typeof sessionId !== "string" || !/^[a-f0-9]{64}$/.test(sessionId)) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= now) return null;
  session.expiresAt = now + 12 * 60 * 60 * 1000;
  return session;
}

export async function handleMemberRoute(req, res, url) {
  if (url.pathname !== "/api/member") return false;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { sendError(res, 405, "member", "会员接口仅支持 POST 请求"); return true; }
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "") || !String(req.headers["content-type"] || "").startsWith("application/json")) {
    sendError(res, 403, "member", "会员接口仅接受本机 JSON 请求"); return true;
  }
  try {
    const input = JSON.parse(await readBody(req, 8 * 1024));
    const allowedFields = new Set(["op", "session_id", "email", "code", "avatar_key", "nickname", "bio", "page", "id"]);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowedFields.has(key))) {
      sendError(res, 400, "member", "会员请求无效"); return true;
    }
    const rawOp = input.op;
    const op = typeof rawOp === "string" ? (OP_ALIASES.get(rawOp) || rawOp) : rawOp;
    const { session_id: sessionId } = input;
    let data;
    if (op === "send_code") {
      const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      if (!validEmail(email)) { sendError(res, 400, "member", "请输入有效邮箱"); return true; }
      data = await requestMember("auth.send_code", { payload: { email } });
      const wait = Number(data.retry_after);
      return respond(res, 200, Number.isFinite(wait) ? Math.max(1, Math.min(300, Math.trunc(wait))) : 60);
    }
    if (op === "login") {
      const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      const code = input.code;
      if (!validEmail(email) || typeof code !== "string" || !/^\d{6}$/.test(code)) { sendError(res, 400, "member", "请填写有效邮箱和6位验证码"); return true; }
      for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key);
      if (sessions.size >= MAX_SESSIONS) throw new Error("浏览器预览登录人数过多，请稍后重试");
      const loginResult = await requestMember("auth.login", { payload: { email, code, device_label: "CloudHub 浏览器预览" }, captureSession: true });
      data = loginResult.data;
      const member = safeMember(data);
      const token = data.token;
      const tokenIssue = bearerTokenIssue(token);
      const cookie = loginResult.cookie;
      if (tokenIssue && !cookie) throw Object.assign(new Error("登录响应无效"), { diagnostic: tokenIssue });
      const id = randomBytes(32).toString("hex");
      sessions.set(id, { token: tokenIssue ? null : token, cookie, csrf: typeof data.csrf === "string" ? data.csrf : "", expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
      return respond(res, 200, { member, session_id: id });
    }
    const session = readSession(sessionId);
    if (!session) {
      if (op === "me") return respond(res, 200, null);
      sendError(res, 401, "member", "登录已失效，请重新登录"); return true;
    }
    if (op === "me") {
      try { data = await requestMember("member.me", { token: session.token, cookie: session.cookie }); }
      catch (error) {
        if (error?.status !== 401) throw error;
        sessions.delete(sessionId);
        return respond(res, 200, null);
      }
      return respond(res, 200, safeMember(data));
    }
    if (op === "avatar") {
      if (!Number.isInteger(input.avatar_key) || input.avatar_key < 1 || input.avatar_key > 12) { sendError(res, 400, "member", "请选择有效头像"); return true; }
      data = await requestMember("member.avatar", { payload: { avatar_key: input.avatar_key }, token: session.token, cookie: session.cookie, csrf: session.csrf });
      return respond(res, 200, safeMember(data));
    }
    if (op === "nickname") {
      const nickname = typeof input.nickname === "string" ? input.nickname.trim() : "";
      if (!nickname || [...nickname].length > 20 || /[\u0000-\u001f\u007f]/.test(nickname)) { sendError(res, 400, "member", "昵称需为1到20个字符，且不能包含控制字符"); return true; }
      data = await requestMember("member.nickname", { payload: { nickname }, token: session.token, cookie: session.cookie, csrf: session.csrf });
      return respond(res, 200, safeMember(data));
    }
    if (op === "bio") {
      const bio = typeof input.bio === "string" ? input.bio.trim() : "";
      if ([...bio].length > 100 || /[\p{Cc}\p{Cs}]/u.test(bio.replaceAll("\n", ""))) { sendError(res, 400, "member", "个人简介最多100个字符，且不能包含控制字符"); return true; }
      data = await requestMember("member.bio", { payload: { bio }, token: session.token, cookie: session.cookie, csrf: session.csrf });
      return respond(res, 200, safeMember(data));
    }
    if (op === "login_logs") {
      if (!Number.isInteger(input.page) || input.page < 1 || input.page > 100_000) { sendError(res, 400, "member", "登录记录页码无效"); return true; }
      data = await requestMember("member.login_logs", { payload: { page: input.page }, token: session.token, cookie: session.cookie });
      return respond(res, 200, safeLoginRecords(data));
    }
    if (op === "messages") {
      if (!Number.isInteger(input.page) || input.page < 1 || input.page > 100_000) { sendError(res, 400, "member", "消息页码无效"); return true; }
      data = await requestMember("member.messages", { payload: { page: input.page }, token: session.token, cookie: session.cookie });
      return respond(res, 200, data);
    }
    if (op === "message") {
      if (!Number.isSafeInteger(input.id) || input.id < 1) { sendError(res, 400, "member", "消息编号无效"); return true; }
      data = await requestMember("member.message", { payload: { id: input.id }, token: session.token, cookie: session.cookie, csrf: session.csrf });
      return respond(res, 200, data);
    }
    if (op === "messages_read_all") {
      data = await requestMember("member.messages_read_all", { payload: {}, token: session.token, cookie: session.cookie, csrf: session.csrf });
      return respond(res, 200, Number.isInteger(data.updated) ? data.updated : 0);
    }
    if (op === "logout") {
      sessions.delete(sessionId);
      try { await requestMember("auth.logout", { payload: {}, token: session.token, cookie: session.cookie, csrf: session.csrf }); return respond(res, 200, true); }
      catch { return respond(res, 200, false); }
    }
    sendError(res, 400, "member", "会员操作无效");
  } catch (error) {
    if (error?.status === 401 && typeof sessionId === "string") sessions.delete(sessionId);
    const status = error?.status === 401 ? 401 : error?.status === 400 ? 400 : 502;
    const safeMessage = error instanceof Error && [
      "会员资料格式无效", "登录记录格式无效", "登录响应无效", "会员服务连接失败，请检查网络后重试",
      "会员服务响应无效", "会员服务响应读取失败", "会员服务尚未就绪，请稍后重试", "登录已失效，请重新登录",
      "昵称需为1到20个字符，且不能包含控制字符",
      "个人简介最多100个字符，且不能包含控制字符",
      "邮箱或验证码无效、过期，请检查后重新获取", "操作太频繁，请稍后再试", "该会员不可用，请联系管理员",
      "会员服务接口版本不匹配，请更新客户端", "会员服务发生内部错误，请稍后重试", "会员服务请求失败，请稍后重试",
      "浏览器预览登录人数过多，请稍后重试",
    ].includes(error.message) ? error.message : "会员服务请求失败，请稍后重试";
    sendError(res, status, "member", safeMessage, error?.diagnostic ? {
      diagnostic: error.diagnostic,
      ...(typeof error.action === "string" ? { action: error.action } : {}),
      ...(Number.isInteger(error.upstreamStatus) ? { upstream_status: error.upstreamStatus } : {}),
    } : undefined);
  }
  return true;
}
