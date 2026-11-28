import { Bot, Cpu, FileCode2, GitBranch, Globe, Gauge, HardDrive, Lock, Mail, MessageCircle, MonitorCog, Network, NotebookPen, PawPrint, ShieldCheck, SquareTerminal, Variable, Power } from "lucide-react";
import { officialPlugins } from "./registry";

export type ApplicationSection = "flow" | "certificates" | "authenticator" | "claude" | "codex" | "frp" | "notes";
// mobile: 该应用提供移动端界面；软件商店“适用端”筛选据此区分移动端可用与仅电脑端，registry 的 platform 只描述桌面系统支持。
const navigation: Record<string, { section?: ApplicationSection; order: number; sidebar: boolean; mobile?: boolean; icon: typeof Cpu; keywords?: string }> = {
  "cloudhub.desktop-pet": { order: 21, sidebar: false, icon: PawPrint, keywords: "桌宠 桌面陪伴 生活提醒 语音唤醒 desktop pet" },
  "cloudhub.model-suppliers": { order: 20, sidebar: false, mobile: true, icon: Bot, keywords: "AI 模型供应商 OpenAI Claude Gemini API 模型 配置 导入" },
  "cloudhub.cloud-drive": { order: 17, sidebar: false, icon: HardDrive, keywords: "云盘 阿里云盘 Alipan 挂载 OSS S3 rclone MinIO R2 WinFsp macFUSE FUSE 磁盘 对象存储" },
  "cloudhub.mail": { order: 15, sidebar: false, mobile: true, icon: Mail, keywords: "邮件 邮箱 收信 发信 QQ 网易 IMAP SMTP email mail" },
  "cloudhub.flow": { section: "flow", order: 1, sidebar: true, mobile: true, icon: GitBranch },
  "cloudhub.certificates": { section: "certificates", order: 2, sidebar: true, mobile: true, icon: Lock },
  "cloudhub.authenticator": { section: "authenticator", order: 3, sidebar: true, mobile: true, icon: ShieldCheck },
  // Claude / Codex 管理依赖本机配置文件与本地进程，未提供移动端界面，不进入商店“移动端可用”列表。
  "cloudhub.claude-providers": { section: "claude", order: 4, sidebar: true, icon: Bot, keywords: "Claude Code 供应商 API 切换 模型 映射" },
  "cloudhub.claude-desktop": { order: 4.5, sidebar: false, icon: MonitorCog, keywords: "Claude Desktop 桌面 供应商 直连 路由 聚合" },
  "cloudhub.codex": { section: "codex", order: 5, sidebar: true, icon: FileCode2 },
  "cloudhub.antigravity": { order: 5.2, sidebar: false, mobile: true, icon: Bot, keywords: "Antigravity Google AI 账号 配额 导入 导出 refresh_token" },
  // Pi 配置在本机 ~/.pi/agent，未提供移动端界面。
  "cloudhub.pi": { order: 5.5, sidebar: false, icon: SquareTerminal, keywords: "Pi pi-coding-agent 编码助手 供应商 模型 models.json 斜杠命令" },
  "cloudhub.frp": { section: "frp", order: 6, sidebar: true, icon: Network },
  "cloudhub.notes": { section: "notes", order: 7, sidebar: true, mobile: true, icon: NotebookPen, keywords: "备忘 笔记 记录 分组 标签 检索 提醒" },
  "cloudhub.wechat-multi": { order: 8, sidebar: false, icon: MessageCircle, keywords: "微信 WeChat Weixin Windows" },
  "cloudhub.hardware-info": { order: 9, sidebar: false, icon: Cpu, keywords: "硬件 设备 系统 CPU 显卡" },
  "cloudhub.wsl-dashboard": { order: 10, sidebar: false, icon: SquareTerminal, keywords: "WSL Linux Ubuntu Debian 发行版" },
  "cloudhub.fingerprint-browser": { order: 11, sidebar: true, icon: Globe, keywords: "Chromium Chrome 代理 浏览器" },
  "cloudhub.lan-devices": { order: 12, sidebar: false, icon: Network, keywords: "局域网 扫描 IP MAC NAS 打印机 端口 LAN" },
  "cloudhub.network-speed": { order: 13, sidebar: false, mobile: true, icon: Gauge, keywords: "网络 测速 下载 上传 带宽 延迟 speedtest Mbps" },
  "cloudhub.http-debug-proxy": { order: 14, sidebar: false, icon: Network, keywords: "HTTP HTTPS Fiddler 抓包 代理 请求 响应 调试" },
  "cloudhub.environment-variables": { order: 16, sidebar: false, icon: Variable, keywords: "环境变量 Environment Variables Path JAVA_HOME 开发 Windows 系统 用户" },
  "cloudhub.startup-manager": { order: 18, sidebar: false, icon: Power, keywords: "开机启动 启动项 服务 计划任务 startup service scheduled task Windows" },
  "cloudhub.windows-toolbox": { order: 19, sidebar: false, icon: MonitorCog, keywords: "Windows 工具箱 桌面图标 已安装应用 系统代理 hosts DNS 屏幕 显示设置" },
};
export const applicationCatalog = officialPlugins.map(definition => ({ ...definition, ...navigation[definition.id] }));
export type ApplicationDefinition = typeof applicationCatalog[number];
export type ApplicationPreference = { order: number; sidebar: boolean; home: boolean };
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
        order: Number.isInteger(value.order) && value.order! >= 1 && value.order! <= 9999 ? value.order! : app.order,
        sidebar: typeof value.sidebar === "boolean" ? value.sidebar : app.sidebar,
        // Keep older clients' sidebar preference intact while migrating the visible store toggle to the home page.
        home: typeof value.home === "boolean" ? value.home : typeof value.sidebar === "boolean" ? value.sidebar : app.sidebar,
      };
    }
    const ordered = [...applicationCatalog].sort((a, b) => (result[a.id]?.order ?? a.order) - (result[b.id]?.order ?? b.order) || a.order - b.order);
    ordered.forEach((app, index) => {
      const current = result[app.id] ?? { order: app.order, sidebar: app.sidebar, home: app.sidebar };
      result[app.id] = { ...current, order: index + 1 };
    });
    return result;
  } catch { return {}; }
}
export function applicationPreference(app: ApplicationDefinition, preferences: ApplicationPreferences): ApplicationPreference {
  const preference = preferences[app.id] ?? { order: app.order, sidebar: app.sidebar, home: app.sidebar };
  // This tool is a first-class navigation destination; older saved preferences may still say hidden.
  return app.id === "cloudhub.fingerprint-browser" ? { ...preference, sidebar: true } : preference;
}
export function sortedApplications(preferences: ApplicationPreferences) {
  return [...applicationCatalog].sort((a, b) => applicationPreference(a, preferences).order - applicationPreference(b, preferences).order || a.order - b.order);
}
