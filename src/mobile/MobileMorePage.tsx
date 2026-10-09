import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Award, ChevronRight, Database, Folder, Layers, Monitor, Search, Settings, Terminal, X } from "lucide-react";

type Destination = "storage" | "databases" | "redis" | "certificates" | "ssh" | "panels" | "settings";
const features = [
  { tab: "storage", title: "对象存储", description: "桶与文件 · 统一管理 · 便捷高效", keywords: "OSS S3 文件", icon: Folder, color: "#287cff", end: "#233de9" },
  { tab: "databases", title: "云数据库", description: "RDS 实例 · 资源与账号管理", keywords: "数据库 database", icon: Database, color: "#a34aff", end: "#5827e9" },
  { tab: "redis", title: "Redis", description: "实例与账号 · 高性能缓存", keywords: "缓存", icon: Layers, color: "#00bda9", end: "#007c85" },
  { tab: "certificates", title: "证书管理", description: "证书与绑定 · 状态与有效期", keywords: "SSL HTTPS 到期", icon: Award, color: "#ffb63e", end: "#c66937" },
  { tab: "ssh", title: "SSH 终端", description: "连接管理 · 在线终端 · 快速登录", keywords: "主机 服务器 terminal", icon: Terminal, color: "#06c8ec", end: "#1672f2" },
  { tab: "panels", title: "运维面板", description: "集群管理 · 资源监控 · 运维操作", keywords: "宝塔 aaPanel CPU 内存", icon: Monitor, color: "#a145fc", end: "#4d2ce7" },
  { tab: "settings", title: "系统设置", description: "导入数据 · 日志管理 · 应用信息", keywords: "迁移 同步 关于 更新 日志", icon: Settings, color: "#0badcf", end: "#116aa6" },
] satisfies { tab: Destination; title: string; description: string; keywords: string; icon: typeof Folder; color: string; end: string }[];

export function MobileMorePage({ onNavigate }: { onNavigate: (tab: Destination) => void }) {
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  const closeSearch = () => {
    setSearch("");
    setSearchOpen(false);
    searchButton.current?.focus();
  };
  const query = search.trim().toLocaleLowerCase();
  const matches = features.filter((feature) => `${feature.title} ${feature.description} ${feature.keywords}`.toLocaleLowerCase().includes(query));
  return <div className="mobile-more-page">
    <div className="mobile-more-titlebar">
      <h1>更多管理</h1>
      <button ref={searchButton} type="button" className="mobile-more-search-toggle" aria-label={searchOpen ? "关闭功能搜索" : "搜索功能"} aria-expanded={searchOpen} aria-controls="mobile-more-search-field" onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}>
        {searchOpen ? <X size={17} aria-hidden="true" /> : <Search size={17} aria-hidden="true" />}
      </button>
    </div>
    {searchOpen && <label className="mobile-more-search mobile-more-search-expanded"><Search size={16} aria-hidden="true" /><input ref={searchInput} id="mobile-more-search-field" type="search" aria-label="搜索全部功能" placeholder="搜索功能" value={search} onChange={(event) => setSearch(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeSearch(); } }} /></label>}
    <div className="mobile-more-feature-list" aria-label="功能入口">
      {matches.map(({ tab, title, description, icon: Icon, color, end }) => <button type="button" className="mobile-more-feature" key={tab} style={{ "--feature-color": color, "--feature-end": end } as CSSProperties} onClick={() => onNavigate(tab)}>
        <span className="mobile-more-feature-icon"><Icon size={20} strokeWidth={1.9} aria-hidden="true" /></span>
        <span className="mobile-more-feature-copy"><strong>{title}</strong><small>{description}</small></span>
        <ChevronRight size={20} className="mobile-more-feature-chevron" aria-hidden="true" />
      </button>)}
    </div>
    {matches.length === 0 && <div className="mobile-empty"><Search size={26} aria-hidden="true" /><strong>没有匹配的功能</strong><span>试试“存储”“终端”或“设置”。</span><button type="button" className="mobile-domain-back" onClick={() => setSearch("")}>清除搜索</button></div>}
  </div>;
}
