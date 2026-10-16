use crate::core::{
    ai_transfer::{self, ImportStore, Payload, Pending, Preview},
    database::open_db,
    error::{PlatformError, PlatformResult},
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;
fn error(message: String) -> PlatformError {
    PlatformError {
        kind: "ai",
        code: "ai",
        message,
        retryable: false,
    }
}

#[tauri::command]
pub(crate) async fn ai_export_config(
    app: AppHandle,
    ids: Vec<String>,
) -> PlatformResult<bool> {
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let payload = ai_transfer::export(&open_db()?, &ids)?;
        let Some(selected) = app
            .dialog()
            .file()
            .set_file_name("cloudhub-ai-config.json")
            .add_filter("CloudHub AI配置", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let bytes = Zeroizing::new(serde_json::to_vec(&payload).map_err(|_| "导出AI配置失败")?);
        #[cfg(mobile)]
        {
            use std::io::Write;
            use tauri_plugin_fs::FsExt;
            let mut options = tauri_plugin_fs::OpenOptions::new();
            options.read(false).write(true).create(true).truncate(true);
            let mut file = app
                .fs()
                .open(selected, options)
                .map_err(|_| "保存AI迁移包失败")?;
            file.write_all(&bytes).map_err(|_| "保存AI迁移包失败")?;
        }
        #[cfg(not(mobile))]
        {
            let path = selected.into_path().map_err(|_| "保存AI迁移包失败")?;
            std::fs::write(path, bytes.as_slice()).map_err(|_| "保存AI迁移包失败")?;
        }
        Ok(true)
    })
    .await
    .map_err(|_| error("导出AI迁移任务失败".into()))?
    .map_err(error)
}
#[tauri::command]
pub(crate) async fn ai_prepare_import(
    app: AppHandle,
    store: State<'_, ImportStore>,
) -> PlatformResult<Option<Preview>> {
    let payload = tauri::async_runtime::spawn_blocking(move || -> Result<Option<Payload>, String> {
        use std::io::Read;
        let Some(selected) = app.dialog().file().add_filter("CloudHub AI配置", &["json"]).blocking_pick_file() else { return Ok(None); };
        #[cfg(not(mobile))]
        let file = std::fs::File::open(selected.into_path().map_err(|_| "所选文件地址不受支持")?).map_err(|_| "读取AI配置文件失败")?;
        #[cfg(mobile)]
        let file = {
            use tauri_plugin_fs::FsExt;
            let mut options = tauri_plugin_fs::OpenOptions::new(); options.read(true);
            app.fs().open(selected, options).map_err(|_| "读取AI配置文件失败")?
        };
        let mut content = Zeroizing::new(Vec::new());
        file.take(600_001).read_to_end(&mut content).map_err(|_| "读取AI配置文件失败")?;
        if content.len() > 600_000 { return Err("AI配置文件超过大小限制".into()); }
        let payload: Payload = serde_json::from_slice(&content).map_err(|_| "AI配置文件格式无效")?;
        ai_transfer::validate(&payload)?;
        Ok(Some(payload))
    })
    .await
    .map_err(|_| error("读取AI迁移任务失败".into()))?
    .map_err(error)?;
    let Some(payload) = payload else { return Ok(None); };
    let mut pending = store
        .pending
        .lock()
        .map_err(|_| error("AI迁移状态不可用".into()))?;
    ImportStore::prune(&mut pending);
    if pending.len() >= 3 {
        return Err(error("请先关闭其他AI迁移预览".into()));
    }
    let token = uuid::Uuid::new_v4().to_string();
    let profiles = payload
        .records
        .iter()
        .map(|record| {
            let mut profile = record.profile.clone();
            profile.has_key = record.api_key.as_ref().is_some_and(|key| !key.is_empty());
            if payload.version == 2 {
                profile.enabled = false;
                profile.is_default = false;
            }
            profile
        })
        .collect();
    pending.insert(
        token.clone(),
        Pending {
            created: std::time::Instant::now(),
            payload,
        },
    );
    Ok(Some(Preview { token, profiles }))
}
#[tauri::command]
pub(crate) fn ai_confirm_import(
    token: String,
    ids: Vec<String>,
    store: State<'_, ImportStore>,
) -> PlatformResult<usize> {
    let mut pending = store
        .pending
        .lock()
        .map_err(|_| error("AI迁移状态不可用".into()))?;
    ImportStore::prune(&mut pending);
    let packet = pending
        .get(&token)
        .ok_or_else(|| error("AI迁移预览已过期，请重新选择文件".into()))?;
    let count = ai_transfer::import(&mut open_db()?, &packet.payload, &ids).map_err(error)?;
    pending.remove(&token);
    Ok(count)
}
#[tauri::command]
pub(crate) fn ai_cancel_import(token: String, store: State<'_, ImportStore>) -> PlatformResult<()> {
    store
        .pending
        .lock()
        .map_err(|_| error("AI迁移状态不可用".into()))?
        .remove(&token);
    Ok(())
}
