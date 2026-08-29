export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) {
    return value.length ? value.map(displayValue).join("、") : "-";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("IpAddress" in record) return displayValue(record.IpAddress);
    const values = Object.values(record).filter((item) => item !== null && item !== undefined && item !== "");
    return values.length ? values.map(displayValue).join(", ") : "-";
  }
  return String(value);
}

export function firstAddress(value: unknown): string {
  if (Array.isArray(value)) return firstAddress(value[0]);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return firstAddress(record.IpAddress || record.Address || Object.values(record)[0]);
  }
  return String(value || "").trim();
}

export function formatJson(value: string | null | undefined): string {
  if (!value) return "-";
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function parseDateValue(value: unknown): Date {
  if (typeof value === "number") {
    return new Date(value < 100000000000 ? value * 1000 : value);
  }
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return new Date(numeric < 100000000000 ? numeric * 1000 : numeric);
  }
  return new Date(text);
}

export function formatAssetDate(value: unknown): string {
  if (!value) return "未获取";
  const date = parseDateValue(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatChineseDateTime(value: unknown): string {
  if (!value) return "-";
  const date = parseDateValue(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
