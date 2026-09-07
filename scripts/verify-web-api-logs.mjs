import assert from "node:assert/strict";
import { MAX_LOG_JSON_BYTES, serializeLogValue } from "../web-api/core/logging.mjs";

const output = serializeLogValue({ AccessKeySecret: "secret-value", nested: { authorization: "bearer-value", safe: "kept" } });
assert.match(output, /\[REDACTED\]/);
assert.doesNotMatch(output, /secret-value|bearer-value/);
assert.match(serializeLogValue({ body: "x".repeat(MAX_LOG_JSON_BYTES) }), /"truncated":true/);
console.log("Web API log redaction checks passed");
