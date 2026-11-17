import { test } from "node:test";
import assert from "node:assert/strict";
import { updateInfo, probe, routedUrl, routes, handleAppUpdateRoute } from "../web-api/routes/app-updates.mjs";
const API = "https://api.github.com/repos/wlphp/cloudhub-tools/releases/latest";
const asset = "https://github.com/wlphp/cloudhub-tools/releases/download/v99.1.0/test.apk";
const release = () => new Response(JSON.stringify({ tag_name: "v99.1.0", draft: false, prerelease: false, body: "发布说明", assets: [{ browser_download_url: asset }] }), { headers: { "content-type": "application/json" } });
test("auto falls back after invalid proxy response; manual direct never contacts proxy", async () => {
  const urls = [];
  const fetcher = async url => { urls.push(url); return url.startsWith("https://gh-proxy.com/") ? new Response("<html>unavailable</html>") : release(); };
  assert.equal((await updateInfo("auto", fetcher)).route, "mirror705810");
  assert.deepEqual(urls, [`https://gh-proxy.com/${API}`, `https://github.705810.xyz/${API}`]);
  urls.length = 0;
  assert.equal((await updateInfo("direct", fetcher)).version, "99.1.0");
  assert.deepEqual(urls, [API]);
  await assert.rejects(updateInfo("accelerated", fetcher));
});
test("invalid routes and foreign download addresses are rejected", async () => {
  assert.throws(() => routes("https://evil.test"));
  for (const url of ["https://evil.test/test.apk", asset + "?token=x", asset.replace("https:", "http:"), asset.replace("wlphp/", "other/")]) assert.throws(() => routedUrl(url, "accelerated"));
  const res = { headersSent: false, _header: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  assert.equal(await handleAppUpdateRoute({ method: "GET" }, res, new URL("http://localhost/api/app-update-probe?route=invalid")), true);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "validation");
});
test("probe stops at 256 KiB even when server ignores Range", async () => {
  let cancelled = false;
  const result = await probe("direct", async (url, options) => {
    if (url === API) return release();
    assert.equal(options.headers.Range, "bytes=0-262143");
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/octet-stream" } });
  });
  assert.equal(result.available, true);
  assert.equal(cancelled, true);
  assert.ok(result.bytesPerSecond > 0);
});
test("both unavailable is an error, not a current-version result; foreign redirects fail", async () => {
  await assert.rejects(updateInfo("auto", async () => { throw new Error("offline"); }));
  await assert.rejects(updateInfo("direct", async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/internal" } })));
  await assert.rejects(updateInfo("direct", async () => new Response(JSON.stringify({ tag_name: "v1.2.3", draft: true, prerelease: false }))));
});
