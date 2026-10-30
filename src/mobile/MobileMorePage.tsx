import { useEffect, useRef, useState } from "react";
import { Award, ChevronRight, Database, Folder, GitBranch, Layers, Monitor, Search, Settings, ShieldCheck, Terminal, X } from "lucide-react";

type Destination = "storage" | "databases" | "redis" | "certificates" | "ssh" | "panels" | "flow" | "authenticator" | "settings";
const features = [
  { tab: "storage", title: "对象存储", description: "存储桶与文件浏览", keywords: "OSS S3 文件", icon: Folder },
  { tab: "databases", title: "云数据库", description: "RDS 实例与账号管理", keywords: "数据库 database", icon: Database },
  { tab: "redis", title: "Redis", description: "缓存实例与连接信息", keywords: "缓存", icon: Layers },
  { tab: "certificates", title: "证书管理", description: "证书绑定与到期状态", keywords: "SSL HTTPS 到期", icon: Award },
  { tab: "ssh", title: "SSH 终端", description: "主机连接与在线终端", keywords: "主机 服务器 terminal", icon: Terminal },
  { tab: "panels", title: "运维面板", description: "面板连接与资源监控", keywords: "宝塔 aaPanel CPU 内存", icon: Monitor },
  { tab: "flow", title: "云效流水线", description: "运行记录、阶段与日志", keywords: "云效 阿里云 CI CD Flow 发布", icon: GitBranch },
  { tab: "authenticator", title: "身份验证器", description: "动态验证码与加密迁移", keywords: "OTP TOTP HOTP Steam Ente 二步验证", icon: ShieldCheck },
  { tab: "settings", title: "系统设置", description: "外观、数据同步与更新", keywords: "迁移 同步 关于 更新 日志 导入", icon: Settings },
] satisfies { tab: Destination; title: string; description: string; keywords: string; icon: typeof Folder }[];

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
      {matches.map(({ tab, title, description, icon: Icon }) => <button type="button" className="mobile-more-feature" key={tab} onClick={() => onNavigate(tab)}>
        <span className="mobile-more-feature-icon"><Icon size={20} strokeWidth={1.9} aria-hidden="true" /></span>
        <span className="mobile-more-feature-copy"><strong>{title}</strong><small>{description}</small></span>
        <ChevronRight size={20} className="mobile-more-feature-chevron" aria-hidden="true" />
      </button>)}
    </div>
    {matches.length === 0 && <div className="mobile-empty"><Search size={26} aria-hidden="true" /><strong>没有匹配的功能</strong><span>试试“存储”“终端”或“设置”。</span><button type="button" className="mobile-domain-back" onClick={() => setSearch("")}>清除搜索</button></div>}
  </div>;
}
