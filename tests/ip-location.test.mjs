import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { queryIpLocation, handleIpLocationRoute } from "../web-api/routes/ip-location.mjs";

const result = { feature: "ip", target: "60.4.168.142", found: true, location: { country: "中国", province: "河北", city: "保定", isp: "中国联通", display: "河北/保定/中国联通", longitude: 115.48233, latitude: 38.867657, has_coordinates: true }, checked_at: 1793068142, request_id: "fixture-request", extra: { future_field: "保留新增信息" } };

test("查询只向固定 HTTPS 接口发送有效 IP 并保留所有返回字段", async t => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://t.bt.cn/api/v3/ip-lookup");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { target: result.target });
    return Response.json(result);
  });
  assert.deepEqual(await queryIpLocation(` ${result.target} `), result);
});

test("无效参数在网络请求之前被拒绝", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("不应请求"); });
  for (const ip of [null, {}, "", "1", "999.1.1.1", "https://example.test", "60.4.168.142/path"]) await assert.rejects(queryIpLocation(ip), /有效的 IP/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("拒绝不匹配的查询结果、畸形数据、错误状态和过大响应", async t => {
  for (const payload of [{ ...result, target: "192.0.2.1" }, { ...result, location: [] }, { message: "untrusted" }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    await assert.rejects(queryIpLocation(result.target), /数据无效/);
  }
  t.mock.method(globalThis, "fetch", async () => new Response("untrusted response", { status: 429 }));
  await assert.rejects(queryIpLocation(result.target), /暂不可用/);
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(65_537)));
  await assert.rejects(queryIpLocation(result.target), /响应过大/);
});

test("IPv6 标准化和未收录结果能够返回", async t => {
  const data = { feature: "ip", target: "2001:db8::1", found: false, location: null };
  t.mock.method(globalThis, "fetch", async () => Response.json(data));
  assert.deepEqual(await queryIpLocation("2001:0db8:0:0:0:0:0:1"), data);
});

test("本地预览路由校验请求体并支持成功查询", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json(result));
  for (const [body, status] of [["{", 400], ["null", 400], ['{"ip":"1"}', 400], [JSON.stringify({ ip: result.target }), 200]]) {
    const req = Readable.from([body]); req.method = "POST";
    const res = { _header: null, writeHead(code) { this.status = code; }, end(payload) { this.payload = JSON.parse(payload); } };
    assert.equal(await handleIpLocationRoute(req, res, new URL("http://localhost/api/ip-location")), true);
    assert.equal(res.status, status);
    if (status === 200) assert.deepEqual(res.payload, result);
  }
});
