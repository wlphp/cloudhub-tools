import assert from "node:assert/strict";
import { safeProviderError, sanitizeResourceResponse, stableAssetKey } from "../web-api/core/resources.mjs";

const fallbackItem = { RegionId: "cn-hangzhou", PrivateIpAddress: "10.0.0.8" };
assert.equal(stableAssetKey("ecs", fallbackItem), stableAssetKey("ecs", fallbackItem));
assert.equal(stableAssetKey("ecs", fallbackItem), "ecs:cn-hangzhou:10.0.0.8");
assert.equal(stableAssetKey("ecs", { InstanceId: "i-123" }), "i-123");

const sanitized = sanitizeResourceResponse({
  resource_type: "ecs",
  items: [{}],
  errors: ["request failed secret=TOP_SECRET token=TOP_TOKEN"],
}, "ecs");
assert.equal(sanitized.errors[0], "云厂商认证失败，请检查账号凭据");
assert.ok(!sanitized.errors[0].includes("TOP_SECRET"));
assert.ok(!sanitized.errors[0].includes("TOP_TOKEN"));
assert.equal(safeProviderError("HTTP 403 Forbidden"), "云厂商权限不足，请检查账号权限");
console.log("Resource contract checks passed: stable keys and safe provider errors");
