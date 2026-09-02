import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";
import { rpcEncode } from "./aliyun-rpc.mjs";

export async function request(id, action, params = {}, method = "GET") {
  const row = getAccountSecretRecord(id);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "aliyun") throw new Error(`${row.cloud_type === "tencent" ? "腾讯云" : "当前云类型"}资源 API 尚未接入`);
  const host = "esa.cn-hangzhou.aliyuncs.com";
  const normalizedMethod = method.toUpperCase();
  const query = Object.entries(params).map(([key, value]) => [rpcEncode(key), rpcEncode(value)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&");
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const acsDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const headers = { host, "x-acs-action": action, "x-acs-content-sha256": payloadHash, "x-acs-date": acsDate, "x-acs-signature-nonce": crypto.randomUUID(), "x-acs-version": "2024-09-10" };
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = `${normalizedMethod}\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `ACS3-HMAC-SHA256\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signature = crypto.createHmac("sha256", decryptSecret(row.secret_ciphertext)).update(stringToSign).digest("hex");
  const authorization = `ACS3-HMAC-SHA256 Credential=${row.access_key_id},SignedHeaders=${signedHeaders},Signature=${signature}`;
  const response = await fetch(`https://${host}/${query ? `?${query}` : ""}`, { method: normalizedMethod, headers: { ...headers, authorization } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.Code) { const message = data.Message || data.Code || `ESA ${response.status}`; writeApiLog(id, host, action, params, data, "失败", message); throw new Error(message); }
  writeApiLog(id, host, action, params, data, "成功");
  return data;
}
