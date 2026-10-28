import { Bot, Cpu, FileCode2, GitBranch, Globe, Gauge, HardDrive, Lock, Mail, MessageCircle, Network, NotebookPen, ShieldCheck, SquareTerminal } from "lucide-react";
import { officialPlugins } from "./registry";

export type ApplicationSection = "flow" | "certificates" | "authenticator" | "claude" | "codex" | "frp" | "notes";
const navigation: Record<string, { section?: ApplicationSection; order: number; sidebar: boolean; icon: typeof Cpu; keywords?: string }> = {
  "cloudhub.cloud-drive": { order: 150, sidebar: false, icon: HardDrive, keywords: "云盘 挂载 OSS S3 rclone MinIO R2 WinFsp 磁盘 对象存储" },
  "cloudhub.mail": { order: 140, sidebar: false, icon: Mail, keywords: "邮件 邮箱 收信 发信 QQ 网易 IMAP SMTP email mail" },
  "cloudhub.flow": { section: "flow", order: 10, sidebar: true, icon: GitBranch },
  "cloudhub.certificates": { section: "certificates", order: 20, sidebar: true, icon: Lock },
  "cloudhub.authenticator": { section: "authenticator", order: 30, sidebar: true, icon: ShieldCheck },
  "cloudhub.claude-providers": { section: "claude", order: 40, sidebar: true, icon: Bot, keywords: "Claude Code 供应商 API 切换 模型 映射" },
  "cloudhub.codex": { section: "codex", order: 50, sidebar: true, icon: FileCode2 },
  "cloudhub.frp": { section: "frp", order: 60, sidebar: true, icon: Network },
  "cloudhub.notes": { section: "notes", order: 70, sidebar: true, icon: NotebookPen, keywords: "备忘 笔记 记录 分组 标签 检索 提醒" },
  "cloudhub.wechat-multi": { order: 80, sidebar: false, icon: MessageCircle, keywords: "微信 WeChat Weixin Windows" },
  "cloudhub.hardware-info": { order: 90, sidebar: false, icon: Cpu, keywords: "硬件 设备 系统 CPU 显卡" },
  "cloudhub.wsl-dashboard": { order: 100, sidebar: false, icon: SquareTerminal, keywords: "WSL Linux Ubuntu Debian 发行版" },
  "cloudhub.fingerprint-browser": { order: 110, sidebar: false, icon: Globe, keywords: "Chromium Chrome 代理 浏览器" },
  "cloudhub.lan-devices": { order: 120, sidebar: false, icon: Network, keywords: "局域网 扫描 IP MAC NAS 打印机 端口 LAN" },
  "cloudhub.network-speed": { order: 130, sidebar: false, icon: Gauge, keywords: "网络 测速 下载 上传 带宽 延迟 speedtest Mbps" },
};
export const applicationCatalog = officialPlugins.map(definition => ({ ...definition, ...navigation[definition.id] }));
export type ApplicationDefinition = typeof applicationCatalog[number];
export type ApplicationPreference = { order: number; sidebar: boolean };
export type ApplicationPreferences = Record<string, ApplicationPreference>;
export const APPLICATION_PREFERENCES_KEY = "cloudhub.application-navigation";

export function parseApplicationPreferences(raw: string | null | undefined): ApplicationPreferences {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: ApplicationPreferences = {};
    for (const app of applicationCatalog) {
      const value = (parsed as Record<string, Partial<ApplicationPreference>>)[app.id];
      if (!value || typeof value !== "object") continue;
      result[app.id] = {
        order: Number.isInteger(value.order) && value.order! >= 0 && value.order! <= 9999 ? value.order! : app.order,
        sidebar: typeof value.sidebar === "boolean" ? value.sidebar : app.sidebar,
      };
    }
    return result;
  } catch { return {}; }
}
export function applicationPreference(app: ApplicationDefinition, preferences: ApplicationPreferences): ApplicationPreference {
  return preferences[app.id] ?? { order: app.order, sidebar: app.sidebar };
}
export function sortedApplications(preferences: ApplicationPreferences) {
  return [...applicationCatalog].sort((a, b) => applicationPreference(a, preferences).order - applicationPreference(b, preferences).order || a.order - b.order);
}
