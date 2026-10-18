//! Notes store. Text and credential fields are stored as entered by the user;
//! there is no vault or password gate for this plugin by design.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};


pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS memo_groups (
    name TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memo_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    account TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
    remind_at INTEGER,
    remind_repeat TEXT NOT NULL DEFAULT 'none' CHECK(remind_repeat IN ('none','daily','weekly','monthly')),
    remind_done_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS memo_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES memo_notes(id) ON DELETE CASCADE,
    fire_at INTEGER NOT NULL,
    fired_at INTEGER,
    dismissed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memo_notes_updated ON memo_notes(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memo_reminders_due ON memo_reminders(fired_at, fire_at);
CREATE INDEX IF NOT EXISTS idx_memo_notes_trash ON memo_notes(deleted_at, id);";

/// Adds the soft-delete column to databases created before the recycle bin.
/// `ALTER TABLE` has no `IF NOT EXISTS`, so the migration guards on the column.
pub const TRASH_SCHEMA: &str = "ALTER TABLE memo_notes ADD COLUMN deleted_at INTEGER";
pub const TRASH_INDEX_SCHEMA: &str = "CREATE INDEX IF NOT EXISTS idx_memo_notes_trash ON memo_notes(deleted_at, id)";

pub const DEFAULT_GROUPS: [&str; 2] = ["公司", "个人"];
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_BODY_CHARS: usize = 200_000;
pub const MAX_ACCOUNT_CHARS: usize = 512;
pub const MAX_PASSWORD_CHARS: usize = 2048;
pub const MAX_GROUP_CHARS: usize = 20;
pub const MAX_TAGS: usize = 20;
pub const MAX_TAG_CHARS: usize = 16;
/// Reminders further away than this are rejected as input mistakes.
pub const MAX_REMIND_MS: i64 = 10 * 365 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub group: String,
    pub tags: Vec<String>,
    pub account: String,
    pub password: String,
    pub pinned: bool,
    pub remind_at: Option<i64>,
    pub remind_repeat: String,
    pub remind_done_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Set when the note was moved to the recycle bin; `None` for live notes.
    pub deleted_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteInput {
    #[serde(default)]
    pub id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub group: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub account: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub remind_at: Option<i64>,
    #[serde(default)]
    pub remind_repeat: Option<String>,
}

/// Whitelisted fields accepted by the save command; anything else is rejected
/// before it reaches SQLite.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotePatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    /// `remindAt` replaces the whole schedule: a timestamp sets it, `null` (or a
    /// missing field together with `remindRepeat`) clears it, and leaving both
    /// schedule fields out keeps the current schedule. The frontend therefore
    /// always sends the full schedule state. Verified by `schedule_patch_keeps_cleared_state`.
    #[serde(default)]
    pub remind_at: Option<i64>,
    #[serde(default)]
    pub remind_repeat: Option<String>,
}

pub fn trimmed(value: &str, max: usize, label: &str) -> Result<String, String> {
    let text = value.trim();
    if text.chars().count() > max {
        return Err(format!("{label}过长，最多 {max} 个字符"));
    }
    Ok(text.to_string())
}

pub fn normalize_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut seen = Vec::new();
    for tag in tags {
        let text = tag.trim();
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > MAX_TAG_CHARS {
            return Err(format!("标签过长，最多 {MAX_TAG_CHARS} 个字符"));
        }
        if !seen.iter().any(|item: &String| item == text) {
            seen.push(text.to_string());
        }
    }
    if seen.len() > MAX_TAGS {
        return Err(format!("标签过多，最多 {MAX_TAGS} 个"));
    }
    Ok(seen)
}

pub fn validate_group(group: &str) -> Result<String, String> {
    let text = trimmed(group, MAX_GROUP_CHARS, "分组名")?;
    if text.is_empty() {
        return Err("请选择或填写分组".into());
    }
    Ok(text)
}

pub fn validate_repeat(repeat: &str) -> Result<String, String> {
    match repeat {
        "none" | "daily" | "weekly" | "monthly" => Ok(repeat.to_string()),
        _ => Err("提醒重复方式无效".into()),
    }
}

pub fn validate_remind_at(value: Option<i64>, now: i64) -> Result<Option<i64>, String> {
    let Some(at) = value else { return Ok(None) };
    if at <= now {
        return Err("提醒时间必须晚于当前时间".into());
    }
    if at - now > MAX_REMIND_MS {
        return Err("提醒时间过远，最多提前十年".into());
    }
    Ok(Some(at))
}

fn retry_note_title(title: &str) -> String {
    title.chars().take(MAX_TITLE_CHARS).collect()
}

pub fn validate_input(input: &NoteInput, now: i64) -> Result<(String, String, String, Vec<String>, String, String, String, Option<i64>), String> {
    let title = trimmed(&input.title, MAX_TITLE_CHARS, "标题")?;
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    let body = if input.body.chars().count() > MAX_BODY_CHARS {
        return Err(format!("正文过长，最多 {MAX_BODY_CHARS} 个字符"));
    } else {
        input.body.replace("\r\n", "\n")
    };
    let group = validate_group(&input.group)?;
    let tags = normalize_tags(&input.tags)?;
    let account = trimmed(&input.account, MAX_ACCOUNT_CHARS, "账号")?;
    let password = if input.password.chars().count() > MAX_PASSWORD_CHARS {
        return Err(format!("密码过长，最多 {MAX_PASSWORD_CHARS} 个字符"));
    } else {
        input.password.clone()
    };
    let repeat = validate_repeat(input.remind_repeat.as_deref().unwrap_or("none"))?;
    let remind_at = validate_remind_at(input.remind_at, now)?;
    let title = retry_note_title(&title);
    Ok((title, body, group, tags, account, password, repeat, remind_at))
}

fn tags_json(tags: &[String]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".into())
}

fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn row_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        group: row.get(3)?,
        tags: parse_tags(&row.get::<_, String>(4)?),
        account: row.get(5)?,
        password: row.get(6)?,
        pinned: row.get::<_, i64>(7)? != 0,
        remind_at: row.get(8)?,
        remind_repeat: row.get(9)?,
        remind_done_at: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        deleted_at: row.get(13)?,
    })
}

const NOTE_COLUMNS: &str = "id,title,body,group_name,tags_json,account,password,pinned,remind_at,remind_repeat,remind_done_at,created_at,updated_at,deleted_at";

/// Live notes only; trashed rows are excluded from every normal read path.
pub fn list(conn: &Connection) -> Result<Vec<Note>, String> {
    let mut statement = conn
        .prepare(&format!("SELECT {NOTE_COLUMNS} FROM memo_notes WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC, id DESC"))
        .map_err(|_| "读取备忘录失败")?;
    let rows = statement
        .query_map([], row_note)
        .map_err(|_| "读取备忘录失败")?;
    rows.map(|row| row.map_err(|_| "读取备忘录失败".to_string())).collect()
}

/// Recycle bin contents, most recently deleted first.
pub fn list_trashed(conn: &Connection) -> Result<Vec<Note>, String> {
    let mut statement = conn
        .prepare(&format!("SELECT {NOTE_COLUMNS} FROM memo_notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC"))
        .map_err(|_| "读取回收站失败")?;
    let rows = statement
        .query_map([], row_note)
        .map_err(|_| "读取回收站失败")?;
    rows.map(|row| row.map_err(|_| "读取回收站失败".to_string())).collect()
}

pub fn groups(conn: &Connection) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT name FROM memo_groups ORDER BY sort_order, created_at, name")
        .map_err(|_| "读取备忘录分组失败")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "读取备忘录分组失败")?;
    rows.map(|row| row.map_err(|_| "读取备忘录分组失败".to_string())).collect()
}

pub fn save_group(conn: &Connection, name: &str, now: i64) -> Result<String, String> {
    let name = validate_group(name)?;
    let existed: Option<i64> = conn.query_row("SELECT sort_order FROM memo_groups WHERE name=?1", [&name], |row| row.get(0)).optional()
        .map_err(|_| "读取备忘录分组失败")?;
    if existed.is_none() {
        let next: i64 = conn.query_row("SELECT COALESCE(MAX(sort_order),0)+1 FROM memo_groups", [], |row| row.get(0))
            .map_err(|_| "读取备忘录分组失败")?;
        conn.execute("INSERT INTO memo_groups(name,sort_order,created_at) VALUES(?1,?2,?3)", params![name, next, now])
            .map_err(|_| "保存备忘录分组失败")?;
    }
    Ok(name)
}

/// Moves all notes in `name` to `target`, then deletes the group. The target
/// must already exist unless it is the same name.
pub fn delete_group(conn: &mut Connection, name: &str, target: &str, now: i64) -> Result<u64, String> {
    let name = validate_group(name)?;
    let target = validate_group(target)?;
    if groups(conn)?.len() <= 1 {
        return Err("至少保留一个分组".into());
    }
    if name == target {
        return Err("目标分组与要删除的分组相同".into());
    }
    let tx = conn.transaction().map_err(|_| "无法开始删除分组")?;
    let exists: Option<i64> = tx.query_row("SELECT 1 FROM memo_groups WHERE name=?1", [&name], |row| row.get(0)).optional()
        .map_err(|_| "读取备忘录分组失败")?;
    if exists.is_none() {
        return Err("分组不存在或已被删除".into());
    }
    save_group(&tx, &target, now)?;
    let moved = tx.execute("UPDATE memo_notes SET group_name=?1, updated_at=?2 WHERE group_name=?3 AND deleted_at IS NULL", params![target, now, name])
        .map_err(|_| "迁移备忘录分组失败")?;
    tx.execute("DELETE FROM memo_groups WHERE name=?1", [&name]).map_err(|_| "删除备忘录分组失败")?;
    tx.commit().map_err(|_| "提交备忘录分组删除失败")?;
    Ok(moved as u64)
}

fn insert(conn: &Connection, note: &Note, tags: &[String], repeat: &str) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO memo_notes(title,body,group_name,tags_json,account,password,pinned,remind_at,remind_repeat,remind_done_at,created_at,updated_at,deleted_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL)",
        params![note.title, note.body, note.group, tags_json(tags), note.account, note.password,
            i64::from(note.pinned), note.remind_at, repeat, note.remind_done_at, note.created_at, note.updated_at],
    ).map_err(|_| "保存备忘录失败")?;
    Ok(conn.last_insert_rowid())
}

fn sync_reminder(conn: &Connection, note_id: i64, at: Option<i64>) -> Result<(), String> {
    conn.execute("DELETE FROM memo_reminders WHERE note_id=?1 AND fired_at IS NULL", [note_id])
        .map_err(|_| "保存提醒失败")?;
    if let Some(fire_at) = at {
        conn.execute("INSERT INTO memo_reminders(note_id,fire_at) VALUES(?1,?2)", params![note_id, fire_at])
            .map_err(|_| "保存提醒失败")?;
    }
    Ok(())
}

pub fn create(conn: &Connection, input: &NoteInput, now: i64) -> Result<i64, String> {
    let (title, body, group, tags, account, password, repeat, remind_at) = validate_input(input, now)?;
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始保存备忘录")?;
    save_group(&tx, &group, now)?;
    let note = Note {
        id: 0, title, body, group, tags: tags.clone(), account, password, pinned: input.pinned,
        remind_at, remind_repeat: repeat.clone(), remind_done_at: None, created_at: now, updated_at: now, deleted_at: None,
    };
    let id = insert(&tx, &note, &tags, &repeat)?;
    sync_reminder(&tx, id, remind_at)?;
    tx.commit().map_err(|_| "提交备忘录失败")?;
    Ok(id)
}

pub fn update(conn: &Connection, id: i64, patch: &NotePatch, now: i64) -> Result<i64, String> {
    let mut note = get(conn, id)?;
    if let Some(title) = &patch.title {
        let title = retry_note_title(&trimmed(title, MAX_TITLE_CHARS, "标题")?);
        if title.is_empty() { return Err("标题不能为空".into()); }
        note.title = title;
    }
    if let Some(body) = &patch.body {
        if body.chars().count() > MAX_BODY_CHARS { return Err(format!("正文过长，最多 {MAX_BODY_CHARS} 个字符")); }
        note.body = body.replace("\r\n", "\n");
    }
    if let Some(group) = &patch.group { note.group = validate_group(group)?; }
    if let Some(tags) = &patch.tags { note.tags = normalize_tags(tags)?; }
    if let Some(account) = &patch.account { note.account = trimmed(account, MAX_ACCOUNT_CHARS, "账号")?; }
    if let Some(password) = &patch.password {
        if password.chars().count() > MAX_PASSWORD_CHARS { return Err(format!("密码过长，最多 {MAX_PASSWORD_CHARS} 个字符")); }
        note.password = password.clone();
    }
    if let Some(pinned) = patch.pinned { note.pinned = pinned; }
    if let Some(repeat) = &patch.remind_repeat { note.remind_repeat = validate_repeat(repeat)?; }
    let schedule_changed = patch.remind_at.is_some() || patch.remind_repeat.is_some();
    if schedule_changed {
        note.remind_at = validate_remind_at(patch.remind_at, now)?;
    }
    let tags = note.tags.clone();
    let repeat = note.remind_repeat.clone();
    let remind_at = note.remind_at;
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始保存备忘录")?;
    save_group(&tx, &note.group, now)?;
    let changed = tx.execute(
        "UPDATE memo_notes SET title=?1,body=?2,group_name=?3,tags_json=?4,account=?5,password=?6,pinned=?7,remind_at=?8,remind_repeat=?9,updated_at=?10 WHERE id=?11 AND deleted_at IS NULL",
        params![note.title, note.body, note.group, tags_json(&tags), note.account, note.password,
            i64::from(note.pinned), remind_at, repeat, now, id],
    ).map_err(|_| "保存备忘录失败")?;
    if changed == 0 { return Err("备忘录不存在或已被删除".into()); }
    if schedule_changed { sync_reminder(&tx, id, remind_at)?; }
    tx.commit().map_err(|_| "提交备忘录失败")?;
    Ok(id)
}

pub fn get(conn: &Connection, id: i64) -> Result<Note, String> {
    conn.query_row(&format!("SELECT {NOTE_COLUMNS} FROM memo_notes WHERE id=?1 AND deleted_at IS NULL"), [id], row_note)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => "备忘录不存在或已被删除".to_string(),
            _ => "读取备忘录失败".to_string(),
        })
}

/// Moves notes to the recycle bin. Pending reminders are dropped with the note
/// so a trashed memo can never raise a pet alert; restoring re-arms the
/// schedule the note still carries.
pub fn remove(conn: &Connection, ids: &[i64], now: i64) -> Result<u64, String> {
    if ids.is_empty() { return Err("请选择要删除的备忘录".into()); }
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始删除备忘录")?;
    let mut removed = 0;
    for id in ids {
        let changed = tx.execute("UPDATE memo_notes SET deleted_at=?1, pinned=0 WHERE id=?2 AND deleted_at IS NULL", params![now, id])
            .map_err(|_| "删除备忘录失败")?;
        if changed > 0 {
            tx.execute("DELETE FROM memo_reminders WHERE note_id=?1", [id]).map_err(|_| "删除备忘录失败")?;
        }
        removed += changed;
    }
    tx.commit().map_err(|_| "提交备忘录删除失败")?;
    Ok(removed as u64)
}

/// Returns trashed notes to the list and re-arms any schedule they still carry.
pub fn restore(conn: &Connection, ids: &[i64], now: i64) -> Result<u64, String> {
    if ids.is_empty() { return Err("请选择要恢复的备忘录".into()); }
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始恢复备忘录")?;
    let mut restored = 0;
    for id in ids {
        restored += tx.execute("UPDATE memo_notes SET deleted_at=NULL, updated_at=?1 WHERE id=?2 AND deleted_at IS NOT NULL", params![now, id])
            .map_err(|_| "恢复备忘录失败")?;
    }
    let pending: Vec<(i64, Option<i64>, String)> = {
        let mut statement = tx.prepare(&format!(
            "SELECT id, remind_at, remind_repeat FROM memo_notes WHERE deleted_at IS NULL AND id IN ({})",
            ids.iter().map(|_| "?").collect::<Vec<_>>().join(","),
        )).map_err(|_| "恢复备忘录失败")?;
        let rows = statement.query_map(rusqlite::params_from_iter(ids.iter()), |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|_| "恢复备忘录失败")?;
        rows.map(|row| row.map_err(|_| "恢复备忘录失败".to_string())).collect::<Result<Vec<_>, String>>()?
    };
    for (id, remind_at, _repeat) in pending {
        // `remind_at` is the schedule itself; `remind_repeat` only decides what
        // happens after the user completes it. A restored note keeps both.
        let Some(fire_at) = remind_at else { continue };
        tx.execute("DELETE FROM memo_reminders WHERE note_id=?1 AND fired_at IS NULL", [id]).map_err(|_| "恢复提醒失败")?;
        tx.execute("INSERT INTO memo_reminders(note_id,fire_at) VALUES(?1,?2)", params![id, fire_at])
            .map_err(|_| "恢复提醒失败")?;
    }
    tx.commit().map_err(|_| "提交备忘录恢复失败")?;
    Ok(restored as u64)
}

/// Permanently removes trashed notes. Live notes are rejected so the recycle
/// bin stays the only path to irreversible deletion.
pub fn purge(conn: &Connection, ids: &[i64]) -> Result<u64, String> {
    if ids.is_empty() { return Err("请选择要彻底删除的备忘录".into()); }
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始彻底删除备忘录")?;
    let mut purged = 0;
    for id in ids {
        purged += tx.execute("DELETE FROM memo_notes WHERE id=?1 AND deleted_at IS NOT NULL", [id])
            .map_err(|_| "彻底删除备忘录失败")?;
    }
    tx.commit().map_err(|_| "提交彻底删除失败")?;
    Ok(purged as u64)
}

/// Drops trashed rows older than the retention window. Returns how many went.
pub fn purge_expired(conn: &Connection, before: i64) -> Result<u64, String> {
    conn.execute("DELETE FROM memo_notes WHERE deleted_at IS NOT NULL AND deleted_at < ?1", [before])
        .map(|changed| changed as u64)
        .map_err(|_| "清理回收站失败".to_string())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DueReminder {
    pub note_id: i64,
    pub title: String,
    pub summary: String,
    pub fire_at: i64,
}

fn summary_of(body: &str) -> String {
    let line = body.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    line.chars().take(80).collect()
}

pub fn due(conn: &Connection, now: i64) -> Result<Vec<DueReminder>, String> {
    let mut statement = conn
        .prepare("SELECT r.note_id,n.title,n.body,r.fire_at FROM memo_reminders r JOIN memo_notes n ON n.id=r.note_id WHERE r.fired_at IS NULL AND r.fire_at<=?1 AND n.deleted_at IS NULL ORDER BY r.fire_at, r.id")
        .map_err(|_| "读取备忘录提醒失败")?;
    let rows = statement.query_map([now], |row| {
        let body: String = row.get(2)?;
        Ok(DueReminder { note_id: row.get(0)?, title: row.get(1)?, summary: summary_of(&body), fire_at: row.get(3)? })
    }).map_err(|_| "读取备忘录提醒失败")?;
    rows.map(|row| row.map_err(|_| "读取备忘录提醒失败".to_string())).collect()
}

/// Claims due reminders for the pet alert window. A reminder is only returned
/// when this call actually flipped it to fired, so concurrent pollers cannot
/// display the same reminder twice. Fired reminders stay visible until the user
/// completes or snoozes them (see `dismiss_displayed`).
pub fn fire_due(conn: &Connection, now: i64) -> Result<Vec<DueReminder>, String> {
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始处理提醒")?;
    let mut fired = Vec::new();
    for item in due(&tx, now)? {
        let changed = tx.execute("UPDATE memo_reminders SET fired_at=?1 WHERE note_id=?2 AND fire_at=?3 AND fired_at IS NULL", params![now, item.note_id, item.fire_at])
            .map_err(|_| "更新提醒状态失败")?;
        if changed > 0 { fired.push(item); }
    }
    tx.commit().map_err(|_| "提交提醒状态失败")?;
    Ok(fired)
}

/// Marks every displayed reminder as dismissed so the startup check does not
/// resurface an alert the user already handled.
pub fn dismiss_displayed(conn: &Connection) -> Result<u64, String> {
    conn.execute("UPDATE memo_reminders SET dismissed_at=?1 WHERE fired_at IS NOT NULL AND dismissed_at IS NULL", [chrono::Utc::now().timestamp_millis()])
        .map(|changed| changed as u64)
        .map_err(|_| "更新提醒状态失败".to_string())
}

/// Dismisses the alert for one note while leaving its schedule intact.
pub fn dismiss(conn: &Connection, note_id: i64) -> Result<u64, String> {
    conn.execute("UPDATE memo_reminders SET dismissed_at=?1 WHERE note_id=?2 AND fired_at IS NOT NULL AND dismissed_at IS NULL", params![chrono::Utc::now().timestamp_millis(), note_id])
        .map(|changed| changed as u64)
        .map_err(|_| "更新提醒状态失败".to_string())
}

/// Returns a claimed reminder to the pending state so the next poll retries it
/// (used when the alert window could not be shown).
pub fn reopen(conn: &Connection, note_id: i64, fire_at: i64) -> Result<(), String> {
    conn.execute("UPDATE memo_reminders SET fired_at=NULL, dismissed_at=NULL WHERE note_id=?1 AND fire_at=?2 AND dismissed_at IS NULL", params![note_id, fire_at])
        .map(|_| ())
        .map_err(|_| "更新提醒状态失败".to_string())
}

/// Completes a reminder: records the completion time, schedules the next
/// occurrence for repeating notes and drops the fired reminder row.
pub fn complete_reminder(conn: &Connection, note_id: i64, now: i64) -> Result<(), String> {
    let note = get(conn, note_id)?;
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始完成提醒")?;
    tx.execute("DELETE FROM memo_reminders WHERE note_id=?1", [note_id]).map_err(|_| "完成提醒失败")?;
    let next = match (note.remind_at, note.remind_repeat.as_str()) {
        (Some(at), "daily") => Some(at + 86_400_000),
        (Some(at), "weekly") => Some(at + 7 * 86_400_000),
        (Some(at), "monthly") => Some(at + 30 * 86_400_000),
        _ => None,
    };
    tx.execute("UPDATE memo_notes SET remind_at=?1, remind_done_at=?2, updated_at=?3 WHERE id=?4", params![next, now, now, note_id])
        .map_err(|_| "完成提醒失败")?;
    if let Some(at) = next {
        tx.execute("INSERT INTO memo_reminders(note_id,fire_at) VALUES(?1,?2)", params![note_id, at]).map_err(|_| "完成提醒失败")?;
    }
    tx.commit().map_err(|_| "提交提醒完成失败")?;
    Ok(())
}

pub fn snooze_reminder(conn: &Connection, note_id: i64, minutes: i64, now: i64) -> Result<i64, String> {
    if !(1..=24 * 60).contains(&minutes) {
        return Err("稍后提醒时间无效".into());
    }
    let at = now + minutes * 60_000;
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始稍后提醒")?;
    tx.execute("UPDATE memo_reminders SET fire_at=?1, fired_at=NULL WHERE note_id=?2", params![at, note_id]).map_err(|_| "稍后提醒失败")?;
    tx.execute("UPDATE memo_notes SET remind_at=?1 WHERE id=?2", params![at, note_id]).map_err(|_| "稍后提醒失败")?;
    tx.commit().map_err(|_| "提交稍后提醒失败")?;
    Ok(at)
}

/// Seeds the default groups on first use. Existing groups are never touched.
pub fn ensure_groups(conn: &Connection, now: i64) -> Result<(), String> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM memo_groups", [], |row| row.get(0)).map_err(|_| "读取备忘录分组失败")?;
    if count > 0 { return Ok(()); }
    for (index, name) in DEFAULT_GROUPS.iter().enumerate() {
        conn.execute("INSERT OR IGNORE INTO memo_groups(name,sort_order,created_at) VALUES(?1,?2,?3)", params![name, index as i64, now])
            .map_err(|_| "初始化备忘录分组失败")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        ensure_groups(&conn, 1).unwrap();
        conn
    }

    fn input(title: &str) -> NoteInput {
        NoteInput { id: None, title: title.into(), body: "第一行\n第二行".into(), group: "公司".into(), tags: vec!["代码".into(), " 代码 ".into(), "定时提醒".into()], account: "root".into(), password: "p@ss".into(), pinned: false, remind_at: None, remind_repeat: None }
    }

    #[test]
    fn defaults_and_tags_are_normalized() {
        let conn = db();
        assert_eq!(groups(&conn).unwrap(), vec!["公司".to_string(), "个人".to_string()]);
        let id = create(&conn, &input(" 部署脚本 "), 10).unwrap();
        let note = get(&conn, id).unwrap();
        assert_eq!(note.title, "部署脚本");
        assert_eq!(note.tags, vec!["代码".to_string(), "定时提醒".to_string()]);
        assert_eq!(note.group, "公司");
    }

    #[test]
    fn new_group_is_created_on_save() {
        let conn = db();
        let mut value = input("x");
        value.group = " 项目A ".into();
        let id = create(&conn, &value, 10).unwrap();
        assert_eq!(get(&conn, id).unwrap().group, "项目A");
        assert!(groups(&conn).unwrap().contains(&"项目A".to_string()));
    }

    #[test]
    fn invalid_input_is_rejected() {
        let conn = db();
        let mut empty = input("   ");
        assert!(create(&conn, &empty, 10).is_err());
        empty.title = "ok".into();
        empty.remind_at = Some(5);
        assert!(create(&conn, &empty, 10).is_err());
        let mut too_many = input("tags");
        too_many.tags = (0..21).map(|i| format!("t{i}")).collect();
        assert!(create(&conn, &too_many, 10).is_err());
        let mut bad_group = input("g");
        bad_group.group = "  ".into();
        assert!(create(&conn, &bad_group, 10).is_err());
    }

    #[test]
    fn reminders_fire_once_and_repeat() {
        let conn = db();
        let mut value = input("浇水");
        value.remind_at = Some(1000);
        value.remind_repeat = Some("daily".into());
        let id = create(&conn, &value, 10).unwrap();
        assert!(due(&conn, 999).unwrap().is_empty());
        assert_eq!(fire_due(&conn, 1000).unwrap().len(), 1);
        assert_eq!(fire_due(&conn, 1001).unwrap().len(), 0);
        complete_reminder(&conn, id, 1002).unwrap();
        assert!(due(&conn, 1000 + 86_400_000 - 1).unwrap().is_empty());
        assert_eq!(due(&conn, 1000 + 86_400_000).unwrap().len(), 1);
    }

    #[test]
    fn fired_reminders_stay_claimed_until_dismissed() {
        let conn = db();
        let mut value = input("部署");
        value.remind_at = Some(1000);
        let id = create(&conn, &value, 10).unwrap();
        let fired = fire_due(&conn, 1000).unwrap();
        assert_eq!(fired.len(), 1);
        // A second poller never claims the same reminder again.
        assert!(fire_due(&conn, 1001).unwrap().is_empty());
        // Reopening returns it to the pending state after a display failure.
        reopen(&conn, id, 1000).unwrap();
        assert_eq!(fire_due(&conn, 1002).unwrap().len(), 1);
        // Startup cleanup dismisses displayed reminders once.
        assert_eq!(dismiss_displayed(&conn).unwrap(), 1);
        assert_eq!(dismiss_displayed(&conn).unwrap(), 0);
        complete_reminder(&conn, id, 1003).unwrap();
        assert!(due(&conn, 10_000).unwrap().is_empty());
    }

    #[test]
    fn snooze_moves_pending_reminder() {
        let conn = db();
        let mut value = input("s");
        value.remind_at = Some(1000);
        let id = create(&conn, &value, 10).unwrap();
        snooze_reminder(&conn, id, 10, 1000).unwrap();
        assert!(due(&conn, 600_999).unwrap().is_empty());
        assert_eq!(due(&conn, 601_000).unwrap().len(), 1);
    }

    #[test]
    fn schedule_patch_keeps_cleared_state() {
        let missing: NotePatch = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        assert!(missing.remind_at.is_none() && missing.remind_repeat.is_none());
        let cleared: NotePatch = serde_json::from_str(r#"{"remindAt":null,"remindRepeat":"none"}"#).unwrap();
        assert!(cleared.remind_at.is_none());
        let set: NotePatch = serde_json::from_str(r#"{"remindAt":5000,"remindRepeat":"daily"}"#).unwrap();
        assert_eq!(set.remind_at, Some(5000));
        // A cleared schedule must stay cleared even though `remindAt` parses to `None`.
        let conn = db();
        let id = create(&conn, &input("keep"), 10).unwrap();
        update(&conn, id, &serde_json::from_str(r#"{"remindAt":5000,"remindRepeat":"none"}"#).unwrap(), 20).unwrap();
        update(&conn, id, &serde_json::from_str(r#"{"remindAt":null,"remindRepeat":"none"}"#).unwrap(), 30).unwrap();
        assert_eq!(get(&conn, id).unwrap().remind_at, None);
        assert!(due(&conn, 50_000).unwrap().is_empty());
        // Repeating the same cleared patch must not resurrect the reminder.
        update(&conn, id, &serde_json::from_str(r#"{"remindAt":null,"remindRepeat":"none"}"#).unwrap(), 40).unwrap();
        assert!(due(&conn, 50_000).unwrap().is_empty());
    }

    #[test]
    fn update_reschedules_reminders() {
        let conn = db();
        let id = create(&conn, &input("u"), 10).unwrap();
        let patch: NotePatch = serde_json::from_str(r#"{"remindAt":5000,"remindRepeat":"none"}"#).unwrap();
        update(&conn, id, &patch, 20).unwrap();
        assert!(due(&conn, 4999).unwrap().is_empty());
        assert_eq!(due(&conn, 5000).unwrap().len(), 1);
        let patch: NotePatch = serde_json::from_str(r#"{"remindAt":null,"remindRepeat":"none"}"#).unwrap();
        update(&conn, id, &patch, 10_000).unwrap();
        assert!(due(&conn, 10_001).unwrap().is_empty());
    }

    #[test]
    fn deleting_group_moves_notes() {
        let mut conn = db();
        let mut value = input("a");
        value.group = "临时".into();
        create(&conn, &value, 10).unwrap();
        assert_eq!(delete_group(&mut conn, "临时", "个人", 20).unwrap(), 1);
        assert!(groups(&conn).unwrap().iter().all(|g| g != "临时"));
        assert_eq!(list(&conn).unwrap()[0].group, "个人");
    }

    #[test]
    fn password_is_stored_as_entered() {
        let conn = db();
        let mut value = input("账号");
        value.password = "  keep  spaces  ".into();
        let id = create(&conn, &value, 10).unwrap();
        assert_eq!(get(&conn, id).unwrap().password, "  keep  spaces  ");
    }

    #[test]
    fn delete_moves_note_to_trash_and_restore_brings_it_back() {
        let conn = db();
        let id = create(&conn, &input("待删"), 10).unwrap();
        assert_eq!(remove(&conn, &[id], 20).unwrap(), 1);
        // The list hides it and get() reports it as gone.
        assert!(list(&conn).unwrap().is_empty());
        assert!(get(&conn, id).is_err());
        let trashed = list_trashed(&conn).unwrap();
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].deleted_at, Some(20));
        // A second delete does not touch the trashed row.
        assert_eq!(remove(&conn, &[id], 30).unwrap(), 0);
        assert_eq!(restore(&conn, &[id], 40).unwrap(), 1);
        assert!(list_trashed(&conn).unwrap().is_empty());
        assert_eq!(get(&conn, id).unwrap().title, "待删");
    }

    #[test]
    fn trashed_note_stops_raising_reminders_and_restore_rearms_them() {
        let conn = db();
        let mut value = input("提醒");
        value.remind_at = Some(1000);
        let id = create(&conn, &value, 10).unwrap();
        remove(&conn, &[id], 20).unwrap();
        // The reminder row is dropped with the note, so no alert can fire.
        assert!(due(&conn, 10_000).unwrap().is_empty());
        restore(&conn, &[id], 30).unwrap();
        assert_eq!(due(&conn, 1000).unwrap().len(), 1);
    }

    #[test]
    fn purge_only_removes_trashed_notes() {
        let conn = db();
        let live = create(&conn, &input("保留"), 10).unwrap();
        let gone = create(&conn, &input("清除"), 11).unwrap();
        remove(&conn, &[gone], 20).unwrap();
        // A live note is never purged, even when explicitly targeted.
        assert_eq!(purge(&conn, &[live]).unwrap(), 0);
        assert_eq!(purge(&conn, &[gone]).unwrap(), 1);
        assert!(list_trashed(&conn).unwrap().is_empty());
        assert_eq!(get(&conn, live).unwrap().title, "保留");
    }

    #[test]
    fn expired_trash_is_cleaned_up() {
        let conn = db();
        let id = create(&conn, &input("过期"), 10).unwrap();
        remove(&conn, &[id], 100).unwrap();
        // A cutoff newer than the delete time keeps the row.
        assert_eq!(purge_expired(&conn, 50).unwrap(), 0);
        assert_eq!(list_trashed(&conn).unwrap().len(), 1);
        // A cutoff older than it drops the row.
        assert_eq!(purge_expired(&conn, 200).unwrap(), 1);
        assert!(list_trashed(&conn).unwrap().is_empty());
    }

    #[test]
    fn trashed_notes_are_excluded_from_group_moves() {
        let mut conn = db();
        let mut value = input("a");
        value.group = "临时".into();
        let id = create(&conn, &value, 10).unwrap();
        remove(&conn, &[id], 20).unwrap();
        // The trashed note keeps its original group and is not counted as moved.
        assert_eq!(delete_group(&mut conn, "临时", "个人", 30).unwrap(), 0);
        assert_eq!(list_trashed(&conn).unwrap()[0].group, "临时");
    }
}
