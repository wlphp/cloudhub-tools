import type { AiFields } from "../../platform/clients/ai";
import type { ManagedHost } from "../../shared/types";

export type ServerAiCandidate = {
  fields: AiFields;
  errors: string[];
  duplicateOf: string | null;
};

function text(fields: AiFields, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value.trim() : "";
}

function hostKey(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").toLocaleLowerCase();
}

function validHost(host: string): boolean {
  if (!host || host.length > 253 || /[\s/@\\]/.test(host)) return false;
  if (host.includes(":")) {
    try { return new URL(`http://[${hostKey(host)}]/`).hostname.length > 2; } catch { return false; }
  }
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*\.?$/i.test(host);
}

function identity(fields: AiFields): string {
  return [hostKey(text(fields, "host")), String(fields.port ?? ""), text(fields, "username").toLocaleLowerCase(), text(fields, "platform").toLocaleLowerCase()].join("|");
}

export function reviewServerAiCandidates(items: AiFields[], existing: ManagedHost[]): ServerAiCandidate[] {
  const seen = new Map<string, number>();
  return items.map((source, index) => {
    const fields = Object.fromEntries(Object.entries(source).filter(([key]) => ["name", "host", "port", "platform", "username", "group_name", "tags", "remark"].includes(key))) as AiFields;
    for (const key of ["name", "host", "username", "group_name", "tags", "remark", "platform"]) {
      if (typeof fields[key] === "string") fields[key] = (fields[key] as string).trim();
    }
    const name = text(fields, "name"), host = text(fields, "host"), username = text(fields, "username");
    const port = fields.port;
    const platform = text(fields, "platform").toLocaleLowerCase();
    if (platform) fields.platform = platform;
    const errors: string[] = [];
    if (!name || name.length > 128) errors.push("名称必填且不超过128个字符");
    if (!validHost(host)) errors.push("主机地址格式无效");
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) errors.push("端口须为1至65535的整数");
    if (!username || username.length > 128) errors.push("用户名必填且不超过128个字符");
    if (platform !== "linux" && platform !== "windows") errors.push("操作系统只能是 Linux 或 Windows");
    for (const key of ["group_name", "tags", "remark"]) {
      const value = fields[key];
      if (value != null && (typeof value !== "string" || value.length > 2048)) errors.push(`${key}长度无效`);
    }
    let duplicateOf: string | null = null;
    if (validHost(host) && typeof port === "number" && Number.isInteger(port) && username && platform) {
      const key = identity(fields);
      const duplicate = existing.find((item) => identity({ host: item.host, port: item.port, username: item.username, platform: item.platform }) === key);
      if (duplicate) duplicateOf = `已存在：${duplicate.name}`;
      else if (seen.has(key)) duplicateOf = `与候选 ${seen.get(key)! + 1} 重复`;
      else seen.set(key, index);
    }
    return { fields, errors, duplicateOf };
  });
}
