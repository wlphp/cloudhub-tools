export function saveAccount(input, { accountRepository, encryptSecret, serializeOciPrivateKey, validateOracleMeta, validateAzureMeta, validateGcpMeta }) {
  if (!input || !String(input.account_name || "").trim() || !String(input.access_key_id || "").trim()) throw new Error("账号名称和密钥 ID 不能为空");
  const allowedCloudTypes = new Set(["aliyun", "vultr", "tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "jdcloud", "qingcloud", "ksyun", "qiniu", "aws", "azure", "gcp", "other"]);
  const cloudType = allowedCloudTypes.has(input.cloud_type) ? input.cloud_type : "other";
  if (cloudType === "oracle") validateOracleMeta({ credential_meta: input.credential_meta });
  if (cloudType === "azure") validateAzureMeta({ credential_meta: input.credential_meta });
  if (cloudType === "gcp") validateGcpMeta({ credential_meta: input.credential_meta });
  const accountId = Number(input.id);
  const isUpdate = Number.isInteger(accountId) && accountId > 0;
  const old = isUpdate ? accountRepository.getAccountForUpdate(accountId) : null;
  if (isUpdate && !old) throw new Error("云账号不存在");
  const newSecret = cloudType === "oracle" ? serializeOciPrivateKey(input.access_key_secret) : String(input.access_key_secret || "").trim();
  const secret = newSecret ? encryptSecret(newSecret) : old?.secret_ciphertext;
  if (!secret) throw new Error("首次添加必须填写密钥 Secret");
  const now = Date.now();
  const values = [String(input.account_name).trim(), cloudType, input.group_name || null, String(input.access_key_id).trim(), secret, ["oracle", "azure", "gcp"].includes(cloudType) ? String(input.credential_meta || old?.credential_meta || "").trim() || null : null, input.region_id || null, Math.max(0, Number(input.sort_order) || 0), input.enabled === false ? 0 : 1, input.remark || null, now];
  return accountRepository.saveAccountRecord({ id: accountId, values, now });
}
