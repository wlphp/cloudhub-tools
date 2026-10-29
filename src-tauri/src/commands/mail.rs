use crate::core::{
    error::{PlatformError, PlatformResult},
    mail,
};
fn caller(window: &tauri::WebviewWindow) -> PlatformResult<()> {
    if window.label() != "main" {
        return Err("仅主窗口可以操作邮箱".into());
    }
    Ok(())
}
async fn work<T: Send + 'static>(
    operation: &'static str,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> PlatformResult<T> {
    let result = tauri::async_runtime::spawn_blocking(f).await;
    let result = match result {
        Ok(result) => result,
        Err(tauri::Error::JoinError(error)) if error.is_panic() => Err(format!(
            "{operation}时邮件后台任务异常退出。请检查邮箱服务是否开启 IMAP，并重试；若仍失败，请反馈此提示。"
        )),
        Err(_) => Err(format!("{operation}任务已中断，请重试。")),
    };
    result.map_err(|message| PlatformError {
            kind: "platform-error",
            code: "mail",
            message,
            retryable: false,
        })
}
#[tauri::command]
pub(crate) async fn mail_accounts(
    window: tauri::WebviewWindow,
) -> PlatformResult<Vec<mail::Account>> {
    caller(&window)?;
    work("读取邮箱", mail::accounts).await
}
#[tauri::command]
pub(crate) async fn mail_reveal_secret(window: tauri::WebviewWindow, id: String) -> PlatformResult<String> {
    caller(&window)?;
    work("读取邮箱授权码", move || mail::reveal_secret(&id)).await
}
#[tauri::command]
pub(crate) async fn mail_save(
    window: tauri::WebviewWindow,
    input: mail::AccountInput,
) -> PlatformResult<mail::Account> {
    caller(&window)?;
    work("保存邮箱", move || mail::save(input)).await
}
#[tauri::command]
pub(crate) async fn mail_remove(window: tauri::WebviewWindow, id: String) -> PlatformResult<()> {
    caller(&window)?;
    work("移除邮箱", move || mail::remove(&id)).await
}
#[tauri::command]
pub(crate) async fn mail_test(
    window: tauri::WebviewWindow,
    id: String,
) -> PlatformResult<mail::ConnectionTest> {
    caller(&window)?;
    work("检测邮箱连接", move || mail::test(&id)).await
}
#[tauri::command]
pub(crate) async fn mail_folders(
    window: tauri::WebviewWindow,
    id: String,
) -> PlatformResult<Vec<String>> {
    caller(&window)?;
    work("读取邮件文件夹", move || mail::folders(&id)).await
}
#[tauri::command]
pub(crate) async fn mail_list(
    window: tauri::WebviewWindow,
    id: String,
    folder: String,
) -> PlatformResult<mail::Listing> {
    caller(&window)?;
    work("读取邮件列表", move || mail::list(&id, &folder)).await
}
#[tauri::command]
pub(crate) async fn mail_read(
    window: tauri::WebviewWindow,
    id: String,
    folder: String,
    validity: u32,
    uid: u32,
) -> PlatformResult<mail::ReadMessage> {
    caller(&window)?;
    work("读取邮件正文", move || mail::read(&id, &folder, validity, uid)).await
}
#[tauri::command]
pub(crate) async fn mail_attachment(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    folder: String,
    validity: u32,
    uid: u32,
    index: usize,
) -> PlatformResult<bool> {
    caller(&window)?;
    work("保存邮件附件", move || {
        use tauri_plugin_dialog::DialogExt;
        let (name, data) = mail::attachment(&id, &folder, validity, uid, index)?;
        let Some(target) = app
            .dialog()
            .file()
            .set_title("保存邮件附件")
            .set_file_name(&name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = target.into_path().map_err(|_| "请选择本机保存位置")?;
        std::fs::write(path, data).map_err(|_| "保存附件失败，请检查目录权限")?;
        Ok(true)
    })
    .await
}
#[tauri::command]
pub(crate) async fn mail_send(
    window: tauri::WebviewWindow,
    id: String,
    draft: mail::Draft,
) -> PlatformResult<()> {
    caller(&window)?;
    work("发送邮件", move || mail::send(&id, draft)).await
}
#[tauri::command]
pub(crate) async fn mail_prepare_import(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<serde_json::Value> {
    caller(&window)?; work("读取邮箱导入文件", move || mail::prepare_import(&app)).await
}
#[tauri::command]
pub(crate) async fn mail_import_selected(window: tauri::WebviewWindow, token: String, indices: Vec<usize>) -> PlatformResult<serde_json::Value> {
    caller(&window)?; work("导入邮箱", move || mail::import_selected(&token, &indices)).await
}
#[tauri::command]
pub(crate) async fn mail_export_selected(window: tauri::WebviewWindow, app: tauri::AppHandle, ids: Vec<String>, acknowledge_plain: bool) -> PlatformResult<bool> {
    caller(&window)?; work("导出邮箱", move || mail::export_selected(&app, &ids, acknowledge_plain)).await
}
