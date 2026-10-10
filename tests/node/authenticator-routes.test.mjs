import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleAuthenticatorRoute } from "../../web-api/routes/authenticator.mjs";

async function request(method, body, headers = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method; req.headers = { host: "127.0.0.1:1430", "content-type": "application/json", ...headers };
  let result;
  const res = { headersSent: false, writableEnded: false, destroyed: false, _header: null, setHeader() {}, writeHead(status) { this.status = status; }, end(payload) { result = { status: this.status, body: JSON.parse(payload) }; } };
  assert.equal(await handleAuthenticatorRoute(req, res, new URL("http://127.0.0.1:1430/api/authenticator")), true);
  return result;
}
test("authenticator route rejects unsupported methods, hosts, content types and payloads", async () => {
  assert.equal((await request("GET", "")).status, 405);
  assert.equal((await request("POST", "{}", { host: "example.com:1430" })).status, 403);
  assert.equal((await request("POST", "{}", { "content-type": "text/plain" })).status, 403);
  for (const body of ["not-json", "null", "[]", '{"op":"unknown","args":{}}', '{"op":"list","args":[],"extra":"untrusted"}']) {
    const response = await request("POST", body);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "authenticator-error");
    assert.ok(!JSON.stringify(response).includes("untrusted"));
  }
});
