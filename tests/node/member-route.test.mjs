import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleMemberRoute } from "../../web-api/routes/member.mjs";

const member = {
  id: 42,
  email: "member@example.test",
  nickname: "浏览器用户",
  bio: "",
  avatar_key: 1,
  is_vip: false,
  is_experience_officer: false,
  is_admin: false,
  status: "active",
  created_at: "2026-11-05 00:00:00",
  last_login_at: null,
};

async function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  req.headers = { host: "127.0.0.1:1430", "content-type": "application/json" };
  let result;
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    _header: null,
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(payload) { result = { status: this.status, body: JSON.parse(payload) }; },
  };
  assert.equal(await handleMemberRoute(req, res, new URL("http://127.0.0.1:1430/api/member")), true);
  return result;
}

test("browser member login accepts an opaque bearer token without returning it to the browser", async (t) => {
  const originalFetch = globalThis.fetch;
  const opaqueToken = "opaque:eyJhbGci-OiJIUzI1NiJ9.browser_session.signature==";
  globalThis.fetch = async (url, options) => {
    const action = new URL(url).searchParams.get("action");
    if (action === "auth.login") return new Response(JSON.stringify({ ok: true, data: { member, token: opaqueToken } }));
    assert.equal(action, "member.me");
    assert.equal(options.headers.Authorization, `Bearer ${opaqueToken}`);
    return new Response(JSON.stringify({ ok: true, data: { member } }));
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const login = await request({ op: "login", email: member.email, code: "123456" });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body.member, member);
  assert.match(login.body.session_id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(login).includes(opaqueToken), false);

  const profile = await request({ op: "me", session_id: login.body.session_id });
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.body, member);
});

test("browser member login keeps an upstream cookie session server-side when no bearer token is returned", async (t) => {
  const originalFetch = globalThis.fetch;
  const privateCookie = "member_session=fixture-secret-session";
  globalThis.fetch = async (url, options) => {
    const action = new URL(url).searchParams.get("action");
    if (action === "auth.login") {
      return new Response(JSON.stringify({ ok: true, data: { member } }), {
        headers: { "Content-Type": "application/json", "Set-Cookie": `${privateCookie}; HttpOnly; Secure; SameSite=Lax` },
      });
    }
    assert.equal(action, "member.me");
    assert.equal(options.headers.Cookie, privateCookie);
    assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify({ ok: true, data: { member } }));
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const login = await request({ op: "login", email: member.email, code: "123456" });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body.member, member);
  assert.match(login.body.session_id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(login).includes(privateCookie), false);

  const profile = await request({ op: "me", session_id: login.body.session_id });
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.body, member);
});

test("browser member proxy forwards a validated biography update to the server", async (t) => {
  const originalFetch = globalThis.fetch;
  let savedPayload;
  globalThis.fetch = async (url, options) => {
    const action = new URL(url).searchParams.get("action");
    if (action === "auth.login") return new Response(JSON.stringify({ ok: true, data: { member, token: "opaque-token-value-0123456789" } }));
    assert.equal(action, "member.bio");
    savedPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, data: { member: { ...member, bio: savedPayload.bio } } }));
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const login = await request({ op: "login", email: member.email, code: "123456" });
  const saved = await request({ op: "bio", bio: "  我的简介  ", session_id: login.body.session_id });
  assert.equal(saved.status, 200);
  assert.deepEqual(savedPayload, { bio: "我的简介" });
  assert.equal(saved.body.bio, "我的简介");
  const invalid = await request({ op: "bio", bio: "简介\0无效", session_id: login.body.session_id });
  assert.equal(invalid.status, 400);
});

test("browser member proxy forwards all profile updates and reports nickname validation errors", async (t) => {
  const originalFetch = globalThis.fetch;
  const forwarded = [];
  globalThis.fetch = async (url, options) => {
    const action = new URL(url).searchParams.get("action");
    if (action === "auth.login") return new Response(JSON.stringify({ ok: true, data: { member, token: "opaque-token-value-0123456789" } }));
    forwarded.push({ action, payload: JSON.parse(options.body) });
    if (action === "member.nickname" && forwarded.at(-1).payload.nickname === "bad") {
      return new Response(JSON.stringify({ ok: false }), { status: 422 });
    }
    const updated = {
      ...member,
      ...(action === "member.avatar" ? { avatar_key: forwarded.at(-1).payload.avatar_key } : {}),
      ...(action === "member.nickname" ? { nickname: forwarded.at(-1).payload.nickname } : {}),
      ...(action === "member.bio" ? { bio: forwarded.at(-1).payload.bio } : {}),
    };
    return new Response(JSON.stringify({ ok: true, data: { member: updated } }));
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const login = await request({ op: "login", email: member.email, code: "123456" });
  const avatar = await request({ op: "avatar", avatar_key: 8, session_id: login.body.session_id });
  const nickname = await request({ op: "nickname", nickname: "新昵称", session_id: login.body.session_id });
  const bio = await request({ op: "bio", bio: "新的简介", session_id: login.body.session_id });
  const rejectedNickname = await request({ op: "nickname", nickname: "bad", session_id: login.body.session_id });

  assert.equal(avatar.status, 200);
  assert.equal(avatar.body.avatar_key, 8);
  assert.equal(nickname.status, 200);
  assert.equal(nickname.body.nickname, "新昵称");
  assert.equal(bio.status, 200);
  assert.equal(bio.body.bio, "新的简介");
  assert.deepEqual(forwarded.slice(0, 3), [
    { action: "member.avatar", payload: { avatar_key: 8 } },
    { action: "member.nickname", payload: { nickname: "新昵称" } },
    { action: "member.bio", payload: { bio: "新的简介" } },
  ]);
  assert.equal(rejectedNickname.status, 502);
  assert.equal(rejectedNickname.body.error, "昵称需为1到20个字符，且不能包含控制字符");
});

test("browser member login rejects unsafe bearer-token characters without leaking them", async (t) => {
  const originalFetch = globalThis.fetch;
  const unsafeToken = `safe-token-value-123\r\nX-Injected: yes`;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: { member, token: unsafeToken } }));
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await request({ op: "login", email: member.email, code: "123456" });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "登录响应无效");
  assert.deepEqual(result.body.details, { diagnostic: "token-contains-unsafe-characters" });
  assert.equal(JSON.stringify(result).includes(unsafeToken), false);
});

test("browser member login reports only a safe diagnostic when the upstream omits a string token", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: { member, token: null } }));
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await request({ op: "login", email: member.email, code: "123456" });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "登录响应无效");
  assert.deepEqual(result.body.details, { diagnostic: "token-not-string" });
});

test("browser member route accepts the registered native message command names", async () => {
  for (const [op, expectedMessage] of [
    ["member_messages", "登录已失效，请重新登录"],
    ["member_message", "登录已失效，请重新登录"],
    ["member_messages_read_all", "登录已失效，请重新登录"],
  ]) {
    const result = await request({ op, page: 1, id: 1, session_id: "" });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, expectedMessage);
  }
});

test("browser member route accepts dotted API action names", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const action = new URL(url).searchParams.get("action");
    if (action === "auth.login") return new Response(JSON.stringify({ ok: true, data: { member, token: "opaque-token-value-0123456789" } }));
    assert.equal(action, "member.messages");
    return new Response(JSON.stringify({ ok: true, data: { items: [], unread_count: 0, page: 1, has_more: false } }));
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const login = await request({ op: "login", email: member.email, code: "123456" });
  assert.equal(login.status, 200);
  const result = await request({ op: "member.messages", page: 1, session_id: login.body.session_id });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { items: [], unread_count: 0, page: 1, has_more: false });
});

test("browser member proxy exposes only the upstream status and action for safe 502 diagnosis", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "upstream body must not be exposed" }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await request({ op: "send_code", email: member.email });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "会员服务发生内部错误，请稍后重试");
  assert.deepEqual(result.body.details, {
    diagnostic: "upstream-http-status",
    action: "auth.send_code",
    upstream_status: 502,
  });
  assert.equal(JSON.stringify(result).includes("upstream body"), false);
});
