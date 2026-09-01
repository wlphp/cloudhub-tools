import assert from "node:assert/strict";
import { send } from "../web-api/core/http.mjs";
import {
  allowedWebOrigins,
  applyWebCors,
  webRequestOriginPolicy,
} from "../web-api/core/security.mjs";

function responseHeaders() {
  const values = new Map();
  return {
    values,
    status: null,
    setHeader(name, value) {
      values.set(String(name).toLowerCase(), String(value));
    },
    writeHead(status, headers = {}) {
      this.status = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end() {},
  };
}

const defaults = allowedWebOrigins("");
assert.deepEqual([...defaults], ["http://127.0.0.1:1420", "http://localhost:1420"]);
assert.equal(webRequestOriginPolicy({ headers: { origin: "https://example.com" } }, defaults).allowed, false);
assert.equal(webRequestOriginPolicy({ headers: { "sec-fetch-site": "cross-site" } }, defaults).allowed, false);
assert.equal(webRequestOriginPolicy({ headers: {} }, defaults).allowed, true);

const allowedResponse = responseHeaders();
const allowed = applyWebCors(
  { headers: { origin: "http://127.0.0.1:1420" } },
  allowedResponse,
  defaults,
);
assert.equal(allowed.allowed, true);
assert.equal(allowedResponse.values.get("access-control-allow-origin"), "http://127.0.0.1:1420");
assert.notEqual(allowedResponse.values.get("access-control-allow-origin"), "*");
send(allowedResponse, 200, { ok: true });
assert.equal(allowedResponse.values.get("access-control-allow-origin"), "http://127.0.0.1:1420");

const forbiddenResponse = responseHeaders();
const forbidden = applyWebCors(
  { headers: { origin: "https://example.com" } },
  forbiddenResponse,
  defaults,
);
assert.equal(forbidden.allowed, false);
assert.equal(forbiddenResponse.values.has("access-control-allow-origin"), false);
send(forbiddenResponse, 403, { error: "forbidden" });
assert.equal(forbiddenResponse.values.has("access-control-allow-origin"), false);

const configured = allowedWebOrigins("http://127.0.0.1:4173, https://localhost:4443/, *, not-a-url");
assert.deepEqual([...configured], ["http://127.0.0.1:4173", "https://localhost:4443"]);

console.log("Web API origin policy checks passed");
