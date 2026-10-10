import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { listCertificateSummaries } from "../../web-api/repositories/certificates.mjs";
import { handleLocalRoutes } from "../../web-api/routes/local.mjs";

test("certificate metadata includes account-independent snapshots and excludes material and errors", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(listCertificateSummaries(db), []);
    db.exec(`CREATE TABLE certificates(id INTEGER,provider TEXT,primary_domain TEXT,domains_json TEXT,status TEXT,issuer TEXT,serial_number TEXT,not_before INTEGER,not_after INTEGER,updated_at INTEGER,private_key_ciphertext TEXT,last_error TEXT);
      CREATE TABLE certificate_snapshots(sync_id TEXT,metadata_json TEXT);
      CREATE TABLE certificate_sync_identity(certificate_id INTEGER,sync_id TEXT);
      INSERT INTO certificates VALUES(1,'letsencrypt','example.com','["example.com"]','issued','Fixture CA','123',100,200,1,'fixture encrypted material','fixture error');`);
    const metadata = { syncId: "snapshot", provider: "litessl", primaryDomain: "other.example.com", domains: ["other.example.com"], status: "issued", issuer: "Fixture CA", serialNumber: null, notBefore: 200, notAfter: 300, updatedAt: 2, privateKeyPem: "unexpected field" };
    db.prepare("INSERT INTO certificate_snapshots VALUES(?,?)").run("snapshot",JSON.stringify(metadata));
    const items = listCertificateSummaries(db);
    assert.equal(items.length,2);
    assert.equal(items[0].id,-1);
    assert.equal(items[0].notAfter,300);
    const json = JSON.stringify(items);
    for (const key of ["private_key", "privateKey", "last_error", "accountId", "unexpected field", "fixture error"]) assert.ok(!json.includes(key));
    db.prepare("INSERT INTO certificate_sync_identity VALUES(?,?)").run(1,"snapshot");
    assert.equal(listCertificateSummaries(db).length,1);
  } finally { db.close(); }
});

test("certificate route is strictly read only and rejects unexpected parameters", () => {
  let reads = 0;
  const services = { listCertificateSummaries: () => { reads++; return []; } };
  const call = (method,query = "") => {
    const res = { _header: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    handleLocalRoutes({method},res,new URL(`http://localhost/api/certificate-summaries${query}`),services);
    return res;
  };
  assert.equal(call("GET").status,200);
  assert.equal(call("GET","?account_id=1").status,400);
  assert.equal(call("GET","?id=invalid").status,400);
  for (const method of ["POST","PUT","DELETE"]) assert.equal(call(method).status,405);
  assert.equal(reads,1);
});
