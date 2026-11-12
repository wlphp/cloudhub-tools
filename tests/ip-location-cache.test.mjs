import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cachedIpLocation, deleteCachedIpLocation } from "../web-api/routes/ip-location.mjs";

test("SQLite persists IP results, deduplicates queries and only refetches after deletion", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cloudhub-ip-test-"));
  const file = path.join(dir, "cache.sqlite3");
  let db = new DatabaseSync(file);
  db.exec("CREATE TABLE ip_location_cache(ip TEXT PRIMARY KEY,result_json TEXT NOT NULL)");
  let calls = 0;
  let fail = false;
  let found = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (fail) throw new Error("fixture failure");
    const { target } = JSON.parse(options.body);
    return new Response(JSON.stringify({ feature: "ip", target, found, location: found ? { country: "中国", province: "河北" } : null }));
  };
  try {
    await assert.rejects(cachedIpLocation("invalid", db), /有效/);
    assert.equal(calls, 0);
    const [first, second] = await Promise.all([cachedIpLocation("192.0.2.1", db), cachedIpLocation("192.0.2.1", db)]);
    assert.deepEqual(first, second);
    assert.equal(calls, 1);
    db.close();
    db = new DatabaseSync(file);
    assert.deepEqual(await cachedIpLocation("192.0.2.1", db), first);
    assert.equal(calls, 1, "Reopening SQLite must not query the provider");
    await deleteCachedIpLocation("192.0.2.1", db);
    await cachedIpLocation("192.0.2.1", db);
    assert.equal(calls, 2);
    await Promise.all([cachedIpLocation("2001:db8::1", db), cachedIpLocation("2001:0db8:0:0:0:0:0:1", db)]);
    assert.equal(calls, 3, "Equivalent IPv6 addresses share one record");
    found = false;
    await cachedIpLocation("192.0.2.2", db);
    assert.equal((await cachedIpLocation("192.0.2.2", db)).found, false);
    assert.equal(calls, 4, "Not-found responses are also cached");
    fail = true;
    await assert.rejects(cachedIpLocation("192.0.2.3", db), /连接失败/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM ip_location_cache WHERE ip=?").get("192.0.2.3").count, 0);
    fail = false;
    await cachedIpLocation("192.0.2.3", db);
    assert.equal(calls, 6, "Failures remain retryable");
    const query = cachedIpLocation("192.0.2.4", db);
    await deleteCachedIpLocation("192.0.2.4", db);
    await query;
    assert.equal(db.prepare("SELECT count(*) AS count FROM ip_location_cache WHERE ip=?").get("192.0.2.4").count, 0, "An in-flight query cannot resurrect a deleted result");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    unlinkSync(file);
    rmdirSync(dir);
  }
});
