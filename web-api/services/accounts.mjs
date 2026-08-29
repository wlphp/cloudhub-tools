export function createAccountService({ database, decryptSecret, encryptSecret, oracleMeta, azureMeta, gcpMeta, serializeOciPrivateKey }) {
  function list(keyword = "", includeSecret = false) {
    const db = database();
    const value = String(keyword || "").trim();
    const rows = db.prepare(`SELECT id,account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE ? = '' OR account_name LIKE ? OR access_key_id LIKE ? OR COALESCE(group_name,'') LIKE ? ORDER BY sort_order ASC, updated_at DESC`).all(value, `%${value}%`, `%${value}%`, `%${value}%`);
    return rows.map((row) => {
      const account = { id: row.id, account_name: row.account_name, cloud_type: row.cloud_type, group_name: row.group_name, access_key_id: row.access_key_id, credential_meta: row.credential_meta, region_id: row.region_id, sort_order: row.sort_order ?? 0, enabled: Boolean(row.enabled), remark: row.remark, created_at: row.created_at, updated_at: row.updated_at };
      if (includeSecret) account.access_key_secret = decryptSecret(row.secret_ciphertext);
      return account;
    });
  }

  function save(input) {
    if (!input || !String(input.account_name || "").trim() || !String(input.access_key_id || "").trim()) throw new Error("账号名称和密钥 ID 不能为空");
    const allowedCloudTypes = new Set(["aliyun", "vultr", "tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "ucloud", "jdcloud", "qingcloud", "ksyun", "qiniu", "aws", "azure", "gcp", "other"]);
    const cloudType = allowedCloudTypes.has(input.cloud_type) ? input.cloud_type : "other";
    if (cloudType === "oracle") oracleMeta({ credential_meta: input.credential_meta });
    if (cloudType === "azure") azureMeta({ credential_meta: input.credential_meta });
    if (cloudType === "gcp") gcpMeta({ credential_meta: input.credential_meta });
    const accountId = Number(input.id);
    const isUpdate = Number.isInteger(accountId) && accountId > 0;
    const db = database();
    const old = isUpdate ? db.prepare("SELECT secret_ciphertext,credential_meta FROM cloud_accounts WHERE id=?").get(accountId) : null;
    if (isUpdate && !old) throw new Error("云账号不存在");
    const newSecret = cloudType === "oracle" ? serializeOciPrivateKey(input.access_key_secret) : String(input.access_key_secret || "").trim();
    const secret = newSecret ? encryptSecret(newSecret) : old?.secret_ciphertext;
    if (!secret) throw new Error("首次添加必须填写密钥 Secret");
    const now = Date.now();
    const values = [String(input.account_name).trim(), cloudType, input.group_name || null, String(input.access_key_id).trim(), secret, ["oracle", "azure", "gcp"].includes(cloudType) ? String(input.credential_meta || old?.credential_meta || "").trim() || null : null, input.region_id || null, Math.max(0, Number(input.sort_order) || 0), input.enabled === false ? 0 : 1, input.remark || null, now];
    let id = accountId;
    if (isUpdate) db.prepare("UPDATE cloud_accounts SET account_name=?,cloud_type=?,group_name=?,access_key_id=?,secret_ciphertext=?,credential_meta=?,region_id=?,sort_order=?,enabled=?,remark=?,updated_at=? WHERE id=?").run(...values, id);
    else {
      db.prepare("INSERT INTO cloud_accounts(account_name,cloud_type,group_name,access_key_id,secret_ciphertext,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(...values, now);
      id = Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
    }
    const row = db.prepare("SELECT id,account_name,cloud_type,group_name,access_key_id,credential_meta,region_id,sort_order,enabled,remark,created_at,updated_at FROM cloud_accounts WHERE id=?").get(id);
    return { ...row, enabled: Boolean(row.enabled) };
  }

  return { list, save };
}
