import { Activity, BellRing, Cloud, Database, HardDrive, Server, Star, Monitor, ShieldCheck, GitBranch } from "lucide-react";
export const resourceKinds = [
  { key: "ecs", label: "云服务器", color: "#4f8df7", icon: Server },
  { key: "swas", label: "轻量服务器", color: "#28a879", icon: HardDrive },
  { key: "domain", label: "域名", color: "#9b72e8", icon: Cloud },
  { key: "oss", label: "对象存储", color: "#e6a23c", icon: Database },
  { key: "other", label: "其他资源", color: "#8290a5", icon: Activity },
];
export const homeShortcuts = [
  { label: "账号管理", description: "云账号与同步状态", section: "accounts" as const, icon: Cloud },
  { label: "资产管理", description: "已获取的云资源", section: "resources" as const, icon: HardDrive },
  { label: "监控预警", description: "未解除与历史预警", section: "monitorAlerts" as const, icon: BellRing },
  { label: "服务器", description: "云服务器与轻量服务器", section: "servers" as const, icon: Server },
  { label: "云效流水线", description: "流水线与运行记录", section: "flow" as const, icon: GitBranch },
  { label: "我的收藏", description: "收藏的常用资源", section: "favorites" as const, icon: Star },
  { label: "面板管理", description: "管理已添加的运维面板", section: "panels" as const, icon: Monitor },
  { label: "证书管理", description: "HTTPS 证书与部署", section: "certificates" as const, icon: ShieldCheck },
];

export function formatHomeElapsed(timestamp: number, now = Date.now()) {
  if (!(timestamp > 0)) return "暂无采集记录";
  const elapsed = Math.max(0, now - timestamp);
  const days = Math.floor(elapsed / 86400000);
  if (days < 1) { const hours = Math.floor(elapsed / 3600000); return hours < 1 ? "不到 1 小时前" : `${hours} 小时前`; }
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  const years = Math.floor(months / 12);
  return months % 12 ? `${years} 年 ${months % 12} 个月前` : `${years} 年前`;
}
