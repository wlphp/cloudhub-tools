// Private pipe bridge for the loopback API; no seeds in ordinary responses.
use super::*;
use serde_json::{json, Value};
use std::io::BufRead;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { op: String, args: Value }
fn field<T: serde::de::DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().ok_or("请求参数不完整")?).map_err(|_| "请求参数无效".into())
}
fn value<T: Serialize>(data: T) -> Result<Value, String> { serde_json::to_value(data).map_err(|_| "响应生成失败".into()) }
fn dispatch(store: &VaultStore, request: Request) -> Result<Value, String> {
    let args = request.args; let owner = "browser-api";
    match request.op.as_str() {
        "status" => {
            let mut db = open_db()?;
            let header = vault::initialize_device(&mut db, &vault::device_key_path()?)?;
            let required = header != vault::DEVICE_HEADER;
            if !required { access(store, owner, false, |_, _| Ok(()))?; }
            value(Status { initialized: true, unlocked: !required, password_required: required })
        }
        "unlock" => {
            let password = Zeroizing::new(field::<String>(&args, "password")?);
            let mut attempts = store.failed_unlock.lock().map_err(|_| "验证器状态不可用")?;
            if attempts.is_some_and(|time| time.elapsed() < Duration::from_secs(3)) { return Err("请等待 3 秒后重试密码".into()); }
            let mut db = open_db()?;
            let header = repository::header(&db)?.ok_or("密码库不存在")?;
            let key = match vault::migrate_device(&mut db, &vault::device_key_path()?, &header, &password) {
                Ok(key) => { *attempts = None; key }, Err(error) => { *attempts = Some(Instant::now()); return Err(error); }
            };
            *store.session.lock().map_err(|_| "验证器状态不可用")? = Some(Session { key, owner: owner.into(), header: vault::DEVICE_HEADER.into(), action: Instant::now(), poll: Instant::now(), stage: None });
            Ok(Value::Null)
        }
        "lock" => { store.lock(); Ok(Value::Null) }
        "list" => access(store, owner, false, |s, db| value(repository::load(db, &s.key)?.iter().map(Entry::summary).collect::<Vec<_>>())),
        "touch" => access(store, owner, true, |_, _| Ok(Value::Null)),
        "save" => access(store, owner, true, |s, db| { save_entry(s, db, field(&args, "input")?)?; Ok(Value::Null) }),
        "remove" => access(store, owner, true, |_, db| { repository::remove(db, &field::<Vec<String>>(&args, "ids")?)?; Ok(Value::Null) }),
        "advance" => access(store, owner, true, |s, db| {
            let id: String = field(&args, "id")?;
            let tx = db.transaction().map_err(|_| "无法开始计数事务")?;
            let mut entry = repository::selected(&tx, &s.key, &[id])?.pop().ok_or("验证码不存在")?;
            if entry.kind != "hotp" { return Err("此验证码不是 HOTP".into()); }
            entry.counter = entry.counter.checked_add(1).ok_or("HOTP 计数无法推进")?;
            repository::write(&tx, &s.key, &entry)?; tx.commit().map_err(|_| "HOTP 计数提交失败")?;
            Ok(Value::Null)
        }),
        "codes" => access(store, owner, false, |s, db| {
            let ids: Vec<String> = field(&args, "ids")?;
            if ids.len() > 250 { return Err("单次最多显示 250 个验证码".into()); }
            let now = chrono::Utc::now().timestamp().max(0) as u64; let mut codes = vec![];
            for entry in repository::selected(db, &s.key, &ids)? {
                let counter = if entry.kind == "hotp" { entry.counter } else { now / entry.period };
                codes.push(Code { id: entry.id.clone(), current: otp::generate(&entry, counter)?, next: if entry.kind == "hotp" { None } else { Some(otp::generate(&entry, counter + 1)?) }, remaining: if entry.kind == "hotp" { 0 } else { entry.period - now % entry.period }, period: entry.period, counter: entry.counter.to_string() });
            }
            value(codes)
        }),
        "prepare" => {
            let password = Zeroizing::new(field::<String>(&args, "password")?);
            let content = if let Some(image) = args.get("image").filter(|v| !v.is_null()) {
                let bytes = Zeroizing::new(serde_json::from_value::<Vec<u8>>(image.clone()).map_err(|_| "图片参数无效")?); decode_qr(&bytes)?
            } else { Zeroizing::new(field::<String>(&args, "text")?) };
            if content.len() > MAX_FILE_BYTES { return Err("文件不能超过 10 MiB".into()); }
            let parsed = formats::parse_file(&content, &password)?;
            access(store, owner, true, |s, db| {
                let mut seen = repository::load(db, &s.key)?; let mut items = vec![];
                for entry in &parsed.entries {
                    let duplicate = seen.iter().find(|old| old.same_seed(entry));
                    let conflict = duplicate.is_some_and(|old| old.counter != entry.counter) || seen.iter().any(|old| old.issuer == entry.issuer && old.account == entry.account && !old.same_seed(entry));
                    items.push(PreviewItem { entry: entry.summary(), duplicate_id: duplicate.map(|old| old.id.clone()), conflict }); seen.push(entry.clone());
                }
                let token = uuid::Uuid::new_v4().to_string();
                s.stage = Some(Stage { id: token.clone(), entries: parsed.entries, created: Instant::now() });
                value(Preview { token, items, errors: parsed.errors, format: parsed.format })
            })
        }
        "import" => access(store, owner, true, |s, db| value(apply_import(s, db, &field::<String>(&args, "token")?, &field::<Vec<ImportChoice>>(&args, "choices")?)?)),
        "cancel" => access(store, owner, false, |s, _| { s.stage = None; Ok(Value::Null) }),
        "export" => access(store, owner, true, |s, db| {
            let ids: Vec<String> = field(&args, "ids")?; let format: String = field(&args, "format")?;
            if ids.is_empty() || ids.len() > MAX_ENTRIES || !["cloudhub", "ente", "plain"].contains(&format.as_str()) { return Err("导出选择或格式无效".into()); }
            if format == "plain" && !field::<bool>(&args, "acknowledgePlain")? { return Err("明文导出必须确认密钥泄露风险".into()); }
            let password = Zeroizing::new(field::<String>(&args, "password")?);
            let entries = repository::selected(db, &s.key, &ids)?;
            if entries.len() != ids.iter().collect::<HashSet<_>>().len() { return Err("导出选择已失效".into()); }
            let data = formats::export(&entries, &format, &password)?;
            Ok(json!({ "content": std::str::from_utf8(&data).map_err(|_| "导出编码失败")?, "filename": format!("cloudhub-auth-{}.{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"), if format == "plain" { "txt" } else { "json" }) }))
        }),
        _ => Err("验证器操作无效".into()),
    }
}
pub(crate) fn run() {
    let store = VaultStore::default();
    let expiry_store = store.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if let Ok(mut guard) = expiry_store.session.lock() {
            if guard.as_ref().is_some_and(|session| session.action.elapsed() > Duration::from_secs(300) || session.poll.elapsed() > Duration::from_secs(30)) { *guard = None; }
        }
    });
    let stdin = std::io::stdin(); let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break }; let line = Zeroizing::new(line);
        let result = if line.len() > 48 * 1024 * 1024 { Err("请求过大".into()) } else {
            serde_json::from_str::<Request>(&line).map_err(|_| "请求格式无效".into()).and_then(|request| dispatch(&store, request))
        };
        let response = match result { Ok(result) => json!({"result": result}), Err(error) => json!({"error": error, "code": if error.contains("锁定") { "authenticator-locked" } else { "authenticator-error" }}) };
        if writeln!(stdout, "{}", response).and_then(|_| stdout.flush()).is_err() { break; }
    }
    store.lock();
}
