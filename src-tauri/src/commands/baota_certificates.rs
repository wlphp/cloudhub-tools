//! Site-oriented certificate management. Secrets never leave this module for UI/logging.
use super::certificate_import::{parse_material, save_material, CertificateResult};
use super::certificates::CertificateListItem;
use crate::core::error::PlatformResult;
use crate::core::repositories::{certificates, panel_connections};
use crate::{decrypt_secret, open_db, PanelConnection};
use chrono::Utc;
use md5::{Digest, Md5};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    io::Cursor,
    time::Duration,
};
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SiteCertificate {
    pub id: i64,
    pub panel_id: Option<i64>,
    pub panel_name: String,
    pub site_id: i64,
    pub site_name: String,
    pub site_domains: Vec<String>,
    pub certificate_domains: Vec<String>,
    pub enabled: bool,
    #[serde(default)]
    pub site_remark: Option<String>,
    #[serde(default)]
    pub pending_renewal: bool,
    pub issuer: Option<String>,
    pub not_after: Option<i64>,
    pub fingerprint: Option<String>,
    pub certificate_id: Option<i64>,
    pub can_renew: bool,
    pub can_import: bool,
    pub capability_reason: String,
    pub checked_at: i64,
    pub error: Option<String>,
}

fn text<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| v.get(*key).and_then(Value::as_str))
        .filter(|v| !v.is_empty())
}
fn names(v: &Value) -> Vec<String> {
    let mut result = v
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str().or_else(|| text(row, &["name", "domain"])))
                .map(|value| value.to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    result.sort();
    result.dedup();
    result
}
fn certificate_identity(pem: &str) -> Option<(String, String, i64)> {
    use sha2::Sha256;
    use x509_parser::prelude::*;
    let der = rustls_pemfile::certs(&mut Cursor::new(pem)).next()?.ok()?;
    let (_, parsed) = X509Certificate::from_der(der.as_ref()).ok()?;
    Some((
        hex::encode(Sha256::digest(der.as_ref())),
        parsed.raw_serial_as_string(),
        parsed.validity().not_after.timestamp(),
    ))
}
fn public_info(ssl: &Value) -> Value {
    ssl.get("cert_data")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({}))
}
fn expiry(info: &Value) -> Option<i64> {
    info.get("not_after")
        .or_else(|| info.get("cert_timeout"))
        .and_then(Value::as_i64)
        .or_else(|| {
            text(info, &["notAfter", "not_after"])
                .and_then(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp())
        })
}

struct Api {
    panel: PanelConnection,
    key: Zeroizing<String>,
    client: reqwest::Client,
}
impl Api {
    fn load(id: i64) -> Result<Self, String> {
        if id <= 0 {
            return Err("请选择宝塔面板".into());
        }
        let (panel, cipher) = panel_connections::load_with_secret(&open_db()?, id)?;
        let url = reqwest::Url::parse(&panel.panel_url).map_err(|_| "面板地址无效")?;
        let local_test = cfg!(test)
            && url
                .host_str()
                .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost"));
        if url.scheme() != "https" && !local_test {
            return Err("证书管理需要 HTTPS 面板连接，请先编辑面板地址".into());
        }
        let key = Zeroizing::new(decrypt_secret(&cipher)?);
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(panel.allow_insecure_tls)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "创建面板连接失败")?;
        Ok(Self { panel, key, client })
    }
    async fn call(
        &self,
        path: &str,
        action: &str,
        fields: BTreeMap<String, String>,
        mutating: bool,
    ) -> Result<Value, String> {
        let time = Utc::now().timestamp().to_string();
        let token = format!(
            "{:x}",
            Md5::digest(format!("{time}{:x}", Md5::digest(self.key.as_bytes())).as_bytes())
        );
        let mut fields = fields;
        fields.insert("request_time".into(), time);
        fields.insert("request_token".into(), token);
        fields.insert("action".into(), action.into());
        let url = format!(
            "{}{path}?action={action}",
            self.panel.panel_url.trim_end_matches('/')
        );
        let mut response = self
            .client
            .post(url)
            .form(&fields)
            .timeout(Duration::from_secs(if mutating { 180 } else { 25 }))
            .send()
            .await
            .map_err(|_| {
                if mutating {
                    "面板操作结果待确认，请先刷新站点确认结果，再决定是否重试"
                } else {
                    "连接宝塔失败，请检查面板地址、认证和 API 白名单"
                }
            })?;
        if !response.status().is_success() {
            return Err(format!(
                "宝塔证书接口请求失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let mut bytes = Zeroizing::new(Vec::new());
        while let Some(chunk) = response.chunk().await.map_err(|_| "读取面板响应失败")? {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err("面板响应超过大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "面板未返回有效证书数据，请检查 API 和面板版本")?;
        // GetSSL status=false is a valid unconfigured site; a message-bearing failure is not.
        if value.get("status").and_then(Value::as_bool) == Some(false)
            && (action != "GetSSL" || value.get("msg").is_some() || value.get("message").is_some())
        {
            return Err("宝塔证书操作失败，请在面板检查权限、验证配置和证书状态".into());
        }
        Ok(value)
    }
}
fn fields(items: &[(&str, String)]) -> BTreeMap<String, String> {
    items
        .iter()
        .map(|(key, value)| ((*key).into(), value.clone()))
        .collect()
}
fn order_rows(value: &Value) -> Vec<Value> {
    if let Some(rows) = value.as_array() {
        return rows.clone();
    }
    let data = value.get("data").unwrap_or(value);
    if let Some(rows) = data.as_array() {
        return rows.clone();
    }
    let object = data.get("orders").unwrap_or(data);
    object
        .as_object()
        .map(|rows| {
            rows.iter()
                .filter_map(|(index, row)| {
                    if !row.is_object() {
                        return None;
                    }
                    let mut row = row.clone();
                    if row.get("index").is_none() {
                        row["index"] = json!(index);
                    }
                    Some(row)
                })
                .collect()
        })
        .unwrap_or_default()
}
fn order_pem(order: &Value) -> Option<&str> {
    text(order, &["fullchain", "certificate", "csr"]).or_else(|| {
        order.get("cert").and_then(|cert| {
            cert.as_str()
                .or_else(|| text(cert, &["fullchain", "certificate", "cert"]))
        })
    })
}
fn serial_normalized(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .replace([':', ' ', '-'], "")
        .trim_start_matches('0')
        .to_string()
}
fn matching_order(ssl: &Value, orders: &[Value]) -> Option<String> {
    let info = public_info(ssl);
    let site_identity = text(ssl, &["csr", "certificate"]).and_then(certificate_identity);
    let serial = text(&info, &["serialNumber", "serial_number", "serial"]);
    let mut indexes = HashSet::new();
    for order in orders {
        let Some(index) = text(order, &["index"]) else {
            continue;
        };
        let Some(identity) = order_pem(order).and_then(certificate_identity) else {
            continue;
        };
        let matches = site_identity
            .as_ref()
            .is_some_and(|site| site.0 == identity.0)
            || serial.is_some_and(|serial| {
                !serial_normalized(serial).is_empty()
                    && serial_normalized(serial) == serial_normalized(&identity.1)
            });
        if matches {
            indexes.insert(index.to_string());
        }
    }
    if indexes.len() == 1 {
        indexes.into_iter().next()
    } else {
        None
    }
}
fn sanitize_index(index: &str) -> Result<(), String> {
    if index.is_empty()
        || index.len() > 128
        || !index
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        Err("面板订单标识无效".into())
    } else {
        Ok(())
    }
}

fn save_site(
    api: &Api,
    site: &Value,
    ssl: &Value,
    orders: &[Value],
    error: Option<String>,
) -> Result<SiteCertificate, String> {
    let site_id = site
        .get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or("面板站点标识无效")?;
    let site_name = text(site, &["name"])
        .filter(|name| super::certificates::validate_domain(name))
        .ok_or("面板站点名称无效")?
        .to_string();
    let mut site_domains = names(ssl.get("domain").unwrap_or(&Value::Null));
    if site_domains.is_empty() {
        site_domains.push(site_name.clone());
    }
    let info = public_info(ssl);
    let cert_domains = names(info.get("dns").unwrap_or(&Value::Null));
    let order = matching_order(ssl, orders);
    let identity = text(ssl, &["csr", "certificate"]).and_then(certificate_identity);
    let enabled = ssl.get("status").and_then(Value::as_bool).unwrap_or(false);
    let now = Utc::now().timestamp_millis();
    let conn = open_db()?;
    let old:Option<(i64,Option<i64>)>=conn.query_row("SELECT id,certificate_id FROM certificate_source_links WHERE panel_id=?1 AND site_id=?2",params![api.panel.id,site_id],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_|"读取站点证书关联失败")?;
    let old_pending:Option<(bool,Option<String>)>=conn.query_row("SELECT json_extract(metadata_json,'$.pendingRenewal'),fingerprint FROM certificate_source_links WHERE panel_id=?1 AND site_id=?2",params![api.panel.id,site_id],|row|Ok((row.get::<_,Option<bool>>(0)?.unwrap_or(false),row.get(1)?))).optional().map_err(|_|"读取续签保护状态失败")?;
    let mut result = SiteCertificate {
        id: old.as_ref().map(|row| row.0).unwrap_or(0),
        panel_id: Some(api.panel.id),
        panel_name: api.panel.name.clone(),
        site_id,
        site_name: site_name.clone(),
        site_remark: text(site, &["ps", "remark"]).map(str::to_string),
        pending_renewal: false,
        site_domains: site_domains.clone(),
        certificate_domains: cert_domains,
        enabled,
        issuer: text(&info, &["issuer", "issuer_O"]).map(str::to_string),
        not_after: expiry(&info),
        fingerprint: identity.as_ref().map(|value| value.0.clone()),
        certificate_id: old.and_then(|row| row.1),
        can_renew: order.is_some() && error.is_none(),
        can_import: order.is_some() && error.is_none(),
        capability_reason: if error.is_some() {
            "站点读取失败，可刷新重试"
        } else if !enabled {
            "站点尚未部署 HTTPS"
        } else if order.is_none() {
            "未确认对应的 ACME 订单，可在面板管理或手动导入"
        } else {
            "由宝塔原订单续签"
        }
        .into(),
        checked_at: now,
        error,
    };
    if old_pending.is_some_and(|(pending, old)| {
        pending && (result.fingerprint.is_none() || old == result.fingerprint)
    }) {
        result.pending_renewal = true;
        result.can_renew = false;
        result.capability_reason = "续签结果待确认，请核对面板结果后再操作".into();
    }
    conn.execute("INSERT INTO certificate_source_links(panel_id,site_id,site_name,site_domains_json,panel_name,order_index,fingerprint,metadata_json,last_checked_at,last_error) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(panel_id,site_id) DO UPDATE SET site_name=excluded.site_name,site_domains_json=excluded.site_domains_json,panel_name=excluded.panel_name,order_index=excluded.order_index,fingerprint=excluded.fingerprint,metadata_json=excluded.metadata_json,last_checked_at=excluded.last_checked_at,last_error=excluded.last_error",params![api.panel.id,site_id,site_name,serde_json::to_string(&site_domains).map_err(|_|"站点域名无效")?,api.panel.name,order,identity.map(|value|value.0),serde_json::to_string(&result).map_err(|_|"站点证书信息无效")?,now,result.error]).map_err(|_|"保存站点证书信息失败")?;
    let id = conn
        .query_row(
            "SELECT id FROM certificate_source_links WHERE panel_id=?1 AND site_id=?2",
            params![api.panel.id, site_id],
            |row| row.get(0),
        )
        .map_err(|_| "读取站点证书标识失败")?;
    Ok(SiteCertificate { id, ..result })
}

pub(crate) fn list_baota_site_certificates_inner(
    panel_id: Option<i64>,
) -> CertificateResult<Vec<SiteCertificate>> {
    let conn = open_db()?;
    let mut stmt=conn.prepare("SELECT id,panel_id,certificate_id,metadata_json FROM certificate_source_links WHERE (?1 IS NULL OR panel_id=?1) ORDER BY panel_name,site_name").map_err(|_|"读取宝塔站点证书失败")?;
    let rows = stmt
        .query_map([panel_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|_| "读取宝塔站点证书失败")?;
    let mut result = Vec::new();
    for row in rows {
        let (id, panel_id, certificate_id, metadata) = row.map_err(|_| "读取宝塔站点证书失败")?;
        let mut site: SiteCertificate =
            serde_json::from_str(&metadata).map_err(|_| "本地站点证书信息无效")?;
        site.id = id;
        site.panel_id = panel_id;
        site.certificate_id = certificate_id;
        if panel_id.is_none() {
            site.can_import = false;
            site.can_renew = false;
            site.capability_reason = "来源面板已移除，本地证书仍保留".into();
        }
        result.push(site);
    }
    Ok(result)
}

async fn fetch_orders(api: &Api) -> Vec<Value> {
    let Ok(value) = api
        .call("/acme", "get_orders", BTreeMap::new(), false)
        .await
    else {
        return vec![];
    };
    let rows = order_rows(&value);
    let mut result = Vec::new();
    for row in rows.into_iter().take(200) {
        let Some(index) = text(&row, &["index"]) else {
            continue;
        };
        if sanitize_index(index).is_err() {
            continue;
        }
        if order_pem(&row).is_some() {
            result.push(row);
            continue;
        }
        if let Ok(mut detail) = api
            .call(
                "/acme",
                "get_order_find",
                fields(&[("index", index.into())]),
                false,
            )
            .await
        {
            detail["index"] = json!(index);
            result.push(detail);
        }
    }
    result
}

pub(crate) async fn sync_baota_site_certificates_inner(
    panel_id: i64,
) -> CertificateResult<Vec<SiteCertificate>> {
    let api = Api::load(panel_id)?;
    let orders = fetch_orders(&api).await;
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for page in 1..=100 {
        let value = api
            .call(
                "/data",
                "getData",
                fields(&[
                    ("table", "sites".into()),
                    ("p", page.to_string()),
                    ("limit", "100".into()),
                    ("order", "id desc".into()),
                ]),
                false,
            )
            .await?;
        let rows = value
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| value.as_array())
            .ok_or("宝塔站点列表格式不受支持")?;
        for site in rows {
            let id = site
                .get("id")
                .and_then(Value::as_i64)
                .ok_or("面板站点标识无效")?;
            if !seen.insert(id) {
                return Err("面板分页返回重复站点，请检查面板版本".into());
            }
            let name = text(site, &["name"]).ok_or("面板站点名称无效")?;
            let (ssl, error) = match api
                .call(
                    "/site",
                    "GetSSL",
                    fields(&[("siteName", name.into())]),
                    false,
                )
                .await
            {
                Ok(value) => (value, None),
                Err(error) => (json!({}), Some(error)),
            };
            result.push(save_site(&api, site, &ssl, &orders, error)?);
        }
        if rows.len() < 100 {
            let conn = open_db()?;
            let stale = list_baota_site_certificates_inner(Some(panel_id))?;
            for site in stale {
                if !seen.contains(&site.site_id) {
                    conn.execute(
                        "DELETE FROM certificate_source_links WHERE id=?1",
                        [site.id],
                    )
                    .map_err(|_| "清理已移除站点失败")?;
                }
            }
            return Ok(result);
        }
    }
    Err("面板站点超过单次同步限制，未清理原有记录".into())
}

fn target(id: i64) -> Result<(i64, String, String), String> {
    let (panel_id, name, index): (Option<i64>, String, Option<String>) = open_db()?
        .query_row(
            "SELECT panel_id,site_name,order_index FROM certificate_source_links WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "站点证书记录不存在")?;
    Ok((
        panel_id.ok_or("来源面板已移除")?,
        name,
        index.ok_or("未确认该站点的 ACME 订单，不能直接续签或获取材料")?,
    ))
}

async fn verify_target(api: &Api, name: &str, index: &str) -> Result<Value, String> {
    sanitize_index(index)?;
    let ssl = api
        .call(
            "/site",
            "GetSSL",
            fields(&[("siteName", name.into())]),
            false,
        )
        .await?;
    let mut order = api
        .call(
            "/acme",
            "get_order_find",
            fields(&[("index", index.into())]),
            false,
        )
        .await?;
    order["index"] = json!(index);
    if matching_order(&ssl, &[order.clone()]).as_deref() != Some(index) {
        return Err("站点证书已发生变化，请重新同步后操作".into());
    }
    Ok(order)
}
fn order_material(value: &Value) -> Result<super::certificate_import::Material, String> {
    let pem = order_pem(value)
        .or_else(|| text(value, &["cert"]))
        .ok_or("面板未提供完整证书链")?;
    let key = text(value, &["private_key", "key"])
        .or_else(|| {
            value
                .get("cert")
                .and_then(|cert| text(cert, &["private_key", "key"]))
        })
        .ok_or("面板未提供私钥，此证书仅支持远端管理")?;
    parse_material(pem, key)
}

pub(crate) async fn import_baota_site_certificate_inner(
    id: i64,
) -> CertificateResult<CertificateListItem> {
    let (panel_id, name, index) = target(id)?;
    let api = Api::load(panel_id)?;
    let order = verify_target(&api, &name, &index).await?;
    let material = match order_material(&order) {
        Ok(material) => material,
        Err(_) => {
            let download = api
                .call("/acme", "download_cert", fields(&[("index", index)]), false)
                .await?;
            order_material(&download)?
        }
    };
    let saved = save_material(&material, "baota")?;
    open_db()?
        .execute(
            "UPDATE certificate_source_links SET certificate_id=?1 WHERE id=?2",
            params![saved.id, id],
        )
        .map_err(|_| "证书已保存，但站点关联保存失败")?;
    Ok(saved)
}

static WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationResult {
    pub renewed: bool,
    pub deployed: bool,
    pub message: String,
    pub site: SiteCertificate,
}

struct RemoteRenewal {
    after: Value,
    material: super::certificate_import::Material,
    ssl: Option<Value>,
    deployed: bool,
    message: String,
}

async fn renew_remote(
    api: &Api,
    name: &str,
    index: &str,
    domains: &[String],
) -> Result<RemoteRenewal, String> {
    let before = verify_target(api, name, index).await?;
    let old = order_pem(&before)
        .and_then(certificate_identity)
        .ok_or("无法核对原证书有效期，请先刷新站点")?;
    api.call(
        "/acme",
        "renew_cert",
        fields(&[("index", index.into())]),
        true,
    )
    .await?;
    let mut after = api
        .call(
            "/acme",
            "get_order_find",
            fields(&[("index", index.into())]),
            false,
        )
        .await
        .map_err(|_| "续签已提交，但结果读取失败，请先刷新站点确认，不要重复提交")?;
    after["index"] = json!(index);
    let material = match order_material(&after) {
        Ok(material) => material,
        Err(_) => {
            let download = api
                .call(
                    "/acme",
                    "download_cert",
                    fields(&[("index", index.into())]),
                    false,
                )
                .await
                .map_err(|_| "续签已提交，但材料读取失败，请先在面板确认结果")?;
            order_material(&download)?
        }
    };
    if old.0 == material.metadata.fingerprint || material.metadata.not_after <= old.2 {
        return Err("续签返回后证书有效期尚未更新，请刷新站点确认结果，不要重复提交".into());
    }
    let now = Utc::now().timestamp();
    if material.metadata.not_before > now || material.metadata.not_after <= now {
        return Err("面板返回的续签证书当前无效，请在面板检查结果".into());
    }
    if !domains
        .iter()
        .all(|domain| covers_domain(&material.metadata.domains, domain))
    {
        return Err("续签证书未覆盖站点全部域名，没有替换站点证书，请在面板检查")?;
    }
    if let Err(error) = api
        .call(
            "/acme",
            "SetCertToSite",
            fields(&[("index", index.into()), ("siteName", name.into())]),
            true,
        )
        .await
    {
        return Ok(RemoteRenewal {
            after,
            material,
            ssl: None,
            deployed: false,
            message: format!("证书已续签，但站点部署未完成：{error}"),
        });
    }
    let ssl = match api
        .call(
            "/site",
            "GetSSL",
            fields(&[("siteName", name.into())]),
            false,
        )
        .await
    {
        Ok(ssl) => ssl,
        Err(_) => {
            return Ok(RemoteRenewal {
                after,
                material,
                ssl: None,
                deployed: false,
                message: "证书已续签并提交部署，但站点回读失败，请刷新确认".into(),
            })
        }
    };
    let deployed = deployment_verified(&ssl, &material.metadata.fingerprint);
    Ok(RemoteRenewal {
        after,
        material,
        ssl: Some(ssl),
        deployed,
        message: if deployed {
            "证书已续签并验证站点部署"
        } else {
            "证书已续签，站点部署尚未确认，请刷新或在面板检查"
        }
        .into(),
    })
}

fn covers_domain(domains: &[String], domain: &str) -> bool {
    domains.iter().any(|cert| {
        cert.eq_ignore_ascii_case(domain)
            || cert.strip_prefix("*.").is_some_and(|suffix| {
                domain
                    .split_once('.')
                    .is_some_and(|(_, rest)| rest.eq_ignore_ascii_case(suffix))
            })
    })
}
fn deployment_verified(ssl: &Value, fingerprint: &str) -> bool {
    text(ssl, &["csr", "certificate"])
        .and_then(certificate_identity)
        .is_some_and(|identity| identity.0 == fingerprint)
        && ssl.get("status").and_then(Value::as_bool) == Some(true)
}

pub(crate) async fn renew_baota_site_certificate_inner(
    id: i64,
) -> CertificateResult<OperationResult> {
    let _guard = WRITE_LOCK
        .try_lock()
        .map_err(|_| "已有宝塔证书操作正在进行，请稍候")?;
    let (panel_id, name, index) = target(id)?;
    let api = Api::load(panel_id)?;
    let previous = list_baota_site_certificates_inner(Some(panel_id))?
        .into_iter()
        .find(|site| site.id == id)
        .ok_or("站点记录已移除")?;
    if previous.pending_renewal {
        return Err("上次续签结果待确认，请先核对面板结果再允许重试".into());
    }
    let result = match renew_remote(&api, &name, &index, &previous.site_domains).await {
        Ok(result) => result,
        Err(error) => {
            if error.contains("结果待确认")
                || error.contains("续签已提交")
                || error.contains("有效期尚未更新")
            {
                mark_pending(id)?;
            }
            return Err(error.into());
        }
    };
    let mut site = if let Some(ssl) = result.ssl {
        save_site(
            &api,
            &json!({"id":previous.site_id,"name":previous.site_name,"ps":previous.site_remark}),
            &ssl,
            &[result.after],
            None,
        )?
    } else {
        previous.clone()
    };
    let saved = save_material(&result.material, "baota")?;
    open_db()?
        .execute(
            "UPDATE certificate_source_links SET certificate_id=?1 WHERE id=?2",
            params![saved.id, id],
        )
        .map_err(|_| "续签已执行，本地关联待刷新")?;
    site.certificate_id = Some(saved.id);
    if !result.deployed {
        mark_pending(id)?;
        site.pending_renewal = true;
        site.can_renew = false;
    }
    Ok(OperationResult {
        renewed: true,
        deployed: result.deployed,
        message: result.message,
        site,
    })
}

fn mark_pending(id: i64) -> Result<(), String> {
    let conn = open_db()?;
    let raw: String = conn
        .query_row(
            "SELECT metadata_json FROM certificate_source_links WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| "保存续签待确认状态失败")?;
    let mut site: SiteCertificate = serde_json::from_str(&raw).map_err(|_| "读取续签状态失败")?;
    site.pending_renewal = true;
    site.can_renew = false;
    site.capability_reason = "续签结果待确认，请核对面板结果后再操作".into();
    conn.execute(
        "UPDATE certificate_source_links SET metadata_json=?1 WHERE id=?2",
        params![
            serde_json::to_string(&site).map_err(|_| "保存续签状态失败")?,
            id
        ],
    )
    .map_err(|_| "保存续签状态失败")?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn confirm_baota_certificate_retry(id: i64) -> PlatformResult<()> {
    let current = list_baota_site_certificates_inner(None)
        .map_err(crate::core::error::PlatformError::from)?
        .into_iter()
        .find(|site| site.id == id)
        .ok_or("站点记录不存在")?;
    let api = Api::load(current.panel_id.ok_or("来源面板已移除")?)?;
    api.call(
        "/site",
        "GetSSL",
        fields(&[("siteName", current.site_name)]),
        false,
    )
    .await?;
    let conn = open_db()?;
    let raw: String = conn
        .query_row(
            "SELECT metadata_json FROM certificate_source_links WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| "读取续签状态失败")?;
    let mut site: SiteCertificate = serde_json::from_str(&raw).map_err(|_| "读取续签状态失败")?;
    site.pending_renewal = false;
    site.can_renew = false;
    site.capability_reason = "已解除重试保护，请重新获取站点证书以核对订单".into();
    conn.execute(
        "UPDATE certificate_source_links SET metadata_json=?1 WHERE id=?2",
        params![
            serde_json::to_string(&site).map_err(|_| "保存续签状态失败")?,
            id
        ],
    )
    .map_err(|_| "保存续签状态失败")?;
    Ok(())
}

pub(crate) async fn deploy_certificate_to_baota_site_inner(
    id: i64,
    certificate_id: i64,
) -> CertificateResult<OperationResult> {
    let _guard = WRITE_LOCK
        .try_lock()
        .map_err(|_| "已有宝塔证书操作正在进行，请稍候")?;
    let current = list_baota_site_certificates_inner(None)?
        .into_iter()
        .find(|site| site.id == id)
        .ok_or("站点记录不存在")?;
    let api = Api::load(current.panel_id.ok_or("来源面板已移除")?)?;
    let conn = open_db()?;
    let (pem, key, _) = certificates::secret_material(&conn, certificate_id)?;
    drop(conn);
    let pem = Zeroizing::new(decrypt_secret(&pem)?);
    let key = Zeroizing::new(decrypt_secret(&key)?);
    let material = parse_material(&pem, &key)?;
    if material.metadata.not_before > Utc::now().timestamp()
        || material.metadata.not_after <= Utc::now().timestamp()
    {
        return Err("请选择当前有效的证书".into());
    }
    if !current
        .site_domains
        .iter()
        .all(|domain| covers_domain(&material.metadata.domains, domain))
    {
        return Err("证书没有覆盖站点全部域名".into());
    }
    api.call(
        "/site",
        "SetSSL",
        fields(&[
            ("siteName", current.site_name.clone()),
            ("key", key.to_string()),
            ("csr", pem.to_string()),
        ]),
        true,
    )
    .await?;
    let ssl = api
        .call(
            "/site",
            "GetSSL",
            fields(&[("siteName", current.site_name.clone())]),
            false,
        )
        .await?;
    let deployed = text(&ssl, &["csr", "certificate"])
        .and_then(certificate_identity)
        .is_some_and(|identity| identity.0 == material.metadata.fingerprint)
        && ssl.get("status").and_then(Value::as_bool) == Some(true);
    let site = save_site(
        &api,
        &json!({"id":current.site_id,"name":current.site_name,"ps":current.site_remark}),
        &ssl,
        &[],
        None,
    )?;
    if deployed {
        open_db()?
            .execute(
                "UPDATE certificate_source_links SET certificate_id=?1 WHERE id=?2",
                params![certificate_id, id],
            )
            .map_err(|_| "部署已执行，本地关联待刷新")?;
    }
    Ok(OperationResult {
        renewed: false,
        deployed,
        message: if deployed {
            "已部署并验证站点证书"
        } else {
            "部署已提交，站点证书尚未确认，请刷新或在面板检查"
        }
        .into(),
        site,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mock_api(responses: Vec<(&'static str, Value)>) -> (Api, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for (action, response) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                assert!(String::from_utf8_lossy(&request).contains(&format!("action={action}")));
                let body = serde_json::to_string(&response).unwrap();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
        });
        let panel = PanelConnection {
            id: 1,
            name: "fixture-panel".into(),
            panel_url: format!("http://{address}"),
            sort_order: 0,
            allow_insecure_tls: false,
            group_name: None,
            source_account_id: None,
            source_asset_key: None,
            api_key_saved: true,
            status: "unknown".into(),
            summary: json!({}),
            last_checked_at: None,
            last_error: None,
            remark: None,
            created_at: 1,
            updated_at: 1,
        };
        (
            Api {
                panel,
                key: Zeroizing::new("fixture-api-key".into()),
                client: reqwest::Client::new(),
            },
            server,
        )
    }
    fn fixture_order(year: i32) -> Value {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params =
            rcgen::CertificateParams::new(vec!["site.test".into(), "www.site.test".into()])
                .unwrap();
        params.not_after = rcgen::date_time_ymd(year, 1, 1);
        let cert = params.self_signed(&key).unwrap();
        json!({"index":"fixture-order","domains":["site.test","www.site.test"],"cert":{"fullchain":cert.pem(),"private_key":key.serialize_pem()}})
    }
    fn renewal_responses(before: &Value, after: &Value) -> Vec<(&'static str, Value)> {
        vec![
            (
                "GetSSL",
                json!({"status":true,"csr":order_pem(before).unwrap()}),
            ),
            ("get_order_find", before.clone()),
            ("renew_cert", json!({"status":true})),
            ("get_order_find", after.clone()),
        ]
    }
    #[tokio::test]
    async fn renews_and_proves_target_site_deployment() {
        let before = fixture_order(2030);
        let after = fixture_order(2031);
        let mut responses = renewal_responses(&before, &after);
        responses.extend([
            ("SetCertToSite", json!({"status":true})),
            (
                "GetSSL",
                json!({"status":true,"csr":order_pem(&after).unwrap()}),
            ),
        ]);
        let (api, server) = mock_api(responses);
        let result = renew_remote(
            &api,
            "site.test",
            "fixture-order",
            &["site.test".into(), "www.site.test".into()],
        )
        .await
        .unwrap();
        assert!(result.deployed);
        assert!(result.message.contains("验证站点部署"));
        server.join().unwrap();
    }
    #[tokio::test]
    async fn preserves_renewal_when_deployment_fails_without_echoing_vendor_response() {
        let before = fixture_order(2030);
        let after = fixture_order(2031);
        let mut responses = renewal_responses(&before, &after);
        responses.push((
            "SetCertToSite",
            json!({"status":false,"msg":"fixture-private-response"}),
        ));
        let (api, server) = mock_api(responses);
        let result = renew_remote(&api, "site.test", "fixture-order", &["site.test".into()])
            .await
            .unwrap();
        assert!(!result.deployed);
        assert!(result.ssl.is_none());
        assert!(result.message.contains("已续签"));
        assert!(!result.message.contains("fixture-private-response"));
        server.join().unwrap();
    }
    #[tokio::test]
    async fn refuses_unchanged_expiry_and_does_not_deploy_uncovered_domains() {
        let before = fixture_order(2030);
        let (api, server) = mock_api(renewal_responses(&before, &before));
        let error = renew_remote(&api, "site.test", "fixture-order", &["site.test".into()])
            .await
            .err()
            .unwrap();
        assert!(error.contains("有效期尚未更新"));
        server.join().unwrap();
        let after = fixture_order(2031);
        let (api, server) = mock_api(renewal_responses(&before, &after));
        let error = renew_remote(
            &api,
            "site.test",
            "fixture-order",
            &["uncovered.test".into()],
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("未覆盖站点全部域名"));
        server.join().unwrap();
    }
    #[tokio::test]
    async fn stale_readback_never_reports_deployed() {
        let before = fixture_order(2030);
        let after = fixture_order(2031);
        let mut responses = renewal_responses(&before, &after);
        responses.extend([
            ("SetCertToSite", json!({"status":true})),
            (
                "GetSSL",
                json!({"status":true,"csr":order_pem(&before).unwrap()}),
            ),
        ]);
        let (api, server) = mock_api(responses);
        let result = renew_remote(&api, "site.test", "fixture-order", &["site.test".into()])
            .await
            .unwrap();
        assert!(!result.deployed);
        assert!(result.message.contains("尚未确认"));
        server.join().unwrap();
    }
    #[tokio::test]
    async fn signed_api_preserves_disabled_ssl_state_and_redacts_business_errors() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for body in [
                r#"{"status":false,"csr":false,"key":false,"domain":[]}"#,
                r#"{"status":false,"msg":"fixture-private-response-must-not-leak"}"#,
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(header_end) =
                        request.windows(4).position(|part| part == b"\r\n\r\n")
                    {
                        let headers = String::from_utf8_lossy(&request[..header_end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= header_end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&request);
                assert!(request.contains("action=GetSSL"));
                assert!(request.contains("request_time="));
                assert!(request.contains("request_token="));
                assert!(!request.contains("fixture-api-key"));
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
        });
        let panel = PanelConnection {
            id: 1,
            name: "fixture-panel".into(),
            panel_url: format!("http://{address}"),
            sort_order: 0,
            allow_insecure_tls: false,
            group_name: None,
            source_account_id: None,
            source_asset_key: None,
            api_key_saved: true,
            status: "unknown".into(),
            summary: json!({}),
            last_checked_at: None,
            last_error: None,
            remark: None,
            created_at: 1,
            updated_at: 1,
        };
        let api = Api {
            panel,
            key: Zeroizing::new("fixture-api-key".into()),
            client: reqwest::Client::new(),
        };
        let disabled = api
            .call(
                "/site",
                "GetSSL",
                fields(&[("siteName", "site.test".into())]),
                false,
            )
            .await
            .unwrap();
        assert_eq!(disabled["status"], false);
        let error = api
            .call(
                "/site",
                "GetSSL",
                fields(&[("siteName", "site.test".into())]),
                false,
            )
            .await
            .unwrap_err();
        assert!(!error.contains("fixture-private-response"));
        server.join().unwrap();
    }
    #[test]
    fn only_matches_verified_certificate_identity() {
        let cert = rcgen::generate_simple_self_signed(vec!["site.test".into()]).unwrap();
        let other = rcgen::generate_simple_self_signed(vec!["site.test".into()]).unwrap();
        let ssl = json!({"status":true,"csr":cert.cert.pem(),"domain":[{"name":"site.test"}]});
        let orders = vec![
            json!({"index":"right","cert":{"fullchain":cert.cert.pem()}}),
            json!({"index":"wrong","cert":{"fullchain":other.cert.pem()}}),
        ];
        assert_eq!(matching_order(&ssl, &orders).as_deref(), Some("right"));
        assert!(matching_order(&json!({"domain":[{"name":"site.test"}]}), &orders).is_none());
        let duplicate = vec![
            orders[0].clone(),
            json!({"index":"duplicate","cert":{"fullchain":cert.cert.pem()}}),
        ];
        assert!(matching_order(&ssl, &duplicate).is_none());
    }
    #[test]
    fn parses_order_maps_and_rejects_injected_indexes() {
        assert_eq!(
            order_rows(&json!({"orders":{"abc":{"domains":["site.test"]}}}))[0]["index"],
            "abc"
        );
        assert!(sanitize_index("abc123").is_ok());
        assert!(sanitize_index("../secret").is_err());
    }
}

#[tauri::command]
pub(crate) fn list_baota_site_certificates(
    panel_id: Option<i64>,
) -> PlatformResult<Vec<SiteCertificate>> {
    list_baota_site_certificates_inner(panel_id).map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn sync_baota_site_certificates(
    panel_id: i64,
) -> PlatformResult<Vec<SiteCertificate>> {
    sync_baota_site_certificates_inner(panel_id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn import_baota_site_certificate(id: i64) -> PlatformResult<CertificateListItem> {
    import_baota_site_certificate_inner(id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn renew_baota_site_certificate(id: i64) -> PlatformResult<OperationResult> {
    renew_baota_site_certificate_inner(id)
        .await
        .map_err(Into::into)
}
#[tauri::command]
pub(crate) async fn deploy_certificate_to_baota_site(
    id: i64,
    certificate_id: i64,
) -> PlatformResult<OperationResult> {
    deploy_certificate_to_baota_site_inner(id, certificate_id)
        .await
        .map_err(Into::into)
}
