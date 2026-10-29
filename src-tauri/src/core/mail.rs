//! Native mail operations. Upstream errors are never exposed as they may contain credentials.
use crate::core::{
    crypto::{decrypt_secret, encrypt_secret},
    database::open_db,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use lettre::{
    message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    Message, SmtpTransport, Transport,
};
use mailparse::MailHeaderMap;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    panic::{catch_unwind, AssertUnwindSafe},
    time::Duration,
};
use std::sync::Mutex;
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;
const MAX_MESSAGE: u32 = 20 * 1024 * 1024;
const MAX_TRANSFER: usize = 8 * 1024 * 1024;
static PENDING_IMPORT: Mutex<Option<(String, Vec<TransferAccount>)>> = Mutex::new(None);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub email: String,
    pub username: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    #[serde(flatten)]
    pub account: Account,
    pub password: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferAccount { account: Account, password: String }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferPackage { format: String, version: u32, accounts: Vec<TransferAccount> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    uid: u32,
    subject: String,
    from: String,
    date: String,
    unread: bool,
    size: u32,
}
#[derive(Serialize)]
pub struct Listing {
    validity: u32,
    total: u32,
    messages: Vec<Summary>,
}
#[derive(Serialize)]
pub struct PartInfo {
    index: usize,
    name: String,
    size: usize,
}
#[derive(Serialize)]
pub struct ReadMessage {
    subject: String,
    from: String,
    to: String,
    date: String,
    body: String,
    attachments: Vec<PartInfo>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    imap: bool,
    smtp: bool,
    imap_error: Option<String>,
    smtp_error: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileInput {
    name: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Draft {
    to: String,
    subject: String,
    body: String,
    attachments: Vec<FileInput>,
}
fn db() -> Result<rusqlite::Connection, String> {
    open_db().map_err(|_| "无法打开邮件数据库".into())
}
pub fn accounts() -> Result<Vec<Account>, String> {
    let conn = db()?;
    let mut stmt = conn
        .prepare("SELECT config FROM mail_accounts ORDER BY rowid")
        .map_err(|_| "读取邮箱失败")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| "读取邮箱失败")?;
    rows.map(|r| {
        serde_json::from_str(&r.map_err(|_| "读取邮箱失败")?).map_err(|_| "邮箱配置损坏".into())
    })
    .collect()
}

pub fn prepare_import(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    *PENDING_IMPORT.lock().map_err(|_| "导入状态不可用")? = None;
    let Some(file) = app.dialog().file().add_filter("邮箱 JSON", &["json"]).blocking_pick_file() else { return Ok(serde_json::Value::Null); };
    let path = file.into_path().map_err(|_| "导入路径无效")?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| "无法读取导入文件")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() as usize > MAX_TRANSFER { return Err("请选择不超过 8 MB 的普通 JSON 文件".into()); }
    let bytes = std::fs::read(&path).map_err(|_| "无法读取导入文件")?;
    let package: TransferPackage = serde_json::from_slice(&bytes).map_err(|_| "文件格式无效，请选择 CloudHub 邮箱导出文件")?;
    if package.format != "cloudhub-mail-accounts" || package.version != 1 || package.accounts.is_empty() || package.accounts.len() > 500 { return Err("文件版本或邮箱数量无效（支持 1–500 条）".into()); }
    for item in &package.accounts { validate(&item.account)?; if item.password.is_empty() || item.password.len() > 4096 || item.password.chars().any(char::is_control) { return Err("导入文件包含无效的邮箱凭据".into()); } }
    let token = uuid::Uuid::new_v4().to_string();
    let summaries = package.accounts.iter().enumerate().map(|(index, item)| serde_json::json!({"index": index, "name": item.account.name, "email": item.account.email, "username": item.account.username})).collect::<Vec<_>>();
    *PENDING_IMPORT.lock().map_err(|_| "导入状态不可用")? = Some((token.clone(), package.accounts));
    Ok(serde_json::json!({"token": token, "accounts": summaries}))
}
pub fn import_selected(token: &str, indices: &[usize]) -> Result<serde_json::Value, String> {
    if indices.is_empty() || indices.len() > 500 { return Err("请选择要导入的邮箱".into()); }
    let mut pending = PENDING_IMPORT.lock().map_err(|_| "导入状态不可用")?;
    let (saved_token, incoming) = pending.as_ref().ok_or("导入预览已失效，请重新选择文件")?;
    if saved_token != token { return Err("导入预览已失效，请重新选择文件".into()); }
    let conn = db()?;
    let existing = accounts()?;
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始导入")?;
    let mut seen = std::collections::HashSet::new(); let mut imported = 0usize;
    for index in indices {
        if !seen.insert(index) { return Err("导入选择包含重复项".into()); }
        let item = incoming.get(*index).ok_or("导入选择已失效")?;
        if existing.iter().any(|old| old.email == item.account.email && old.username == item.account.username && old.imap_host == item.account.imap_host && old.smtp_host == item.account.smtp_host) { continue; }
        let mut account = item.account.clone(); account.id = uuid::Uuid::new_v4().to_string();
        let json = serde_json::to_string(&account).map_err(|_| "邮箱配置无效")?;
        let secret = Zeroizing::new(item.password.clone());
        let cipher = encrypt_secret(&secret).map_err(|_| "加密邮箱凭据失败")?;
        tx.execute("INSERT INTO mail_accounts(id,config,secret_ciphertext) VALUES(?1,?2,?3)", params![account.id, json, cipher]).map_err(|_| "导入保存失败，未修改记录")?;
        imported += 1;
    }
    tx.commit().map_err(|_| "导入保存失败，未修改记录")?; *pending = None;
    Ok(serde_json::json!({"imported": imported, "skipped": indices.len() - imported}))
}
pub fn export_selected(app: &tauri::AppHandle, ids: &[String], acknowledge_plain: bool) -> Result<bool, String> {
    if !acknowledge_plain { return Err("导出明文邮箱授权码前必须确认风险".into()); }
    if ids.is_empty() || ids.len() > 500 { return Err("请选择 1–500 个邮箱导出".into()); }
    let conn = db()?; let mut selected = Vec::new(); let mut seen = std::collections::HashSet::new();
    for id in ids { if !seen.insert(id) { return Err("选择包含重复记录".into()); } let (config, secret): (String, String) = conn.query_row("SELECT config,secret_ciphertext FROM mail_accounts WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|_| "所选邮箱不存在，请刷新后重试")?; let account: Account = serde_json::from_str(&config).map_err(|_| "邮箱配置损坏")?; selected.push(TransferAccount { account, password: decrypt_secret(&secret).map_err(|_| "解密邮箱凭据失败")? }); }
    let Some(file) = app.dialog().file().set_file_name("cloudhub-mail-accounts.json").add_filter("邮箱 JSON（含明文授权码）", &["json"]).blocking_save_file() else { return Ok(false); };
    let path = file.into_path().map_err(|_| "导出路径无效")?;
    let bytes = Zeroizing::new(serde_json::to_vec_pretty(&TransferPackage { format: "cloudhub-mail-accounts".into(), version: 1, accounts: selected }).map_err(|_| "导出失败")?);
    if bytes.len() > MAX_TRANSFER { return Err("导出内容超过 8 MB，请分批导出".into()); }
    std::fs::write(path, bytes.as_slice()).map_err(|_| "无法保存导出文件")?; Ok(true)
}
fn validate(a: &Account) -> Result<(), String> {
    if a.name.trim().is_empty()
        || a.name.len() > 100
        || a.username.is_empty()
        || a.username.len() > 320
        || a.username.chars().any(char::is_control)
        || a.email.parse::<Mailbox>().is_err()
    {
        return Err("请输入有效的邮箱名称、地址和登录用户名".into());
    }
    for host in [&a.imap_host, &a.smtp_host] {
        if host.is_empty()
            || host.len() > 253
            || !host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-:".contains(&c))
        {
            return Err("服务器地址只能填写域名或 IP，不含协议与路径".into());
        }
    }
    if a.imap_port == 0
        || a.smtp_port == 0
        || !["tls", "starttls"].contains(&a.smtp_security.as_str())
    {
        return Err("端口或加密方式无效".into());
    }
    Ok(())
}
pub fn save(mut input: AccountInput) -> Result<Account, String> {
    validate(&input.account)?;
    let conn = db()?;
    let secret = Zeroizing::new(std::mem::take(&mut input.password));
    if secret.len() > 4096 || secret.chars().any(char::is_control) {
        return Err("授权码格式无效".into());
    }
    let cipher = if input.account.id.is_empty() {
        if secret.is_empty() {
            return Err("请输入客户端授权码或应用专用密码".into());
        }
        input.account.id = uuid::Uuid::new_v4().to_string();
        encrypt_secret(&secret).map_err(|_| "加密邮箱凭据失败")?
    } else {
        let previous: (String, String) = conn
            .query_row(
                "SELECT config,secret_ciphertext FROM mail_accounts WHERE id=?1",
                [&input.account.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| "邮箱不存在，请刷新")?;
        let old: Account = serde_json::from_str(&previous.0).map_err(|_| "邮箱配置损坏")?;
        if secret.is_empty() {
            if old.email != input.account.email
                || old.username != input.account.username
                || old.imap_host != input.account.imap_host
                || old.imap_port != input.account.imap_port
                || old.smtp_host != input.account.smtp_host
                || old.smtp_port != input.account.smtp_port
                || old.smtp_security != input.account.smtp_security
            {
                return Err("连接参数变更后请重新输入授权码".into());
            }
            previous.1
        } else {
            encrypt_secret(&secret).map_err(|_| "加密邮箱凭据失败")?
        }
    };
    let json = serde_json::to_string(&input.account).map_err(|_| "邮箱配置无效")?;
    conn.execute("INSERT INTO mail_accounts(id,config,secret_ciphertext) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET config=excluded.config,secret_ciphertext=excluded.secret_ciphertext",params![input.account.id,json,cipher]).map_err(|_| "保存邮箱失败")?;
    Ok(input.account)
}
pub fn remove(id: &str) -> Result<(), String> {
    db()?
        .execute("DELETE FROM mail_accounts WHERE id=?1", [id])
        .map_err(|_| "移除邮箱失败")?;
    Ok(())
}
fn load(id: &str) -> Result<(Account, Zeroizing<String>), String> {
    let row: (String, String) = db()?
        .query_row(
            "SELECT config,secret_ciphertext FROM mail_accounts WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "邮箱不存在，请刷新")?;
    let a: Account = serde_json::from_str(&row.0).map_err(|_| "邮箱配置损坏")?;
    validate(&a)?;
    Ok((
        a,
        Zeroizing::new(decrypt_secret(&row.1).map_err(|_| "解密邮箱凭据失败，请重新配置")?),
    ))
}
// Cap cumulative response bytes as RFC822.SIZE from remote servers is untrusted.
struct BoundedStream {
    inner: native_tls::TlsStream<TcpStream>,
    remaining: usize,
}
impl Read for BoundedStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "mail response limit",
            ));
        }
        let len = buffer.len().min(self.remaining);
        let n = self.inner.read(&mut buffer[..len])?;
        self.remaining -= n;
        Ok(n)
    }
}
impl Write for BoundedStream {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.inner.write(b)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
type Session = imap::Session<BoundedStream>;

/// Explicit user-requested reveal; never included in account list responses.
pub fn reveal_secret(id: &str) -> Result<String, String> {
    let (_, secret) = load(id)?;
    Ok(secret.to_string())
}
fn connect(a: &Account, password: &str) -> Result<Session, String> {
    let addrs = (a.imap_host.as_str(), a.imap_port)
        .to_socket_addrs()
        .map_err(|_| "IMAP 地址解析失败")?;
    let mut socket = None;
    for addr in addrs.take(3) {
        if let Ok(s) = TcpStream::connect_timeout(&addr, Duration::from_secs(8)) {
            socket = Some(s);
            break;
        }
    }
    let socket = socket.ok_or("IMAP 连接失败，请检查地址、端口和网络")?;
    socket
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|_| "IMAP 超时设置失败")?;
    socket
        .set_write_timeout(Some(Duration::from_secs(20)))
        .map_err(|_| "IMAP 超时设置失败")?;
    let tls = native_tls::TlsConnector::new()
        .map_err(|_| "TLS 初始化失败")?
        .connect(&a.imap_host, socket)
        .map_err(|_| "IMAP TLS 证书校验或握手失败")?;
    let mut client = imap::Client::new(BoundedStream {
        inner: tls,
        remaining: 32 * 1024 * 1024,
    });
    imap_stage("读取欢迎信息", || {
        client.read_greeting().map_err(|_| "IMAP 服务器响应无效".into())
    })?;
    let session = imap_stage("登录", || {
        client
            .login(&a.username, password)
            .map_err(|_| "IMAP 登录失败，请检查授权码、客户端服务或账号策略".into())
    })?;
    // Do not send the optional IMAP ID extension. The imap 2.x response parser
    // does not understand `* ID ...`; ignoring that command's error leaves its
    // tagged completion unread, so the following SELECT can panic on a tag
    // mismatch (observed with QQ Mail).
    Ok(session)
}
fn imap_stage<T>(stage: &str, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(action)) {
        Ok(result) => result,
        Err(_) => Err(format!(
            "IMAP 服务器在{stage}时返回了无法处理的响应，请检查邮箱服务兼容性"
        )),
    }
}
fn smtp(a: &Account, password: &str) -> Result<SmtpTransport, String> {
    let builder = if a.smtp_security == "starttls" {
        SmtpTransport::starttls_relay(&a.smtp_host)
    } else {
        SmtpTransport::relay(&a.smtp_host)
    }
    .map_err(|_| "SMTP TLS 配置无效")?;
    Ok(builder
        .port(a.smtp_port)
        .credentials(Credentials::new(a.username.clone(), password.to_string()))
        .timeout(Some(Duration::from_secs(30)))
        .build())
}
pub fn test(id: &str) -> Result<ConnectionTest, String> {
    let (a, p) = load(id)?;
    // Some IMAP/SMTP servers can trigger assertions in protocol libraries when
    // they send an unexpected response. Keep each probe isolated so the other
    // protocol still reports its result, and never expose panic payloads that
    // may contain untrusted server data.
    let imap_result = catch_unwind(AssertUnwindSafe(|| {
        let mut session = connect(&a, &p)?;
        imap_stage("退出登录", || {
            session.logout().map_err(|_| "IMAP 退出登录失败".into())
        })?;
        Ok::<(), String>(())
    }))
    .unwrap_or_else(|_| Err("IMAP 检测遇到无法识别的服务器响应".into()));

    let smtp_result = catch_unwind(AssertUnwindSafe(|| {
        let transport = smtp(&a, &p)?;
        match transport.test_connection() {
            Ok(true) => Ok(()),
            Ok(false) => Err("SMTP 连接或认证失败，请检查服务器、端口和授权码".into()),
            Err(_) => Err("SMTP 连接失败，请检查服务器、端口和网络".into()),
        }
    }))
    .unwrap_or_else(|_| Err("SMTP 检测遇到无法识别的服务器响应".into()));

    Ok(ConnectionTest {
        imap: imap_result.is_ok(),
        smtp: smtp_result.is_ok(),
        imap_error: imap_result.err(),
        smtp_error: smtp_result.err(),
    })
}
pub fn folders(id: &str) -> Result<Vec<String>, String> {
    let (a, p) = load(id)?;
    let mut s = connect(&a, &p)?;
    let items = s.list(None, Some("*")).map_err(|_| "读取邮件文件夹失败")?;
    let mut names = vec!["INBOX".to_string()];
    for n in items.iter().take(200) {
        if !n
            .attributes()
            .iter()
            .any(|v| matches!(v, imap::types::NameAttribute::NoSelect))
            && n.name() != "INBOX"
        {
            names.push(n.name().to_string());
        }
    }
    let _ = s.logout();
    Ok(names)
}
fn folder_valid(folder: &str) -> Result<(), String> {
    if folder.is_empty() || folder.len() > 1024 || folder.chars().any(char::is_control) {
        Err("邮件文件夹无效".into())
    } else {
        Ok(())
    }
}
fn header(raw: &[u8], name: &str) -> String {
    mailparse::parse_headers(raw)
        .ok()
        .and_then(|(h, _)| h.get_first_value(name))
        .unwrap_or_default()
        .chars()
        .take(2000)
        .collect()
}
pub fn list(id: &str, folder: &str) -> Result<Listing, String> {
    folder_valid(folder)?;
    let (a, p) = load(id)?;
    let mut s = imap_stage("建立连接并登录", || connect(&a, &p))?;
    let m = imap_stage("打开邮件文件夹", || {
        s.select(folder).map_err(|_| "打开邮件文件夹失败".into())
    })?;
    let mut messages = Vec::new();
    if m.exists > 0 {
        let range = format!("{}:*", m.exists.saturating_sub(49).max(1));
        let fetched = imap_stage("读取邮件头", || {
            s.fetch(range, "(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])")
                .map_err(|_| "读取邮件列表失败".into())
        })?;
        for f in fetched.iter() {
            let raw = f.header().unwrap_or_default();
            if let Some(uid) = f.uid {
                messages.push(Summary {
                    uid,
                    subject: header(raw, "Subject"),
                    from: header(raw, "From"),
                    date: header(raw, "Date"),
                    unread: !f
                        .flags()
                        .iter()
                        .any(|v| matches!(v, imap::types::Flag::Seen)),
                    size: f.size.unwrap_or(0),
                });
            }
        }
        messages.reverse();
    }
    let _ = s.logout();
    Ok(Listing {
        validity: m.uid_validity.unwrap_or(0),
        total: m.exists,
        messages,
    })
}
fn raw(id: &str, folder: &str, validity: u32, uid: u32) -> Result<Vec<u8>, String> {
    folder_valid(folder)?;
    if uid == 0 {
        return Err("邮件标识无效".into());
    }
    let (a, p) = load(id)?;
    let mut s = connect(&a, &p)?;
    let m = s.select(folder).map_err(|_| "打开邮件文件夹失败")?;
    if m.uid_validity.unwrap_or(0) != validity {
        return Err("文件夹状态已变化，请刷新列表".into());
    }
    let key = uid.to_string();
    let size = s
        .uid_fetch(&key, "RFC822.SIZE")
        .map_err(|_| "读取邮件大小失败")?;
    let size = size
        .iter()
        .find(|f| f.uid == Some(uid))
        .and_then(|f| f.size)
        .ok_or("邮件已不存在，请刷新")?;
    if size > MAX_MESSAGE {
        return Err("首版仅支持阅读 20 MiB 以内的邮件，请使用网页版查看".into());
    }
    let data = s
        .uid_fetch(&key, "BODY.PEEK[]")
        .map_err(|_| "读取邮件失败")?;
    let bytes = data
        .iter()
        .find(|f| f.uid == Some(uid))
        .and_then(|f| f.body())
        .ok_or("邮件正文不存在")?
        .to_vec();
    let _ = s.uid_store(&key, r"+FLAGS.SILENT (\Seen)");
    let _ = s.logout();
    Ok(bytes)
}
fn visit<'a>(mail: &'a mailparse::ParsedMail<'a>, leaves: &mut Vec<&'a mailparse::ParsedMail<'a>>) {
    if mail.subparts.is_empty() {
        leaves.push(mail)
    } else {
        for p in &mail.subparts {
            visit(p, leaves)
        }
    }
}
pub fn read(id: &str, folder: &str, validity: u32, uid: u32) -> Result<ReadMessage, String> {
    let bytes = raw(id, folder, validity, uid)?;
    parse_message(&bytes)
}
fn parse_message(bytes: &[u8]) -> Result<ReadMessage, String> {
    let mail = mailparse::parse_mail(bytes).map_err(|_| "邮件格式无法解析")?;
    let mut leaves = Vec::new();
    visit(&mail, &mut leaves);
    let mut body = String::new();
    let mut attachments = Vec::new();
    for (index, p) in leaves.iter().enumerate() {
        let disposition = p.get_content_disposition();
        let name = disposition
            .params
            .get("filename")
            .or_else(|| p.ctype.params.get("name"));
        if name.is_some() || disposition.disposition == mailparse::DispositionType::Attachment {
            attachments.push(PartInfo {
                index,
                name: name
                    .cloned()
                    .unwrap_or_else(|| format!("附件-{}", index + 1)),
                size: p.get_body_raw().map(|v| v.len()).unwrap_or(0),
            });
        } else if p.ctype.mimetype == "text/plain" {
            body.push_str(&p.get_body().unwrap_or_default());
            body.push('\n');
        }
    }
    if body.is_empty() {
        body="此邮件没有纯文本正文。首版为保护隐私不加载 HTML 或远程图片，请在邮箱网页版查看完整内容。".into();
    }
    Ok(ReadMessage {
        subject: header(&bytes, "Subject"),
        from: header(&bytes, "From"),
        to: header(&bytes, "To"),
        date: header(&bytes, "Date"),
        body,
        attachments,
    })
}
pub fn attachment(
    id: &str,
    folder: &str,
    validity: u32,
    uid: u32,
    index: usize,
) -> Result<(String, Vec<u8>), String> {
    let bytes = raw(id, folder, validity, uid)?;
    let mail = mailparse::parse_mail(&bytes).map_err(|_| "邮件格式无法解析")?;
    let mut leaves = Vec::new();
    visit(&mail, &mut leaves);
    let part = leaves.get(index).ok_or("附件不存在")?;
    let disposition = part.get_content_disposition();
    let name = disposition
        .params
        .get("filename")
        .or_else(|| part.ctype.params.get("name"))
        .cloned()
        .unwrap_or_else(|| "attachment.bin".into());
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(150)
        .collect();
    Ok((
        if safe.trim_matches('.').trim().is_empty() {
            "attachment.bin".into()
        } else {
            safe
        },
        part.get_body_raw().map_err(|_| "附件解码失败")?,
    ))
}
pub fn send(id: &str, draft: Draft) -> Result<(), String> {
    let (a, p) = load(id)?;
    let message = build_message(&a, draft)?;
    smtp(&a, &p)?.send(&message).map_err(|_| {
        "发送未获确认。请先检查邮箱已发送记录，避免重复发送；并检查 SMTP 授权与网络"
    })?;
    Ok(())
}
fn build_message(a: &Account, draft: Draft) -> Result<Message, String> {
    if draft.to.len() > 4000
        || draft.subject.len() > 998
        || draft.subject.contains(['\r', '\n'])
        || draft.body.len() > 2 * 1024 * 1024
        || draft.attachments.len() > 10
    {
        return Err("邮件主题、正文或附件数量超限".into());
    }
    let mut builder = Message::builder()
        .from(a.email.parse::<Mailbox>().map_err(|_| "发件地址无效")?)
        .subject(&draft.subject);
    let recipients: Vec<_> = draft
        .to
        .split([';', ','])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if recipients.is_empty() || recipients.len() > 50 {
        return Err("请输入 1 至 50 个收件地址".into());
    }
    for address in recipients {
        builder = builder.to(address
            .parse::<Mailbox>()
            .map_err(|_| "收件地址无效，请使用逗号分隔")?);
    }
    let mut multipart = MultiPart::mixed().singlepart(SinglePart::plain(draft.body));
    let mut total = 0;
    for file in draft.attachments {
        if file.name.is_empty()
            || file.name.len() > 255
            || file.name.chars().any(char::is_control)
            || file.data.len() > 14 * 1024 * 1024
        {
            return Err("附件名称或大小无效".into());
        }
        let data = STANDARD.decode(file.data).map_err(|_| "附件数据无效")?;
        total += data.len();
        if total > 10 * 1024 * 1024 {
            return Err("附件总大小不能超过 10 MiB".into());
        }
        multipart = multipart.singlepart(Attachment::new(file.name).body(
            data,
            ContentType::parse("application/octet-stream").map_err(|_| "附件类型无效")?,
        ));
    }
    builder
        .multipart(multipart)
        .map_err(|_| "邮件内容无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account() -> Account {
        Account {
            id: String::new(),
            name: "测试邮箱".into(),
            email: "reader@example.test".into(),
            username: "reader@example.test".into(),
            imap_host: "imap.example.test".into(),
            imap_port: 993,
            smtp_host: "smtp.example.test".into(),
            smtp_port: 465,
            smtp_security: "tls".into(),
        }
    }
    #[test]
    fn rejects_invalid_hosts_and_unencrypted_modes() {
        let mut a = account();
        assert!(validate(&a).is_ok());
        a.imap_host = "https://mail.example.test/path".into();
        assert!(validate(&a).is_err());
        a.imap_host = "imap.example.test".into();
        a.smtp_security = "plain".into();
        assert!(validate(&a).is_err());
        assert!(folder_valid("INBOX\r\nLOGOUT").is_err());
    }
    #[test]
    fn decodes_mime_subject_body_and_attachment_without_html_execution() {
        let raw = concat!("From: sender@example.test\r\nTo: reader@example.test\r\nSubject: =?UTF-8?B?5rWL6K+V?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=sample\r\n\r\n",
            "--sample\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello <script>ignored</script>\r\n",
            "--sample\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=hello.txt\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--sample--\r\n");
        let parsed = parse_message(raw.as_bytes()).unwrap();
        assert_eq!(parsed.subject, "测试");
        assert!(parsed.body.contains("<script>ignored</script>"));
        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(parsed.attachments[0].name, "hello.txt");
        assert_eq!(parsed.attachments[0].size, 5);
    }
    #[test]
    fn composes_mime_and_rejects_header_injection_and_oversized_files() {
        let a = account();
        let draft = || Draft {
            to: "one@example.test;two@example.test".into(),
            subject: "测试".into(),
            body: "正文".into(),
            attachments: vec![FileInput {
                name: "hello.txt".into(),
                data: STANDARD.encode(b"hello"),
            }],
        };
        let msg = build_message(&a, draft()).unwrap();
        let formatted = String::from_utf8(msg.formatted()).unwrap();
        assert!(formatted.contains("hello.txt"));
        assert!(formatted.contains("one@example.test"));
        let mut invalid = draft();
        invalid.subject = "test\r\nBcc: other@example.test".into();
        assert!(build_message(&a, invalid).is_err());
        let mut large = draft();
        large.attachments[0].data = "A".repeat(14 * 1024 * 1024 + 1);
        assert!(build_message(&a, large).is_err());
    }
}
