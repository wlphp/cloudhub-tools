export function saveAccount(input, { accountRepository, encryptSecret, serializeOciPrivateKey, validateOracleMeta, validateAzureMeta, validateGcpMeta }) {
  if (!input || !String(input.account_name || "").trim() || !String(input.access_key_id || "").trim()) throw new Error("账号名称和密钥 ID 不能为空");
  const allowedCloudTypes = new Set(["cloudflare", "aliyun", "vultr", "tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "jdcloud", "qingcloud", "ksyun", "qiniu", "aws", "azure", "gcp", "other"]);
  const cloudType = allowedCloudTypes.has(input.cloud_type) ? input.cloud_type : "other";
  if (cloudType === "cloudflare" && !/^[a-f\d]{32}$/i.test(String(input.access_key_id).trim())) throw new Error("Cloudflare Account ID 必须为 32 位十六进制字符");
  if (cloudType === "oracle") validateOracleMeta({ credential_meta: input.credential_meta });
  if (cloudType === "azure") validateAzureMeta({ credential_meta: input.credential_meta });
  if (cloudType === "gcp") validateGcpMeta({ credential_meta: input.credential_meta });
  const accountId = Number(input.id);
  const isUpdate = Number.isInteger(accountId) && accountId > 0;
  const old = isUpdate ? accountRepository.getAccountForUpdate(accountId) : null;
  if (isUpdate && !old) throw new Error("云账号不存在");
  const newSecret = cloudType === "oracle" ? serializeOciPrivateKey(input.access_key_secret) : String(input.access_key_secret || "").trim();
  if (cloudType === "cloudflare" && old && !newSecret && (old.cloud_type !== cloudType || old.access_key_id !== String(input.access_key_id).trim())) throw new Error("更改 Cloudflare 类型或 Account ID 时必须重新填写 API Token");
  const secret = newSecret ? encryptSecret(newSecret) : old?.secret_ciphertext;
  if (!secret) throw new Error("首次添加必须填写密钥 Secret");
  const now = Date.now();
  const values = [String(input.account_name).trim(), cloudType, input.group_name || null, String(input.access_key_id).trim(), secret, ["oracle", "azure", "gcp"].includes(cloudType) ? String(input.credential_meta || old?.credential_meta || "").trim() || null : null, input.region_id || null, Math.max(0, Number(input.sort_order) || 0), input.enabled === false ? 0 : 1, input.remark || null, now];
  return accountRepository.saveAccountRecord({ id: accountId, values, now });
}
