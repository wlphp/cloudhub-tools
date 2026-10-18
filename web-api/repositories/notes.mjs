// Preview-only memo store. It mirrors src-tauri/src/core/repositories/notes.rs so the
// browser fallback behaves like the desktop app; note text is never logged.
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 200_000;
const MAX_ACCOUNT_CHARS = 512;
const MAX_PASSWORD_CHARS = 2048;
const MAX_GROUP_CHARS = 20;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 16;
const MAX_REMIND_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const DEFAULT_GROUPS = ["公司", "个人"];

function notesError(message) {
  return Object.assign(new Error(message), { code: "notes" });
}

function length(text) {
  return [...text].length;
}

function trimmed(value, max, label) {
  const text = String(value ?? "").trim();
  if (length(text) > max) throw notesError(`${label}过长，最多 ${max} 个字符`);
  return text;
}

function normalizeTags(tags) {
  if (tags == null) return [];
  if (!Array.isArray(tags)) throw notesError("标签格式无效");
  const seen = [];
  for (const tag of tags) {
    const text = trimmed(tag, MAX_TAG_CHARS, "标签");
    if (text && !seen.includes(text)) seen.push(text);
  }
  if (seen.length > MAX_TAGS) throw notesError(`标签过多，最多 ${MAX_TAGS} 个`);
  return seen;
}

function validateGroup(group) {
  const text = trimmed(group, MAX_GROUP_CHARS, "分组名");
  if (!text) throw notesError("请选择或填写分组");
  return text;
}

function validateRepeat(repeat) {
  const value = repeat == null ? "none" : String(repeat);
  if (!["none", "daily", "weekly", "monthly"].includes(value)) throw notesError("提醒重复方式无效");
  return value;
}

function validateRemindAt(value, now) {
  if (value == null) return null;
  const at = Number(value);
  if (!Number.isSafeInteger(at) || at <= now) throw notesError("提醒时间必须晚于当前时间");
  if (at - now > MAX_REMIND_MS) throw notesError("提醒时间过远，最多提前十年");
  return at;
}

function validateInput(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw notesError("备忘录请求无效");
  const title = trimmed(input.title, MAX_TITLE_CHARS, "标题");
  if (!title) throw notesError("标题不能为空");
  const body = String(input.body ?? "");
  if (length(body) > MAX_BODY_CHARS) throw notesError(`正文过长，最多 ${MAX_BODY_CHARS} 个字符`);
  const account = trimmed(input.account, MAX_ACCOUNT_CHARS, "账号");
  const password = String(input.password ?? "");
  if (length(password) > MAX_PASSWORD_CHARS) throw notesError(`密码过长，最多 ${MAX_PASSWORD_CHARS} 个字符`);
  return {
    title,
    body: body.replace(/\r\n/g, "\n"),
    group: validateGroup(input.group),
    tags: normalizeTags(input.tags),
    account,
    password,
    pinned: input.pinned === true ? 1 : 0,
    remindRepeat: validateRepeat(input.remindRepeat),
    remindAt: validateRemindAt(input.remindAt, now),
  };
}

function toNote(row) {
  let tags = [];
  try {
    const parsed = JSON.parse(row.tags_json);
    if (Array.isArray(parsed)) tags = parsed.filter((tag) => typeof tag === "string");
  } catch {
    tags = [];
  }
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body,
    group: row.group_name,
    tags,
    account: row.account,
    password: row.password,
    pinned: row.pinned === 1,
    remindAt: row.remind_at == null ? null : Number(row.remind_at),
    remindRepeat: row.remind_repeat,
    remindDoneAt: row.remind_done_at == null ? null : Number(row.remind_done_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
  };
}

const NOTE_COLUMNS = "id,title,body,group_name,tags_json,account,password,pinned,remind_at,remind_repeat,remind_done_at,created_at,updated_at,deleted_at";

export function ensureGroups(db, now) {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM memo_groups").get();
  if (Number(count) > 0) return;
  DEFAULT_GROUPS.forEach((name, index) => {
    db.prepare("INSERT OR IGNORE INTO memo_groups(name,sort_order,created_at) VALUES(?,?,?)").run(name, index, now);
  });
}

function saveGroup(db, name, now) {
  const existing = db.prepare("SELECT sort_order FROM memo_groups WHERE name=?").get(name);
  if (existing) return name;
  const { next } = db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM memo_groups").get();
  db.prepare("INSERT INTO memo_groups(name,sort_order,created_at) VALUES(?,?,?)").run(name, Number(next), now);
  return name;
}

function summaryOf(body) {
  const line = String(body || "").split("\n").find((item) => item.trim()) || "";
  return [...line.trim()].slice(0, 80).join("");
}

function dueRows(db, now) {
  return db.prepare(
    "SELECT r.note_id,n.title,n.body,r.fire_at FROM memo_reminders r JOIN memo_notes n ON n.id=r.note_id WHERE r.fired_at IS NULL AND r.fire_at<=? AND n.deleted_at IS NULL ORDER BY r.fire_at, r.id",
  ).all(now).map((row) => ({
    noteId: Number(row.note_id), title: row.title, summary: summaryOf(row.body), fireAt: Number(row.fire_at),
  }));
}

function syncReminder(db, noteId, at) {
  db.prepare("DELETE FROM memo_reminders WHERE note_id=? AND fired_at IS NULL").run(noteId);
  if (at != null) db.prepare("INSERT INTO memo_reminders(note_id,fire_at) VALUES(?,?)").run(noteId, at);
}

function getNote(db, id) {
  const row = db.prepare(`SELECT ${NOTE_COLUMNS} FROM memo_notes WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!row) throw notesError("备忘录不存在或已被删除");
  return toNote(row);
}

export function snapshot(db, now) {
  // Heal a fired-but-unhandled reminder the same way the desktop app does.
  db.prepare("UPDATE memo_reminders SET dismissed_at=? WHERE fired_at IS NOT NULL AND dismissed_at IS NULL").run(now);
  ensureGroups(db, now);
  const notes = db.prepare(`SELECT ${NOTE_COLUMNS} FROM memo_notes WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC, id DESC`).all().map(toNote);
  const trashed = db.prepare(`SELECT ${NOTE_COLUMNS} FROM memo_notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`).all().map(toNote);
  const groups = db.prepare("SELECT name FROM memo_groups ORDER BY sort_order, created_at, name").all().map((row) => row.name);
  return { notes, groups, reminders: dueRows(db, now), trashed };
}

export function save(db, input, now) {
  const value = validateInput(input, now);
  const id = Number(input.id);
  const tagsJson = JSON.stringify(value.tags);
  let noteId;
  db.exec("BEGIN");
  try {
    saveGroup(db, value.group, now);
    if (Number.isSafeInteger(id) && id > 0) {
      getNote(db, id);
      db.prepare(
        "UPDATE memo_notes SET title=?,body=?,group_name=?,tags_json=?,account=?,password=?,pinned=?,remind_at=?,remind_repeat=?,updated_at=? WHERE id=? AND deleted_at IS NULL",
      ).run(value.title, value.body, value.group, tagsJson, value.account, value.password, value.pinned, value.remindAt, value.remindRepeat, now, id);
      syncReminder(db, id, value.remindAt);
      noteId = id;
    } else {
      const result = db.prepare(
        "INSERT INTO memo_notes(title,body,group_name,tags_json,account,password,pinned,remind_at,remind_repeat,remind_done_at,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,NULL)",
      ).run(value.title, value.body, value.group, tagsJson, value.account, value.password, value.pinned, value.remindAt, value.remindRepeat, now, now);
      noteId = Number(result.lastInsertRowid);
      syncReminder(db, noteId, value.remindAt);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
  return noteId;
}

/** Moves notes to the recycle bin and drops their pending reminders. */
export function remove(db, ids, now) {
  if (!Array.isArray(ids) || ids.length === 0) throw notesError("请选择要删除的备忘录");
  let removed = 0;
  db.exec("BEGIN");
  try {
    for (const raw of ids) {
      const id = Number(raw);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const changes = Number(db.prepare("UPDATE memo_notes SET deleted_at=?, pinned=0 WHERE id=? AND deleted_at IS NULL").run(now, id).changes);
      if (changes > 0) db.prepare("DELETE FROM memo_reminders WHERE note_id=?").run(id);
      removed += changes;
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
  return removed;
}

/** Returns trashed notes to the list and re-arms the schedules they still carry. */
export function restore(db, ids, now) {
  if (!Array.isArray(ids) || ids.length === 0) throw notesError("请选择要恢复的备忘录");
  const targets = ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  let restored = 0;
  db.exec("BEGIN");
  try {
    for (const id of targets) {
      restored += Number(db.prepare("UPDATE memo_notes SET deleted_at=NULL, updated_at=? WHERE id=? AND deleted_at IS NOT NULL").run(now, id).changes);
    }
    for (const id of targets) {
      const note = db.prepare("SELECT remind_at FROM memo_notes WHERE id=? AND deleted_at IS NULL").get(id);
      if (!note || note.remind_at == null) continue;
      db.prepare("DELETE FROM memo_reminders WHERE note_id=? AND fired_at IS NULL").run(id);
      db.prepare("INSERT INTO memo_reminders(note_id,fire_at) VALUES(?,?)").run(id, Number(note.remind_at));
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
  return restored;
}

/** Irreversibly removes trashed notes; live notes are never touched. */
export function purge(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw notesError("请选择要彻底删除的备忘录");
  let purged = 0;
  db.exec("BEGIN");
  try {
    for (const raw of ids) {
      const id = Number(raw);
      if (Number.isSafeInteger(id) && id > 0) purged += Number(db.prepare("DELETE FROM memo_notes WHERE id=? AND deleted_at IS NOT NULL").run(id).changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
  return purged;
}

export function saveGroupName(db, name, now) {
  return saveGroup(db, validateGroup(name), now);
}

export function deleteGroup(db, name, target, now) {
  const source = validateGroup(name);
  const destination = validateGroup(target);
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM memo_groups").get();
  if (Number(count) <= 1) throw notesError("至少保留一个分组");
  if (source === destination) throw notesError("目标分组与要删除的分组相同");
  db.exec("BEGIN");
  try {
    if (!db.prepare("SELECT 1 AS ok FROM memo_groups WHERE name=?").get(source)) throw notesError("分组不存在或已被删除");
    saveGroup(db, destination, now);
    const moved = db.prepare("UPDATE memo_notes SET group_name=?, updated_at=? WHERE group_name=? AND deleted_at IS NULL").run(destination, now, source);
    db.prepare("DELETE FROM memo_groups WHERE name=?").run(source);
    db.exec("COMMIT");
    return Number(moved.changes);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

function reminderNoteId(id) {
  const noteId = Number(id);
  if (!Number.isSafeInteger(noteId) || noteId <= 0) throw notesError("备忘录不存在或已被删除");
  return noteId;
}

export function dismiss(db, id, now) {
  const noteId = reminderNoteId(id);
  return Number(db.prepare("UPDATE memo_reminders SET dismissed_at=? WHERE note_id=? AND fired_at IS NOT NULL AND dismissed_at IS NULL").run(now, noteId).changes);
}

function dismissDisplayed(db, now) {
  db.prepare("UPDATE memo_reminders SET dismissed_at=? WHERE fired_at IS NOT NULL AND dismissed_at IS NULL").run(now);
}

export function completeReminder(db, id, now) {
  const noteId = reminderNoteId(id);
  const note = getNote(db, noteId);
  dismissDisplayed(db, now);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM memo_reminders WHERE note_id=?").run(noteId);
    const step = { daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000 }[note.remindRepeat];
    const next = note.remindAt != null && step ? note.remindAt + step : null;
    db.prepare("UPDATE memo_notes SET remind_at=?, remind_done_at=?, updated_at=? WHERE id=?").run(next, now, now, noteId);
    if (next != null) db.prepare("INSERT INTO memo_reminders(note_id,fire_at) VALUES(?,?)").run(noteId, next);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
}

export function snoozeReminder(db, id, minutes, now) {
  const noteId = reminderNoteId(id);
  const delay = Number(minutes);
  if (!Number.isInteger(delay) || delay < 1 || delay > 24 * 60) throw notesError("稍后提醒时间无效");
  getNote(db, noteId);
  dismissDisplayed(db, now);
  const at = now + delay * 60_000;
  db.exec("BEGIN");
  try {
    const changed = db.prepare("UPDATE memo_reminders SET fire_at=?, fired_at=NULL WHERE note_id=?").run(at, noteId);
    if (Number(changed.changes) === 0) db.prepare("INSERT INTO memo_reminders(note_id,fire_at) VALUES(?,?)").run(noteId, at);
    db.prepare("UPDATE memo_notes SET remind_at=? WHERE id=?").run(at, noteId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
  return at;
}
