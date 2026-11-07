import { Award, ChevronRight, Cloud, Database, FileText, Folder, GitBranch, Globe2, HardDrive, Layers, Monitor, Server, ShieldCheck, Star, Terminal } from "lucide-react";
import type { Account, LocalAsset } from "../shared/types";

export type MobileFeatureDestination = "accounts" | "assets" | "favorites" | "servers" | "domains" | "storage" | "databases" | "redis" | "certificates" | "ssh" | "panels" | "flow" | "authenticator" | "operationLogs" | "apiLogs";
const mobileFeatures = [
  { tab: "accounts", title: "我的账号", description: "管理本机保存的云账号", keywords: "账号 云账户", icon: Cloud },
  { tab: "assets", title: "我的资产", description: "查看本机已缓存的云资源", keywords: "资产 资源汇总", icon: HardDrive },
  { tab: "favorites", title: "我的收藏", description: "集中查看已收藏的云资源", keywords: "收藏 资产", icon: Star },
  { tab: "servers", title: "服务器", description: "查看云服务器与运行状态", keywords: "云服务器 ECS", icon: Server },
  { tab: "domains", title: "域名与 DNS", description: "管理域名和解析记录", keywords: "域名 DNS 解析", icon: Globe2 },
  { tab: "storage", title: "对象存储", description: "存储桶与文件浏览", keywords: "OSS S3 文件", icon: Folder },
  { tab: "databases", title: "云数据库", description: "RDS 实例与账号管理", keywords: "数据库 database", icon: Database },
  { tab: "redis", title: "Redis", description: "缓存实例与连接信息", keywords: "缓存", icon: Layers },
  { tab: "certificates", title: "证书管理", description: "证书绑定与到期状态", keywords: "SSL HTTPS 到期", icon: Award },
  { tab: "ssh", title: "SSH 终端", description: "主机连接与在线终端", keywords: "主机 服务器 terminal", icon: Terminal },
  { tab: "panels", title: "运维面板", description: "面板连接与资源监控", keywords: "宝塔 aaPanel CPU 内存", icon: Monitor },
  { tab: "flow", title: "云效流水线", description: "运行记录、阶段与日志", keywords: "云效 阿里云 CI CD Flow 发布", icon: GitBranch },
  { tab: "authenticator", title: "身份验证器", description: "动态验证码与加密迁移", keywords: "OTP TOTP HOTP Steam Ente 二步验证", icon: ShieldCheck },
] satisfies { tab: MobileFeatureDestination; title: string; description: string; keywords: string; icon: typeof Folder }[];

const myResourceFeatures = [
  { tab: "servers", title: "服务器", description: "云服务器与轻量应用服务器", keywords: "云服务器 ECS SWAS", icon: Server },
  { tab: "domains", title: "域名", description: "域名与 DNS 解析", keywords: "域名 DNS 解析", icon: Globe2 },
  { tab: "storage", title: "对象存储", description: "对象存储桶与文件", keywords: "OSS S3 文件", icon: Folder },
  { tab: "databases", title: "云数据库", description: "云数据库实例", keywords: "数据库 RDS", icon: Database },
  { tab: "redis", title: "Redis", description: "Redis 缓存实例", keywords: "Redis 缓存", icon: Layers },
  { tab: "servers", title: "轻量应用服务器", description: "轻量应用服务器实例", keywords: "轻量应用服务器 SWAS", icon: Server },
  { tab: "assets", title: "边缘安全加速", description: "边缘安全加速资源", keywords: "ESA 边缘安全加速", icon: ShieldCheck },
] satisfies { tab: MobileFeatureDestination; title: string; description: string; keywords: string; icon: typeof Folder }[];

export function MobileMorePage({ onNavigate, accounts, assets, favoriteCount, sshCount, panelCount }: { onNavigate: (tab: MobileFeatureDestination, resourceType?: "swas" | "esa") => void; accounts: Account[]; assets: LocalAsset[]; favoriteCount: number; sshCount: number; panelCount: number }) {
  const shortcutTabs: MobileFeatureDestination[] = ["accounts", "assets", "favorites", "panels", "ssh"];
  const shortcuts = shortcutTabs.map(tab => mobileFeatures.find(feature => feature.tab === tab)!).filter(Boolean);
  const counts: Record<MobileFeatureDestination, number> = {
    accounts: accounts.length, assets: assets.length, favorites: favoriteCount, servers: assets.filter(asset => asset.resource_type === "ecs").length,
    domains: assets.filter(asset => asset.resource_type === "domain").length, storage: assets.filter(asset => asset.resource_type === "oss").length,
    databases: assets.filter(asset => asset.resource_type === "rds").length, redis: assets.filter(asset => asset.resource_type === "redis").length,
    certificates: 0, ssh: sshCount, panels: panelCount, flow: 0, authenticator: 0, operationLogs: 0, apiLogs: 0,
  };
  const otherFeatures = myResourceFeatures.map(feature => ({ ...feature, count: feature.title === "服务器" ? counts.servers : feature.title === "轻量应用服务器" ? assets.filter(asset => asset.resource_type === "swas").length : feature.title === "边缘安全加速" ? assets.filter(asset => asset.resource_type === "esa").length : counts[feature.tab] }));
  return <div className="mobile-more-page">
    <div className="mobile-more-shortcuts" aria-label="常用功能">
      {shortcuts.map(({ tab, title, icon: Icon }) => <button type="button" key={tab} onClick={() => onNavigate(tab)} aria-label={`${title}，${counts[tab]} 项`}>
        <span className="mobile-more-shortcut-icon"><Icon size={21} strokeWidth={1.8} aria-hidden="true" /></span><span>{title}</span><strong className="mobile-more-count-badge">{counts[tab]}</strong>
      </button>)}
    </div>
    <div className="mobile-more-feature-list" aria-label="功能入口">
      {otherFeatures.map(({ tab, title, description, icon: Icon, count }) => <button type="button" className="mobile-more-feature" key={title} onClick={() => onNavigate(tab, title === "轻量应用服务器" ? "swas" : title === "边缘安全加速" ? "esa" : undefined)}>
        <span className="mobile-more-feature-icon"><Icon size={20} strokeWidth={1.9} aria-hidden="true" /></span>
        <span className="mobile-more-feature-copy"><strong>{title}</strong><small>{description}</small></span>
        <span className="mobile-more-feature-count">（{count}）</span><ChevronRight size={20} className="mobile-more-feature-chevron" aria-hidden="true" />
      </button>)}
    </div>
    <div className="mobile-more-feature-list mobile-more-log-list" aria-label="日志入口">
      <button type="button" className="mobile-more-feature mobile-more-log-feature" onClick={() => onNavigate("operationLogs")}>
        <span className="mobile-more-feature-icon"><FileText size={20} strokeWidth={1.9} aria-hidden="true" /></span>
        <span className="mobile-more-feature-copy"><strong>操作日志</strong><small>查看本机资源管理操作记录</small></span>
        <ChevronRight size={20} className="mobile-more-feature-chevron" aria-hidden="true" />
      </button>
      <button type="button" className="mobile-more-feature mobile-more-log-feature" onClick={() => onNavigate("apiLogs")}>
        <span className="mobile-more-feature-icon"><Terminal size={20} strokeWidth={1.9} aria-hidden="true" /></span>
        <span className="mobile-more-feature-copy"><strong>API 日志</strong><small>查看接口调用记录与执行状态</small></span>
        <ChevronRight size={20} className="mobile-more-feature-chevron" aria-hidden="true" />
      </button>
    </div>
  </div>;
}
