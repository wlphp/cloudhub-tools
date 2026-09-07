const MAX_LOG_JSON_BYTES = 32 * 1024;
const LOG_RETENTION_MILLIS = 90 * 24 * 60 * 60 * 1000;

function sensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[_.-]/g, "");
  return ["secret", "token", "authorization", "signature", "password", "privatekey", "passphrase", "ciphertext", "assertion"].some((needle) => normalized.includes(needle));
}

function sanitize(value, key = null) {
  if (key && sensitiveKey(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, sanitize(child, name)]));
  return value;
}

export function serializeLogValue(value) {
  const serialized = JSON.stringify(sanitize(value ?? {}));
  if (Buffer.byteLength(serialized, "utf8") <= MAX_LOG_JSON_BYTES) return serialized;
  return JSON.stringify({ truncated: true, bytes: Buffer.byteLength(serialized, "utf8") });
}

export function pruneLogs(db, now = Date.now()) {
  const cutoff = Math.max(0, now - LOG_RETENTION_MILLIS);
  db.prepare("DELETE FROM api_logs WHERE created_at < ?").run(cutoff);
  db.prepare("DELETE FROM operation_logs WHERE created_at < ?").run(cutoff);
}

export { MAX_LOG_JSON_BYTES, LOG_RETENTION_MILLIS };
