//! Isolated native regression host. Run with a frontend on 127.0.0.1:4173.
//! No application commands, database, accounts or background services are loaded.
#[path = "../src/core/dialog_windows.rs"]
mod dialog_windows;

fn main() {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = Some("http://127.0.0.1:4173".parse().unwrap());
    tauri::Builder::default()
        .setup(|app| {
            let profile = std::env::temp_dir().join(format!("cloudhub-dialog-probe-{}", std::process::id()));
            let builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .data_directory(profile)
                .title("CloudHub 弹层隔离验证")
                .inner_size(1280.0, 800.0);
            dialog_windows::attach(builder, app.handle().clone()).build()?;
            Ok(())
        })
        .run(context)
        .expect("隔离验证窗口启动失败");
}
