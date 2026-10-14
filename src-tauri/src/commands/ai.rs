use crate::core::{
    ai::{self, Preview, Progress, Reply, RequestStore, RunInput, Task},
    database::open_db,
    error::{PlatformError, PlatformResult},
    repositories::ai::{self as repository, Profile, SaveProfile},
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};

fn error(message: String) -> PlatformError {
    PlatformError {
        kind: "ai",
        code: "ai",
        retryable: false,
        message,
    }
}
#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) async fn ai_read_image_file(source_path: String) -> PlatformResult<String> {
    tauri::async_runtime::spawn_blocking(move || crate::core::ai_images::read_source_file(&source_path))
        .await.map_err(|_| error("读取图片失败".into()))?.map_err(error)
}
#[tauri::command]
pub(crate) fn ai_list_profiles() -> PlatformResult<Vec<Profile>> {
    repository::list(&open_db()?).map_err(error)
}
#[tauri::command]
pub(crate) fn ai_reveal_key(id: String, expected_revision: i64) -> PlatformResult<String> {
    repository::reveal_key(&open_db()?, &id, expected_revision).map(|key| key.to_string()).map_err(error)
}
#[tauri::command]
pub(crate) fn ai_save_profile(
    input: SaveProfile,
    store: State<'_, RequestStore>,
) -> PlatformResult<Profile> {
    let active = store
        .active
        .lock()
        .map_err(|_| error("AI任务状态不可用".into()))?;
    let saved = repository::save(&mut open_db()?, input).map_err(error)?;
    for (profile_id, cancel) in active.values() {
        if profile_id == &saved.id {
            let _ = cancel.send(true);
        }
    }
    Ok(saved)
}
#[tauri::command]
pub(crate) fn ai_delete_profile(id: String, store: State<'_, RequestStore>) -> PlatformResult<()> {
    let active = store
        .active
        .lock()
        .map_err(|_| error("AI任务状态不可用".into()))?;
    for (profile_id, cancel) in active.values() {
        if profile_id == &id {
            let _ = cancel.send(true);
        }
    }
    repository::remove(&open_db()?, &id).map_err(error)
}
#[tauri::command]
pub(crate) fn ai_preview(text: String) -> PlatformResult<Preview> {
    ai::preview(&text).map_err(error)
}
#[tauri::command]
pub(crate) fn ai_cancel(request_id: String, store: State<'_, RequestStore>) -> PlatformResult<()> {
    if uuid::Uuid::parse_str(&request_id).is_err() {
        return Err(error("AI请求标识无效".into()));
    }
    store.cancel(&request_id).map_err(error)
}

struct Guard<'a> {
    store: &'a RequestStore,
    id: String,
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.store.active.lock() {
            active.remove(&self.id);
        }
    }
}

#[tauri::command]
pub(crate) async fn ai_run(
    input: RunInput,
    store: State<'_, RequestStore>,
    on_progress: Channel<Progress>,
) -> PlatformResult<Reply> {
    if uuid::Uuid::parse_str(&input.request_id).is_err() {
        return Err(error("AI请求标识无效".into()));
    }
    let safe = ai::preview(&input.text).map_err(error)?;
    if safe.text.trim().is_empty() {
        return Err(error("请先填写或选择分析内容".into()));
    }
    // The frontend must show the sanitized preview before asking for a request.
    // Reject stale/raw input rather than silently submitting a different context.
    if safe.removed_lines > 0 {
        return Err(error("内容含疑似凭据，请先使用发送预览移除后再提交".into()));
    }
    let (cancel, mut receiver) = tokio::sync::watch::channel(false);
    store
        .begin(&input.request_id, &input.profile_id, cancel)
        .map_err(error)?;
    let _guard = Guard {
        store: &store,
        id: input.request_id.clone(),
    };
    let (mut profile, key) = repository::load(&open_db()?, &input.profile_id).map_err(error)?;
    if profile.updated_at != input.expected_revision {
        return Err(error("AI配置已变更，请关闭辅助面板后重新打开".into()));
    }
    if let Some(model) = input.model {
        if model != profile.model {
            if !profile.models.contains(&model) { return Err(error("请使用已配置的模型ID".into())); }
            if input.image.is_some() { return Err(error("请先将所选模型设为默认并完成图像测试".into())); }
            profile.model = model;
        }
    }
    let image = if let Some(image) = input.image {
        if !image.reviewed || profile.vision_status != "supported" {
            return Err(error("请先完成图像能力测试并确认截图已裁剪遮挡".into()));
        }
        Some(
            tauri::async_runtime::spawn_blocking(move || {
                crate::core::ai_images::normalize(&image.data_url)
            })
            .await
            .map_err(|_| error("处理截图失败".into()))?
            .map_err(error)?,
        )
    } else {
        None
    };
    let progress_id = input.request_id.clone();
    let result = tokio::select! {
        biased;
        _=receiver.changed()=>Err("AI请求已取消".into()),
        value=ai::request_with_options(&profile,&key,&input.task,&safe.text,image.as_ref(),input.streaming,move|phase,received_bytes|{let _=on_progress.send(Progress{request_id:progress_id.clone(),phase:phase.into(),received_bytes});})=>value,
    }
    .map_err(error)?;
    Ok(Reply {
        request_id: input.request_id,
        draft: result.0,
        input_tokens: result.1,
        output_tokens: result.2,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceInput {
    request_id: String,
    profile_id: String,
    expected_revision: i64,
}
fn operation<'a>(
    store: &'a RequestStore,
    input: &ServiceInput,
) -> PlatformResult<(Guard<'a>, tokio::sync::watch::Receiver<bool>)> {
    if uuid::Uuid::parse_str(&input.request_id).is_err() {
        return Err(error("AI请求标识无效".into()));
    }
    let (sender, receiver) = tokio::sync::watch::channel(false);
    store
        .begin(&input.request_id, &input.profile_id, sender)
        .map_err(error)?;
    Ok((
        Guard {
            store,
            id: input.request_id.clone(),
        },
        receiver,
    ))
}
fn service(input: &ServiceInput) -> PlatformResult<(Profile, zeroize::Zeroizing<String>)> {
    let (profile, key) = repository::load(&open_db()?, &input.profile_id).map_err(error)?;
    if profile.updated_at != input.expected_revision {
        return Err(error("AI配置已变更，请关闭辅助面板后重新打开".into()));
    }
    Ok((profile, key))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelQueryInput {
    request_id: String,
    profile_id: Option<String>,
    expected_revision: Option<i64>,
    draft: Option<repository::ModelQueryConfig>,
}
#[tauri::command]
pub(crate) async fn ai_list_models(input: ModelQueryInput, store: State<'_, RequestStore>) -> PlatformResult<Vec<String>> {
    let operation_input = ServiceInput { request_id: input.request_id, profile_id: input.profile_id.clone().unwrap_or_default(), expected_revision: input.expected_revision.unwrap_or_default() };
    let (_guard, mut receiver) = operation(&store, &operation_input)?;
    let (profile, key) = if let Some(draft) = input.draft {
        repository::query_configuration(&open_db()?, input.profile_id.as_deref(), input.expected_revision, draft).map_err(error)?
    } else { service(&operation_input)? };
    tokio::select!{biased;_=receiver.changed()=>Err("AI请求已取消".into()),value=crate::core::ai_models::query(&profile,&key)=>value}.map_err(error)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VisionResult {
    profile: Profile,
    passed: bool,
}
#[tauri::command]
pub(crate) async fn ai_test_vision(
    input: ServiceInput,
    store: State<'_, RequestStore>,
) -> PlatformResult<VisionResult> {
    let (_guard, mut receiver) = operation(&store, &input)?;
    let (profile, key) = service(&input)?;
    let (image, expected) = tauri::async_runtime::spawn_blocking(crate::core::ai_images::challenge)
        .await
        .map_err(|_| error("生成图像测试失败".into()))?
        .map_err(error)?;
    let reply=tokio::select!{biased;_=receiver.changed()=>Err("AI请求已取消".into()),value=ai::request_with_options(&profile,&key,&Task::VisionTest,"请按任务要求识别图片。",Some(&image),false,|_,_|{})=>value}.map_err(error)?;
    let actual = reply
        .0
        .fields
        .get("colors")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .split(',')
        .map(|v| v.trim().to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(",");
    let passed = actual == expected;
    let profile = repository::record_vision(&open_db()?, &profile.id, profile.updated_at, passed)
        .map_err(error)?;
    Ok(VisionResult { profile, passed })
}
