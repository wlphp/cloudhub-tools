// Panel metric formatting helpers. Pure functions extracted from src/App.tsx so
// the panel UI components can consume them without dragging the giant shell.

import { displayValue } from "../../shared/utils/display.ts";
import { formatMetric } from "../../shared/utils/format.ts";

export interface PanelDiskInfo {
  path: string;
  detail: string;
  percent: number | null;
}

export function panelAddress(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value.replace(/^https?:\/\//, "").split(/[/:?#]/)[0] || value;
  }
}

export function hiddenPanelAddress(value: string): string {
  const address = panelAddress(value);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    const parts = address.split(".");
    return `${parts[0]}.***.***.${parts[3]}`;
  }
  return address.includes(":") ? "****" : address;
}

export function panelMetricNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return null;
}

export function panelMetricRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function panelMetricField(value: unknown, keys: string[]): unknown {
  const record = panelMetricRecord(value);
  return record
    ? keys
        .map((key) => record[key])
        .find((item) => item !== undefined && item !== null && item !== "")
    : undefined;
}

export function panelPercent(value: unknown): number | null {
  const percent = panelMetricNumber(value);
  return percent === null
    ? null
    : Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
}

export function formatPanelNumber(value: unknown): string {
  const number = panelMetricNumber(value);
  return number === null ? displayValue(value) : formatMetric(number);
}

export function panelLoadText(value: unknown): string {
  const values = Array.isArray(value)
    ? value.slice(0, 3)
    : [
        panelMetricField(value, ["one"]),
        panelMetricField(value, ["five"]),
        panelMetricField(value, ["fifteen"]),
      ];
  const visible = values
    .filter((item) => item !== undefined && item !== null && item !== "")
    .map(formatPanelNumber);
  return visible.length ? visible.join(" / ") : "-";
}

export function panelCpuInfo(value: unknown): { detail: string; percent: number | null } {
  const usage = Array.isArray(value)
    ? value[0]
    : panelMetricField(value, ["used_percent", "usage", "used", "cpuRealUsed"]);
  const cores = Array.isArray(value)
    ? value[1]
    : panelMetricField(value, ["cores", "cpuNum", "count"]);
  const percent = panelPercent(usage);
  const coreText =
    cores === undefined || cores === null || cores === "" ? "-" : `${formatPanelNumber(cores)} 核`;
  return {
    detail: percent === null ? coreText : `${coreText} (${formatPanelNumber(percent)}%)`,
    percent,
  };
}

export function panelMemoryInfo(value: unknown): { detail: string; percent: number | null } {
  const used = panelMetricField(value, ["used", "memRealUsed", "realUsed"]);
  const total = panelMetricField(value, ["total", "memTotal"]);
  const unit = String(panelMetricField(value, ["unit"]) || "MB");
  const calculated =
    panelMetricNumber(used) !== null &&
    panelMetricNumber(total) !== null &&
    Number(total) > 0
      ? (Number(used) / Number(total)) * 100
      : null;
  const percent = panelPercent(
    panelMetricField(value, ["used_percent", "percent", "usage"]) ?? calculated,
  );
  if (used === undefined || total === undefined) return { detail: "-", percent };
  return {
    detail: `${formatPanelNumber(used)} / ${formatPanelNumber(total)} ${unit}${
      percent === null ? "" : ` (${formatPanelNumber(percent)}%)`
    }`,
    percent,
  };
}

export function formatPanelStorage(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  if (/^\d+(?:\.\d+)?\s*G$/i.test(text)) return text.replace(/\s*G$/i, " GB");
  if (/^\d+(?:\.\d+)?\s*M$/i.test(text)) return text.replace(/\s*M$/i, " MB");
  return text;
}

export function panelDiskItems(value: unknown): PanelDiskInfo[] {
  const record = panelMetricRecord(value);
  const disks = Array.isArray(value)
    ? value
    : Array.isArray(record?.volumes)
      ? record.volumes
      : [value];
  return disks
    .map((disk) => {
      const size = panelMetricField(disk, ["size"]);
      const used =
        panelMetricField(disk, ["used", "use"]) ?? (Array.isArray(size) ? size[1] : undefined);
      const total =
        panelMetricField(disk, ["total", "size_total"]) ??
        (Array.isArray(size) ? size[0] : undefined);
      const percent = panelPercent(
        panelMetricField(disk, ["used_percent", "percent", "usage"]) ??
          (Array.isArray(size) ? size[3] : undefined),
      );
      const path = panelMetricField(disk, ["path", "rname", "mount"]);
      return {
        path: String(path || "-"),
        detail:
          used === undefined || total === undefined
            ? "-"
            : `${formatPanelStorage(used)} / ${formatPanelStorage(total)}${
                percent === null ? "" : ` (${formatPanelNumber(percent)}%)`
              }`,
        percent,
      };
    })
    .sort((left, right) =>
      left.path === "/" ? -1 : right.path === "/" ? 1 : left.path.localeCompare(right.path),
    );
}

export function panelDiskInfo(value: unknown): PanelDiskInfo {
  return panelDiskItems(value)[0] || { path: "-", detail: "-", percent: null };
}

export function panelNetworkInfo(value: unknown): { up: string; down: string } {
  const record = panelMetricRecord(value);
  const directUp = panelMetricField(value, ["up", "upload"]);
  const directDown = panelMetricField(value, ["down", "download"]);
  const interfaces = Object.entries(record || {}).filter(([, item]) => panelMetricRecord(item));
  const legacyRate = (keys: string[]) => {
    let hasValue = false;
    const total = interfaces.reduce((sum, [, item]) => {
      const amount = panelMetricNumber(panelMetricField(item, keys));
      if (amount === null) return sum;
      hasValue = true;
      return sum + amount;
    }, 0);
    return hasValue ? total : null;
  };
  const up = panelMetricNumber(directUp) ?? legacyRate(["up", "upload"]);
  const down = panelMetricNumber(directDown) ?? legacyRate(["down", "download"]);
  const rate = (amount: number | null) => {
    if (amount === null) return "-";
    const units = ["KB", "MB", "GB", "TB"];
    let value = amount;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${formatMetric(value)} ${units[index]}/s`;
  };
  return { up: rate(up), down: rate(down) };
}
