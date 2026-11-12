//! Related, same-origin blank windows can host an existing React portal without
//! copying form contents into IPC payloads, URLs or persistent storage.
use tauri::{webview::NewWindowResponse, AppHandle, Manager, Runtime, WebviewWindowBuilder};

pub fn attach<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    app: AppHandle<R>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder.on_new_window(move |url, features| {
        let Some(label) = url.fragment().filter(|label| valid_label(label)) else {
            return NewWindowResponse::Deny;
        };
        if url.scheme() != "about" || url.path() != "blank" || url.query().is_some()
            || app.webview_windows().keys().filter(|name| name.starts_with("dialog-popout-")).count() >= 32 {
            return NewWindowResponse::Deny;
        }
        let window = tauri::WebviewWindowBuilder::new(
            &app, label, tauri::WebviewUrl::External(url.clone()),
        )
        .window_features(features)
        .title("CloudHub Tools")
        .min_inner_size(320.0, 180.0)
        .resizable(true)
        .decorations(true)
        .visible(false)
        .focused(false)
        // The blank document inherits the opener's origin. Never navigate it to
        // supplier content or an external site with access to the opener.
        .on_navigation(|_| false)
        .build();
        match window {
            Ok(window) => NewWindowResponse::Create { window },
            Err(_) => NewWindowResponse::Deny,
        }
    })
}

fn valid_label(label: &str) -> bool {
    label.strip_prefix("dialog-popout-").is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}
