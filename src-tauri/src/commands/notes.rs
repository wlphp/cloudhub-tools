//! Desktop memo store commands. Notes are plain local data without a password
//! gate, matching the agreed product scope for the built-in 备忘录 app.
use crate::core::{
    database::open_db,
    error::PlatformResult,
    pet_alerts::Alert,
    repositories::notes::{self as repository, Note, NoteInput, NotePatch},
};
use crate::commands::desktop_pet;
use serde::Serialize;
use std::time::Duration;
use tauri::{Emitter, Manager};
use std::sync::{Arc, Mutex, MutexGuard};

const ALLOWED_WINDOWS: [&str; 3] = ["main", "desktop-pet", "desktop-pet-alert"];

/// Serializes reminder processing so the background loop and the frontend
/// cannot fire the same reminder twice from concurrent connections. Cloned
/// into each task, so no borrowed state crosses into the blocking worker.
#[derive(Clone, Default)]
pub struct NotesStore {
    lock: Arc<Mutex<()>>,
}

impl NotesStore {
    fn guard(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.lock.lock().map_err(|_| "备忘录状态不可用".to_string())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesSnapshot {
    pub notes: Vec<Note>,
    pub groups: Vec<String>,
    pub reminders: Vec<repository::DueReminder>,
    /// Recycle bin contents; restored or purged by id.
    pub trashed: Vec<Note>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn snapshot(conn: &rusqlite::Connection, now: i64) -> Result<NotesSnapshot, String> {
    repository::ensure_groups(conn, now)?;
    Ok(NotesSnapshot {
        notes: repository::list(conn)?,
        groups: repository::groups(conn)?,
        reminders: repository::due(conn, now)?,
        trashed: repository::list_trashed(conn)?,
    })
}

async fn work<T: Send + 'static, F: FnOnce() -> Result<T, String> + Send + 'static>(
    f: F,
) -> PlatformResult<T> {
    // Domain errors are authored inside the repository and never interpolate
    // SQLite text or user input; they map onto the validation whitelist.
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "备忘录任务执行失败".to_string())
        .and_then(|result| result)
        .map_err(Into::into)
}

fn caller(window: &tauri::WebviewWindow) -> Result<(), String> {
    if ALLOWED_WINDOWS.contains(&window.label()) {
        Ok(())
    } else {
        Err("此窗口不支持备忘录提醒".to_string())
    }
}

/// Opens the main window on the 备忘录 section from the pet or alert window.
#[tauri::command]
pub(crate) async fn notes_open(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> PlatformResult<()> {
    caller(&window)?;
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|_| "无法打开备忘录")?;
        let _ = main.unminimize();
        let _ = main.set_focus();
        let _ = main.emit(
            "pet-open-section",
            serde_json::json!({"section": "notes", "key": null}),
        );
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn notes_snapshot(
    state: tauri::State<'_, NotesStore>,
) -> PlatformResult<NotesSnapshot> {
    let store = state.inner().clone();
    work(move || {
        let _guard = store.guard()?;
        let conn = open_db()?;
        // Heal a crash between the fired and dismissed steps of the pet alert.
        repository::dismiss_displayed(&conn)?;
        snapshot(&conn, now())
    })
    .await
}

#[tauri::command]
pub(crate) async fn notes_save(input: NoteInput) -> PlatformResult<i64> {
    work(move || {
        let conn = open_db()?;
        let at = now();
        match input.id {
            Some(id) if id > 0 => repository::update(&conn, id, &patch_from(&input), at),
            _ => {
                let mut fresh = input;
                fresh.id = None;
                repository::create(&conn, &fresh, at)
            }
        }
    })
    .await
}

/// `notes_save` always carries the complete note, so the reminder fields are
/// sent as a whole schedule: `remindAt: null` clears it.
fn patch_from(input: &NoteInput) -> NotePatch {
    NotePatch {
        title: Some(input.title.clone()),
        body: Some(input.body.clone()),
        group: Some(input.group.clone()),
        tags: Some(input.tags.clone()),
        account: Some(input.account.clone()),
        password: Some(input.password.clone()),
        pinned: Some(input.pinned),
        remind_at: input.remind_at,
        remind_repeat: Some(
            input
                .remind_repeat
                .clone()
                .unwrap_or_else(|| "none".to_string()),
        ),
    }
}

#[tauri::command]
pub(crate) async fn notes_delete(ids: Vec<i64>) -> PlatformResult<u64> {
    work(move || repository::remove(&open_db()?, &ids, now())).await
}

/// Returns trashed notes to the list; schedules they still carry are re-armed.
#[tauri::command]
pub(crate) async fn notes_restore(ids: Vec<i64>) -> PlatformResult<u64> {
    work(move || repository::restore(&open_db()?, &ids, now())).await
}

/// Irreversibly removes trashed notes.
#[tauri::command]
pub(crate) async fn notes_purge(ids: Vec<i64>) -> PlatformResult<u64> {
    work(move || repository::purge(&open_db()?, &ids)).await
}

#[tauri::command]
pub(crate) async fn notes_group_save(name: String) -> PlatformResult<String> {
    work(move || repository::save_group(&open_db()?, &name, now())).await
}

#[tauri::command]
pub(crate) async fn notes_group_delete(name: String, target: String) -> PlatformResult<u64> {
    work(move || {
        let mut conn = open_db()?;
        repository::delete_group(&mut conn, &name, &target, now())
    })
    .await
}

/// Called by the main window or the pet alert window when the user reacts to a
/// reminder. Completing a repeating reminder schedules its next run.
#[tauri::command]
pub(crate) async fn notes_reminder_complete(
    window: tauri::WebviewWindow,
    id: i64,
) -> PlatformResult<()> {
    caller(&window)?;
    // The alert is resolved by the user, so stop showing it from now on.
    work(move || repository::dismiss_displayed(&open_db()?)).await?;
    work(move || repository::complete_reminder(&open_db()?, id, now())).await
}

/// Dismisses the alert window for `id` without touching the schedule, so the
/// reminder visibly stays armed in the notes list.
#[tauri::command]
pub(crate) async fn notes_reminder_dismiss(
    window: tauri::WebviewWindow,
    id: i64,
) -> PlatformResult<u64> {
    caller(&window)?;
    work(move || repository::dismiss(&open_db()?, id)).await
}

#[tauri::command]
pub(crate) async fn notes_reminder_snooze(
    window: tauri::WebviewWindow,
    id: i64,
    minutes: i64,
) -> PlatformResult<i64> {
    caller(&window)?;
    work(move || repository::dismiss_displayed(&open_db()?)).await?;
    work(move || repository::snooze_reminder(&open_db()?, id, minutes, now())).await
}

/// Background reminder loop. It is independent of the 运维预警 switch: only
/// the quiet setting and the pet visibility gate how notifications surface.
const REMINDER_POLL: Duration = Duration::from_secs(20);

fn reminder_alert(item: &repository::DueReminder) -> Alert {
    let detail = if item.summary.is_empty() {
        format!("备忘录提醒 · {}", item.title)
    } else {
        format!("备忘录提醒 · {}", item.summary)
    };
    Alert::candidate(
        format!("notes:{}:{}", item.note_id, item.fire_at),
        item.title.clone(),
        detail,
        "notes",
        "warning",
    )
}

fn fire_reminders(app: &tauri::AppHandle, store: &NotesStore) -> Result<(), String> {
    let _guard = store.guard()?;
    let conn = open_db()?;
    for item in repository::fire_due(&conn, now())? {
        if !desktop_pet::visible(app) {
            continue;
        }
        if let Err(message) = desktop_pet::notify(app, reminder_alert(&item)) {
            // Keep the reminder armed so the next poll retries the alert.
            repository::reopen(&conn, item.note_id, item.fire_at)?;
            return Err(message);
        }
    }
    Ok(())
}

/// Starts the reminder loop once at app startup. `NotesStore` serializes it with
/// the frontend commands, so a reminder can only be fired one way.
pub fn start_reminder_loop(app: &tauri::AppHandle) {
    let handle = app.clone();
    let store = app.state::<NotesStore>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(REMINDER_POLL).await;
            let store = store.clone();
            let fired = handle.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || fire_reminders(&fired, &store)).await;
        }
    });
}
