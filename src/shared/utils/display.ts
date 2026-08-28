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
