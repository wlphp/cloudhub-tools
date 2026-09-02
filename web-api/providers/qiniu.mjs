import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

export async function buckets(accountId) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "qiniu") throw new Error("当前账号不是七牛云账号");
  const signature = crypto.createHmac("sha1", decryptSecret(row.secret_ciphertext)).update("/buckets\n").digest("base64url");
  const response = await fetch("https://rs.qiniuapi.com/buckets", { headers: { Authorization: `QBox ${row.access_key_id}:${signature}` } });
  const data = await response.json().catch(() => []);
  if (!response.ok) { const message = data?.error || data?.message || `七牛云 ${response.status}`; writeApiLog(accountId, "rs.qiniuapi.com", "ListBuckets", {}, data, "失败", message); throw new Error(message); }
  const region = String(row.region_id || "z0");
  const items = (Array.isArray(data) ? data : []).map((name) => ({ Name: String(name), BucketName: String(name), Location: region, CreationDate: "", StorageClass: "STANDARD", Acl: "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: region }));
  writeApiLog(accountId, "rs.qiniuapi.com", "ListBuckets", {}, { count: items.length }, "成功");
  return items;
}

export async function resources(accountId, type) {
  if (type !== "oss") return { resource_type: type, items: [], errors: [`七牛云暂未接入 ${type} 资源；当前仅支持 Kodo 空间`], fetched_at: Date.now() };
  try { return { resource_type: type, items: await buckets(accountId), errors: [], fetched_at: Date.now() }; }
  catch (error) { return { resource_type: type, items: [], errors: [error.message], fetched_at: Date.now() }; }
}

export async function verify(accountId, regions = ["z0"]) {
  const items = await buckets(accountId);
  return { provider: "qiniu", verified: true, region_count: regions.length, regions, default_region: regions[0], bucket_count: items.length };
}
