use crate::core::error::{PlatformError, PlatformResult};
use crate::core::{
    authenticator::{
        formats, otp,
        vault::{self, Code, Preview, PreviewItem, Session, Stage, Status, VaultStore},
        Entry, EntrySummary, MAX_ENTRIES, MAX_FILE_BYTES,
    },
    database::open_db,
    repositories::authenticator as repository,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    time::{Duration, Instant},
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

async fn work<T: Send + 'static, F: FnOnce() -> Result<T, String> + Send + 'static>(
    f: F,
) -> PlatformResult<T> {
    // All domain errors are authored here and never interpolate parser/IO error values or OTP input.
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "验证器任务执行失败".to_string())
        .and_then(|result| result)
        .map_err(|message| PlatformError {
            kind: "platform-error",
            code: if message.contains("锁定") {
                "authenticator-locked"
            } else {
                "authenticator-error"
            },
            message,
            retryable: false,
        })
}
fn access<T>(
    store: &VaultStore,
    owner: &str,
    touch: bool,
    f: impl FnOnce(&mut Session, &mut rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut db = open_db()?;
    let header = repository::header(&db)?.ok_or("请先创建验证器密码库")?;
    let mut guard = store.session.lock().map_err(|_| "验证器状态不可用")?;
    if header == vault::DEVICE_HEADER
        && !guard
            .as_mut()
            .is_some_and(|s| s.authorize(owner, &header, touch).is_ok())
    {
        *guard = Some(Session {
            key: vault::read_device_key(&vault::device_key_path()?)?,
            owner: owner.into(),
            header: header.clone(),
            action: Instant::now(),
            poll: Instant::now(),
            stage: None,
        });
    }
    let valid = guard
        .as_mut()
        .ok_or("验证器已锁定，请重新解锁")?
        .authorize(owner, &header, touch);
    if let Err(reason) = valid {
        *guard = None;
        return Err(reason);
    }
    f(guard.as_mut().ok_or("验证器已锁定")?, &mut db)
}

#[tauri::command]
pub(crate) async fn authenticator_status(
    window: tauri::Window,
    state: State<'_, VaultStore>,
) -> PlatformResult<Status> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        let mut db = open_db()?;
        let header = vault::initialize_device(&mut db, &vault::device_key_path()?)?;
        let password_required = header != vault::DEVICE_HEADER;
        let unlocked = if !password_required {
            access(&store, &owner, false, |_, _| Ok(()))?;
            true
        } else {
            store.lock();
            false
        };
        Ok(Status {
            initialized: true,
            unlocked,
            password_required,
        })
    })
    .await
}
#[tauri::command]
pub(crate) async fn authenticator_unlock(
    window: tauri::Window,
    state: State<'_, VaultStore>,
    password: String,
    create: bool,
) -> PlatformResult<()> {
    let password = Zeroizing::new(password);
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        let generation = store.generation.load(std::sync::atomic::Ordering::SeqCst);
        let mut attempts = store.failed_unlock.lock().map_err(|_| "验证器状态不可用")?;
        if attempts.is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
            return Err("请等待 3 秒后重试密码".into());
        }
        let mut db = open_db()?;
        let existing = repository::header(&db)?;
        let _ = create;
        let result = {
            let header = existing.ok_or("请先创建验证器密码库")?;
            if header == vault::DEVICE_HEADER {
                vault::read_device_key(&vault::device_key_path()?).map(|key| (key, header))
            } else {
                vault::migrate_device(&mut db, &vault::device_key_path()?, &header, &password)
                    .map(|key| (key, vault::DEVICE_HEADER.into()))
            }
        };
        match result {
            Ok((key, header)) => {
                repository::load(&db, &key)?;
                let mut guard = store.session.lock().map_err(|_| "验证器状态不可用")?;
                if store.generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
                    return Err("验证器已锁定，请重新解锁".into());
                }
                *guard = Some(Session {
                    key,
                    owner,
                    header,
                    action: Instant::now(),
                    poll: Instant::now(),
                    stage: None,
                });
                *attempts = None;
                Ok(())
            }
            Err(reason) => {
                *attempts = Some(Instant::now());
                Err(reason)
            }
        }
    })
    .await
}
#[tauri::command]
pub(crate) fn authenticator_lock(state: State<'_, VaultStore>) -> PlatformResult<()> {
    state.lock();
    Ok(())
}
#[tauri::command]
pub(crate) async fn authenticator_list(
    window: tauri::Window,
    state: State<'_, VaultStore>,
) -> PlatformResult<Vec<EntrySummary>> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        access(&store, &owner, false, |s, db| {
            Ok(repository::load(db, &s.key)?
                .iter()
                .map(Entry::summary)
                .collect())
        })
    })
    .await
}
#[tauri::command]
pub(crate) async fn authenticator_touch(
    window: tauri::Window,
    state: State<'_, VaultStore>,
) -> PlatformResult<()> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || access(&store, &owner, true, |_, _| Ok(()))).await
}
#[tauri::command]
pub(crate) async fn authenticator_codes(
    window: tauri::Window,
    state: State<'_, VaultStore>,
    ids: Vec<String>,
) -> PlatformResult<Vec<Code>> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        access(&store, &owner, false, |s, db| {
            if ids.len() > 250 {
                return Err("单次最多显示 250 个验证码".into());
            }
            let now = chrono::Utc::now().timestamp().max(0) as u64;
            repository::selected(db, &s.key, &ids)?
                .into_iter()
                .map(|e| {
                    let counter = if e.kind == "hotp" {
                        e.counter
                    } else {
                        now / e.period
                    };
                    Ok(Code {
                        id: e.id.clone(),
                        current: otp::generate(&e, counter)?,
                        next: if e.kind == "hotp" {
                            None
                        } else {
                            Some(otp::generate(&e, counter + 1)?)
                        },
                        remaining: if e.kind == "hotp" {
                            0
                        } else {
                            e.period - now % e.period
                        },
                        period: e.period,
                        counter: e.counter.to_string(),
                    })
                })
                .collect()
        })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EntryInput {
    pub id: Option<String>,
    pub issuer: String,
    pub account: String,
    pub kind: String,
    pub algorithm: String,
    pub digits: u32,
    pub period: u64,
    pub counter: String,
    pub secret: Option<String>,
    pub group: String,
    pub note: String,
    pub pinned: bool,
    pub order: i64,
}
fn save_entry(s: &Session, db: &mut rusqlite::Connection, input: EntryInput) -> Result<(), String> {
            let entries = repository::load(db, &s.key)?;
            let existing = input
                .id
                .as_ref()
                .and_then(|id| entries.iter().find(|e| &e.id == id));
            if input.id.is_some() && existing.is_none() {
                return Err("验证码不存在".into());
            }
            if existing.is_none() && entries.len() >= MAX_ENTRIES {
                return Err("验证码数量超过 10000".into());
            }
            let counter = input
                .counter
                .parse::<u64>()
                .map_err(|_| "HOTP 计数必须为有效的无符号整数")?;
            let mut entry = Entry {
                id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                issuer: input.issuer,
                account: input.account,
                kind: input.kind,
                algorithm: input.algorithm,
                digits: input.digits,
                period: input.period,
                counter,
                secret: input
                    .secret
                    .filter(|v| !v.trim().is_empty())
                    .or_else(|| existing.map(|e| e.secret.clone()))
                    .ok_or("首次新增必须填写 OTP 密钥")?,
                group: input.group,
                note: input.note,
                pinned: input.pinned,
                order: input.order,
            };
            entry.validate()?;
            if entries
                .iter()
                .any(|e| e.id != entry.id && e.same_seed(&entry) && e.counter == entry.counter)
            {
                return Err("此 OTP 密钥及参数已存在，请编辑已有条目".into());
            }
            repository::write(db, &s.key, &entry)
}
#[tauri::command]
pub(crate) async fn authenticator_save(
    window: tauri::Window,
    state: State<'_, VaultStore>,
    input: EntryInput,
) -> PlatformResult<()> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        access(&store, &owner, true, |s, db| {
            save_entry(s, db, input)
        })
    })
    .await
}
#[tauri::command]
pub(crate) async fn authenticator_remove(
    window: tauri::Window,
    state: State<'_, VaultStore>,
    ids: Vec<String>,
) -> PlatformResult<()> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || access(&store, &owner, true, |_, db| repository::remove(db, &ids))).await
}
#[tauri::command]
pub(crate) async fn authenticator_advance(
    window: tauri::Window,
    state: State<'_, VaultStore>,
    id: String,
) -> PlatformResult<()> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        access(&store, &owner, true, |s, db| {
            let tx = db.transaction().map_err(|_| "无法开始计数事务")?;
            let mut entry = repository::load(&tx, &s.key)?
                .into_iter()
                .find(|e| e.id == id)
                .ok_or("验证码不存在")?;
            if entry.kind != "hotp" || entry.counter == u64::MAX {
                return Err("HOTP 计数无法推进".into());
            }
            entry.counter += 1;
            repository::write(&tx, &s.key, &entry)?;
            tx.commit().map_err(|_| "HOTP 计数提交失败".into())
        })
    })
    .await
}
#[tauri::command]
pub(crate) async fn authenticator_copy(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, VaultStore>,
    id: String,
    target: Option<String>,
) -> PlatformResult<()> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        access(&store, &owner, true, |s, db| {
            let entry = repository::selected(db, &s.key, &[id])?
                .into_iter()
                .next()
                .ok_or("验证码不存在")?;
            let now = chrono::Utc::now().timestamp().max(0) as u64;
            let counter = if entry.kind == "hotp" { entry.counter } else { now / entry.period };
            let code = match target.as_deref().unwrap_or("current") {
                "current" => otp::generate(&entry, counter)?,
                "next" if entry.kind != "hotp" => otp::generate(&entry, counter.checked_add(1).ok_or("验证码时间超出范围")?)?,
                "next" => return Err("HOTP 不提供预览下一码，请使用下一码按钮".into()),
                "account" if !entry.account.is_empty() => entry.account.clone(),
                "account" => return Err("账户为空，无法复制".into()),
                _ => return Err("无效的复制类型".into()),
            };
            #[cfg(not(mobile))]
            arboard::Clipboard::new()
                .and_then(|mut c| c.set_text(code.clone()))
                .map_err(|_| "无法写入系统剪贴板")?;
            #[cfg(mobile)]
            {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                app.clipboard().write_text(code.clone()).map_err(|_| "无法写入系统剪贴板")?;
            }
            #[cfg(not(mobile))]
            let _ = app;
            std::thread::spawn(move || {
                let code = Zeroizing::new(code);
                std::thread::sleep(Duration::from_secs(30));
                #[cfg(not(mobile))]
                if let Ok(mut clipboard) = arboard::Clipboard::new() {
                    if clipboard.get_text().is_ok_and(|value| value == *code) {
                        let _ = clipboard.clear();
                    }
                }
                #[cfg(mobile)]
                {
                    use tauri_plugin_clipboard_manager::ClipboardExt;
                    if app.clipboard().read_text().is_ok_and(|value| value == *code) { let _ = app.clipboard().write_text(""); }
                }
            });
            Ok(())
        })
    })
    .await
}

fn read_bounded(path: &std::path::Path) -> Result<Zeroizing<Vec<u8>>, String> {
    let file = fs::File::open(path).map_err(|_| "无法读取所选文件")?;
    let mut data = Zeroizing::new(Vec::new());
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| "读取文件失败")?;
    if data.len() > MAX_FILE_BYTES {
        return Err("文件不能超过 10 MiB".into());
    }
    Ok(data)
}
fn decode_qr(bytes: &[u8]) -> Result<Zeroizing<String>, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err("二维码图片过大".into());
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "图片格式无效")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "无法解析图片，支持 PNG/JPEG/GIF/WebP，最大 4096×4096")?
        .to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(image);
    let grids = prepared.detect_grids();
    let mut lines = Zeroizing::new(String::new());
    for grid in grids {
        if let Ok((_, content)) = grid.decode() {
            if content.starts_with("otpauth://") {
                lines.push_str(&content);
                lines.push('\n');
            }
        }
    }
    if lines.is_empty() {
        return Err("图片中没有可识别的 OTP 二维码".into());
    }
    Ok(lines)
}
#[tauri::command]
pub(crate) async fn authenticator_prepare(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, VaultStore>,
    password: String,
    text: Option<String>,
    image: Option<Vec<u8>>,
    qr: bool,
) -> PlatformResult<Option<Preview>> {
    let password = Zeroizing::new(password);
    let text = text.map(Zeroizing::new);
    let image = image.map(Zeroizing::new);
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        access(&store, &owner, true, |_, _| Ok(()))?;
        let content = if let Some(bytes) = image {
            decode_qr(&bytes)?
        } else if let Some(text) = text {
            text
        } else {
            let picker = app.dialog().file().set_title(if qr {
                "选择 OTP 二维码图片"
            } else {
                "导入 Ente / CloudHub 验证码"
            });
            let _dialog = store.dialog()?;
            let Some(selected) = picker.blocking_pick_file() else {
                return Ok(None);
            };
            #[cfg(not(mobile))]
            let data = read_bounded(&selected.into_path().map_err(|_| "所选文件地址不受支持")?)?;
            #[cfg(mobile)]
            let data = {
                use tauri_plugin_fs::FsExt;
                let mut options = tauri_plugin_fs::OpenOptions::new(); options.read(true);
                let file = app.fs().open(selected, options).map_err(|_| "无法打开系统选择的验证码文件")?;
                let mut data = Zeroizing::new(Vec::new());
                file.take((MAX_FILE_BYTES + 1) as u64).read_to_end(&mut data).map_err(|_| "无法读取验证码文件")?;
                if data.len() > MAX_FILE_BYTES { return Err("文件大小超出限制".into()); }
                data
            };
            if qr {
                decode_qr(&data)?
            } else {
                Zeroizing::new(
                    std::str::from_utf8(&data)
                        .map_err(|_| "文件必须是 UTF-8 文本")?
                        .to_string(),
                )
            }
        };
        let parsed = formats::parse_file(&content, &password)?;
        access(&store, &owner, true, |s, db| {
            let existing = repository::load(db, &s.key)?;
            let mut seen = existing.clone();
            let mut items = vec![];
            for entry in &parsed.entries {
                let duplicate = seen.iter().find(|e| e.same_seed(entry));
                let conflict = duplicate.is_some_and(|e| e.counter != entry.counter)
                    || seen.iter().any(|e| {
                        e.account == entry.account
                            && e.issuer == entry.issuer
                            && !e.same_seed(entry)
                    });
                items.push(PreviewItem {
                    entry: entry.summary(),
                    duplicate_id: duplicate.map(|e| e.id.clone()),
                    conflict,
                });
                seen.push(entry.clone());
            }
            let token = uuid::Uuid::new_v4().to_string();
            s.stage = Some(Stage {
                id: token.clone(),
                entries: parsed.entries,
                created: Instant::now(),
            });
            Ok(Some(Preview {
                token,
                items,
                errors: parsed.errors,
                format: parsed.format,
            }))
        })
    })
    .await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportChoice {
    pub id: String,
    pub action: String,
}
#[derive(Debug, Serialize)]
pub(crate) struct ImportResult {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
}
#[tauri::command]
pub(crate) async fn authenticator_import(
    window: tauri::Window,
    state: State<'_, VaultStore>,
    token: String,
    choices: Vec<ImportChoice>,
) -> PlatformResult<ImportResult> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        access(&store, &owner, true, |s, db| {
            apply_import(s, db, &token, &choices)
        })
    })
    .await
}
fn apply_import(
    s: &mut Session,
    db: &mut rusqlite::Connection,
    token: &str,
    choices: &[ImportChoice],
) -> Result<ImportResult, String> {
    let stage = s.stage.as_ref().ok_or("导入预览已过期")?;
    if stage.id != token || stage.created.elapsed() > Duration::from_secs(300) {
        s.stage = None;
        return Err("导入预览已过期".into());
    }
    if choices.len() != stage.entries.len()
        || choices.iter().map(|c| &c.id).collect::<HashSet<_>>().len() != choices.len()
    {
        return Err("导入选择不完整或包含重复项".into());
    }
    let tx = db.transaction().map_err(|_| "无法开始导入事务")?;
    let mut entries = repository::load(&tx, &s.key)?;
    let mut result = ImportResult {
        added: 0,
        updated: 0,
        skipped: 0,
    };
    for choice in choices {
        let mut entry = stage
            .entries
            .iter()
            .find(|e| e.id == choice.id)
            .ok_or("导入选择无效")?
            .clone();
        if choice.action == "skip" {
            result.skipped += 1;
            continue;
        }
        let same = entries.iter().position(|e| e.same_seed(&entry));
        match choice.action.as_str() {
            "add" => {
                if same.is_some() {
                    return Err("重复 OTP 请选择跳过或更新".into());
                }
                entry.id = uuid::Uuid::new_v4().to_string();
                entries.push(entry.clone());
                result.added += 1;
            }
            "update" => {
                let index = same.ok_or("没有可更新的重复 OTP")?;
                if entry.kind == "hotp" && entry.counter < entries[index].counter {
                    return Err("不能将 HOTP 计数回退，请选择跳过".into());
                }
                entry.id = entries[index].id.clone();
                entries[index] = entry.clone();
                result.updated += 1;
            }
            _ => return Err("导入操作无效".into()),
        }
        if entries.len() > MAX_ENTRIES {
            return Err("验证码数量超过 10000".into());
        }
        repository::write(&tx, &s.key, &entry)?;
    }
    tx.commit().map_err(|_| "导入提交失败")?;
    s.stage = None;
    Ok(result)
}
#[tauri::command]
pub(crate) async fn authenticator_cancel(
    window: tauri::Window,
    state: State<'_, VaultStore>,
) -> PlatformResult<()> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    work(move || {
        access(&store, &owner, false, |s, _| {
            s.stage = None;
            Ok(())
        })
    })
    .await
}
#[tauri::command]
pub(crate) async fn authenticator_export(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, VaultStore>,
    ids: Vec<String>,
    format: String,
    password: String,
    acknowledge_plain: bool,
) -> PlatformResult<Option<String>> {
    let store = state.inner().clone();
    let owner = window.label().to_string();
    let password = Zeroizing::new(password);
    work(move || {
        if ids.is_empty()
            || ids.len() > MAX_ENTRIES
            || !["cloudhub", "ente", "plain"].contains(&format.as_str())
        {
            return Err("导出选择或格式无效".into());
        }
        if format == "plain" && !acknowledge_plain {
            return Err("明文导出必须确认密钥泄露风险".into());
        }
        access(&store, &owner, true, |s, _| {
            if s.header != vault::DEVICE_HEADER {
                return Err("请先迁移已有验证器".into());
            }
            Ok(())
        })?;
        let extension = if format == "plain" { "txt" } else { "json" };
        let filename = format!(
            "cloudhub-auth-{}-{}.{}",
            format,
            chrono::Utc::now().format("%Y%m%d-%H%M%S"),
            extension
        );
        let _dialog = store.dialog()?;
        let Some(selected) = app
            .dialog()
            .file()
            .set_file_name(filename)
            .blocking_save_file()
        else {
            return Ok(None);
        };
        #[cfg(not(mobile))]
        let target = selected.into_path().map_err(|_| "保存地址不受支持")?;
        access(&store, &owner, true, |s, db| {
            let entries = repository::selected(db, &s.key, &ids)?;
            if entries.len() != ids.iter().collect::<HashSet<_>>().len() {
                return Err("导出选择已失效，请刷新后重试".into());
            }
            let data = formats::export(&entries, &format, &password)?;
            #[cfg(mobile)]
            {
                use tauri_plugin_fs::FsExt;
                let mut options = tauri_plugin_fs::OpenOptions::new(); options.write(true).create(true).truncate(true);
                let mut file = app.fs().open(selected, options).map_err(|_| "无法打开系统选择的导出位置")?;
                file.write_all(&data).map_err(|_| "验证码导出写入失败")?;
                return Ok(Some("系统选择的备份文件".into()));
            }
            #[cfg(not(mobile))]
            {
            // No plaintext staging file: create the selected destination exclusively.
            // An existing file is never overwritten; select a new name to preserve prior backups.
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&target)
                .map_err(|_| "无法创建导出文件：请使用尚不存在的文件名")?;
            if file.write_all(&data).and_then(|_| file.sync_all()).is_err() {
                drop(file);
                let _ = fs::remove_file(&target);
                return Err("导出写入失败".into());
            }
            Ok(Some(target.to_string_lossy().into_owned()))
            }
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_rolls_back_on_duplicates_and_hotp_regression() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(repository::SCHEMA).unwrap();
        let key = Zeroizing::new([8u8; 32]);
        let original=formats::parse_uri("otpauth://hotp/Example:demo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=9007199254740993").unwrap();
        repository::write(&db, &key, &original).unwrap();
        let fresh =
            formats::parse_uri("otpauth://totp/Other:demo?secret=JBSWY3DPEHPK3PXP").unwrap();
        let mut duplicate = original.clone();
        duplicate.id = uuid::Uuid::new_v4().to_string();
        duplicate.counter -= 1;
        let mut session = Session {
            key,
            owner: "main".into(),
            header: "test".into(),
            action: Instant::now(),
            poll: Instant::now(),
            stage: Some(Stage {
                id: "stage".into(),
                entries: vec![fresh.clone(), duplicate.clone()],
                created: Instant::now(),
            }),
        };
        let choices = vec![
            ImportChoice {
                id: fresh.id.clone(),
                action: "add".into(),
            },
            ImportChoice {
                id: duplicate.id.clone(),
                action: "update".into(),
            },
        ];
        assert!(apply_import(&mut session, &mut db, "stage", &choices)
            .unwrap_err()
            .contains("回退"));
        let stored = repository::load(&db, &session.key).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].counter, 9007199254740993);
        assert_eq!(stored[0].summary().counter, "9007199254740993");
        let mut duplicate_add = choices;
        duplicate_add[1].action = "add".into();
        assert!(apply_import(&mut session, &mut db, "stage", &duplicate_add).is_err());
        assert_eq!(repository::load(&db, &session.key).unwrap().len(), 1);
        duplicate_add[1].action = "skip".into();
        let result = apply_import(&mut session, &mut db, "stage", &duplicate_add).unwrap();
        assert_eq!((result.added, result.skipped), (1, 1));
        assert!(session.stage.is_none());
        assert_eq!(repository::load(&db, &session.key).unwrap().len(), 2);
    }
    #[test]
    fn qr_image_decode_and_invalid_images() {
        let text = decode_qr(include_bytes!(
            "../../../tests/fixtures/authenticator/otp-qr.png"
        ))
        .unwrap();
        let parsed = formats::parse_lines(&text).unwrap();
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].account, "demo@example.test");
        assert!(decode_qr(b"not an image").is_err());
        assert!(decode_qr(&vec![0; MAX_FILE_BYTES + 1]).is_err());
    }
}

#[cfg(desktop)]
pub(crate) mod browser;
