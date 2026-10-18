// Preview-only recycle bin. Mirrors src-tauri/src/commands/trash.rs so the
// browser fallback can list, restore and purge the same soft-deleted rows.
import { readBody, sendError, send } from "../core/http.mjs";
import { database } from "../core/database.mjs";

// The preview database only owns the memo tables; panels, SSH hosts and
// pipelines live in the desktop database, so those kinds simply read as empty.
// Mirrors trash::RECYCLABLE in src-tauri, including the display column and
// whether the primary key is an integer or text.
const RECYCLABLE = [
  ["panel_connections", "面板连接", "name", false],
  ["managed_hosts", "SSH 主机", "name", false],
  ["flow_connections", "云效流水线", "name", false],
  ["memo_notes", "备忘录", "title", false],
  ["cloud_accounts", "云账号", "account_name", false],
  ["certificates", "HTTPS 证书", "primary_domain", false],
  ["authenticator_entries", "身份验证器", "name", true],
  ["codex_accounts", "Codex 账号", "label", false],
];

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

const operations = new Set(["list", "restore", "purge", "empty", "set_scrub_days", "scrub_now"]);

const SCRUB_DAYS_KEY = "trash.scrub_days";
const DEFAULT_SCRUB_DAYS = 30;
const MIN_SCRUB_DAYS = 0;
const MAX_SCRUB_DAYS = 3650;

function tableEntry(table) {
  const found = RECYCLABLE.find(([name]) => name === table);
  if (!found) throw Object.assign(new Error("不支持回收站的数据类型"), { code: "trash" });
  return found;
}

function trashedRows(db, table, column) {
  return db.prepare(`SELECT id, ${column}, deleted_at FROM ${table} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, rowid DESC`).all()
    .map((row) => ({ id: String(row.id), title: String(row[column] ?? "(未命名)"), deletedAt: Number(row.deleted_at) }));
}

/** Ids arrive as strings; the table's key kind decides how each is validated. */
function idsOf(textKey, value) {
  if (!Array.isArray(value) || value.length === 0) throw Object.assign(new Error("请选择要操作的记录"), { code: "trash" });
  return value.map((raw) => {
    const text = String(raw ?? "");
    if (textKey) {
      if (!text.trim()) throw Object.assign(new Error("记录标识无效"), { code: "trash" });
      return text;
    }
    const id = Number(text);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("记录标识无效"), { code: "trash" });
    return id;
  });
}

function scrubDays(db) {
  const row = db.prepare("SELECT value FROM client_preferences WHERE key=?").get(SCRUB_DAYS_KEY);
  const parsed = row ? Number(row.value) : NaN;
  return Number.isInteger(parsed) && parsed >= MIN_SCRUB_DAYS && parsed <= MAX_SCRUB_DAYS ? parsed : DEFAULT_SCRUB_DAYS;
}

/** Credential columns per table; the preview mirrors the desktop allowlist. */
const SECRET_COLUMNS = {
  panel_connections: ["api_key_ciphertext"],
  managed_hosts: ["password_ciphertext", "private_key_ciphertext", "key_passphrase_ciphertext"],
  flow_connections: ["token_ciphertext"],
  memo_notes: [],
  cloud_accounts: ["secret_ciphertext"],
  certificates: ["certificate_pem_ciphertext", "private_key_ciphertext"],
  authenticator_entries: ["ciphertext"],
  codex_accounts: ["auth_ciphertext"],
};

export function scrubExpired(db, cutoff) {
  let total = 0;
  for (const [table] of RECYCLABLE) {
    if (!hasTable(db, table)) continue;
    const columns = SECRET_COLUMNS[table] || [];
    if (columns.length === 0) continue;
    const present = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    const usable = columns.filter((column) => present.includes(column));
    if (usable.length === 0) continue;
    const assignments = usable.map((column) => `${column}=NULL`).join(",");
    const guard = usable.map((column) => `${column} IS NOT NULL`).join(" OR ");
    total += Number(db.prepare(`UPDATE ${table} SET ${assignments} WHERE deleted_at IS NOT NULL AND deleted_at<? AND (${guard})`).run(cutoff).changes);
  }
  return total;
}

/** Applies the retention policy, returning how many rows were cleared. */
function applyScrubPolicy(db, now) {
  const days = scrubDays(db);
  if (days <= 0) return 0;
  return scrubExpired(db, now - days * 86_400_000);
}

export function list(db, now) {
  const scrubbedNow = applyScrubPolicy(db, now);
  return {
    groups: RECYCLABLE.map(([table, label, column]) => ({
      kind: table,
      label,
      items: hasTable(db, table) ? trashedRows(db, table, column).map((item) => ({ kind: table, ...item })) : [],
    })),
    scrubDays: scrubDays(db),
    scrubbedNow,
  };
}

export function setScrubDays(db, days, now) {
  const value = Number(days);
  if (!Number.isInteger(value) || value < MIN_SCRUB_DAYS || value > MAX_SCRUB_DAYS) {
    throw Object.assign(new Error(`保留天数需在 ${MIN_SCRUB_DAYS} 到 ${MAX_SCRUB_DAYS} 之间`), { code: "trash" });
  }
  db.prepare("INSERT INTO client_preferences(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(SCRUB_DAYS_KEY, String(value), now);
  return value;
}

/** Clears credentials on every trashed row immediately, regardless of age. */
export function scrubNow(db, now) {
  return scrubExpired(db, now + 1);
}

export function restore(db, kind, ids, now) {
  const [table, , , textKey] = tableEntry(kind);
  if (!hasTable(db, table)) return 0;
  const values = idsOf(textKey, ids);
  const placeholders = values.map(() => "?").join(",");
  // A restored note re-arms the schedule it still carries.
  const restored = Number(db.prepare(`UPDATE ${table} SET deleted_at=NULL, updated_at=? WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL`).run(now, ...values).changes);
  if (table === "memo_notes") {
    for (const row of db.prepare(`SELECT id, remind_at FROM memo_notes WHERE deleted_at IS NULL AND id IN (${placeholders})`).all(...values)) {
      if (row.remind_at == null) continue;
      db.prepare("DELETE FROM memo_reminders WHERE note_id=? AND fired_at IS NULL").run(row.id);
      db.prepare("INSERT INTO memo_reminders(note_id,fire_at) VALUES(?,?)").run(row.id, Number(row.remind_at));
    }
  }
  return restored;
}

export function purge(db, kind, ids) {
  const [table, , , textKey] = tableEntry(kind);
  if (!hasTable(db, table)) return 0;
  const values = idsOf(textKey, ids);
  return Number(db.prepare(`DELETE FROM ${table} WHERE id IN (${values.map(() => "?").join(",")}) AND deleted_at IS NOT NULL`).run(...values).changes);
}

export function empty(db) {
  let total = 0;
  db.exec("BEGIN");
  try {
    for (const [table] of RECYCLABLE) {
      if (!hasTable(db, table)) continue;
      const ids = db.prepare(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL`).all().map((row) => String(row.id));
      if (ids.length > 0) total += purge(db, table, ids);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
  return total;
}

export async function handleTrashRoute(req, res, url) {
  if (url.pathname !== "/api/trash") return false;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { sendError(res, 405, "trash", "回收站仅支持 POST 请求"); return true; }
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "") || !String(req.headers["content-type"] || "").startsWith("application/json")) {
    sendError(res, 403, "trash", "回收站仅接受本机 JSON 请求"); return true;
  }
  try {
    const body = JSON.parse(await readBody(req, 1024 * 1024));
    if (!body || typeof body !== "object" || !operations.has(body.op)) { sendError(res, 400, "trash", "回收站请求无效"); return true; }
    const db = database();
    const now = Date.now();
    let result;
    switch (body.op) {
      case "list": result = list(db, now); break;
      case "restore": result = restore(db, body.kind, body.ids, now); break;
      case "purge": result = purge(db, body.kind, body.ids); break;
      case "empty": result = empty(db); break;
      case "set_scrub_days": result = setScrubDays(db, body.days, now); break;
      case "scrub_now": result = scrubNow(db, now); break;
      default: sendError(res, 400, "trash", "回收站请求无效"); return true;
    }
    send(res, 200, result ?? null);
  } catch (error) {
    const clientError = Boolean(error && error.code === "trash");
    sendError(res, clientError ? 400 : 500, "trash", clientError ? error.message : "回收站请求格式无效或执行失败");
  }
  return true;
}
