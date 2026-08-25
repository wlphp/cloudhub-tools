import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const dir = path.join(process.env.LOCALAPPDATA, "CloudHubTools");
const db = new DatabaseSync(path.join(dir, "cloudhub_tools.sqlite3"));
const row = db.prepare("SELECT access_key_id,secret_ciphertext FROM cloud_accounts WHERE enabled=1 ORDER BY id LIMIT 1").get();
db.close();
const packed = Buffer.from(row.secret_ciphertext, "base64");
const decipher = crypto.createDecipheriv("aes-256-gcm", fs.readFileSync(path.join(dir, ".key")), packed.subarray(0, 12));
decipher.setAuthTag(packed.subarray(-16));
const secret = Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString();
const encode = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
async function rpc(endpoint, version, action, extra = {}) {
  const params = { ...extra, AccessKeyId: row.access_key_id, Action: action, Format: "JSON", SignatureMethod: "HMAC-SHA1", SignatureNonce: crypto.randomUUID(), SignatureVersion: "1.0", Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), Version: version };
  const encoded = Object.entries(params).map(([k, v]) => [encode(k), encode(v)]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const canonical = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  const toSign = `GET&%2F&${encode(canonical)}`;
  params.Signature = crypto.createHmac("sha1", `${secret}&`).update(toSign).digest("base64");
  const query = Object.entries(params).map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
  const response = await fetch(`https://${endpoint}/?${query}`); const json = await response.json();
  return { http: response.status, code: json.Code || "OK", message: json.Message || "" };
}
async function esa() {
  const host = "esa.cn-hangzhou.aliyuncs.com"; const action = "ListSites"; const query = [["PageNumber", "1"], ["PageSize", "100"]].map(([k, v]) => [encode(k), encode(v)]).sort().map(([k, v]) => `${k}=${v}`).join("&");
  const payloadHash = crypto.createHash("sha256").update("").digest("hex"); const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); const nonce = crypto.randomUUID();
  const headers = { host, "x-acs-action": action, "x-acs-content-sha256": payloadHash, "x-acs-date": date, "x-acs-signature-nonce": nonce, "x-acs-version": "2024-09-10" };
  const canonicalHeaders = Object.entries(headers).sort().map(([k, v]) => `${k}:${v}\n`).join(""); const signed = Object.keys(headers).sort().join(";");
  const canonicalRequest = `GET\n/\n${query}\n${canonicalHeaders}\n${signed}\n${payloadHash}`; const stringToSign = `ACS3-HMAC-SHA256\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signature = crypto.createHmac("sha256", secret).update(stringToSign).digest("hex"); const auth = `ACS3-HMAC-SHA256 Credential=${row.access_key_id},SignedHeaders=${signed},Signature=${signature}`;
  const response = await fetch(`https://${host}/?${query}`, { headers: { ...headers, authorization: auth } }); const json = await response.json(); return { http: response.status, code: json.Code || "OK", message: json.Message || "" };
}
console.log("ecs", await rpc("ecs.aliyuncs.com", "2014-05-26", "DescribeRegions"));
console.log("domain", await rpc("domain.aliyuncs.com", "2018-01-29", "QueryDomainList", { PageNum: 1, PageSize: 100 }));
console.log("rds", await rpc("rds.aliyuncs.com", "2014-08-15", "DescribeDBInstances", { RegionId: "cn-beijing", PageSize: 100 }));
console.log("redis", await rpc("r-kvstore.aliyuncs.com", "2015-01-01", "DescribeInstances", { RegionId: "cn-beijing", PageSize: 50 }));
console.log("swas", await rpc("swas.cn-beijing.aliyuncs.com", "2020-06-01", "ListInstances", { RegionId: "cn-beijing", PageSize: 100 }));
console.log("esa", await esa());
async function oss() {
  const host = "oss-cn-hangzhou.aliyuncs.com"; const date = new Date().toUTCString(); const sign = crypto.createHmac("sha1", secret).update(`GET\n\n\n${date}\n/`).digest("base64");
  const response = await fetch(`https://${host}/`, { headers: { Date: date, Authorization: `OSS ${row.access_key_id}:${sign}` } }); return { http: response.status, contentType: response.headers.get("content-type") };
}
console.log("oss", await oss());
console.log("balance", await rpc("business.aliyuncs.com", "2017-12-14", "QueryAccountBalance"));
console.log("bill", await rpc("business.aliyuncs.com", "2017-12-14", "QueryBill", { BillingCycle: new Date().toISOString().slice(0, 7) }));
