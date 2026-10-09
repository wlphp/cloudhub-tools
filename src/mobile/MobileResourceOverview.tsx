import { ArrowUpDown, Cloud, Filter, Search, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type Props = {
  title: string;
  description: string;
  icon: LucideIcon;
  count: number;
  countLabel: string;
  secondaryCount: number;
  secondaryLabel: string;
  search: string;
  onSearch: (value: string) => void;
  ascending: boolean;
  onSort: () => void;
  filter?: ReactNode;
  actions?: ReactNode;
};

export function MobileResourceOverview({ title, description, icon: Icon, count, countLabel, secondaryCount, secondaryLabel, search, onSearch, ascending, onSort, filter, actions }: Props) {
  return <>
    <section className="mobile-domain-hero mobile-resource-hero" aria-label={`${title}资源库`}>
      <div className="mobile-account-hero-copy"><p>本机资源管理</p><h1>{title}</h1><span>{description}</span></div>
      <div className="mobile-account-hero-art" aria-hidden="true"><span className="mobile-account-orbit" /><Cloud className="mobile-account-hero-cloud" size={60} /><Icon className="mobile-domain-hero-globe" size={44} /></div>
    </section>
    <div className="mobile-domain-overview"><div className="mobile-domain-stats" aria-label={`${title}统计`}>
      <div><span className="mobile-account-stat-icon"><Icon size={21} aria-hidden="true" /></span><span className="mobile-account-stat-copy"><strong>{count}</strong><small>{countLabel}</small></span></div>
      <div className="domain-stat-accounts"><span className="mobile-account-stat-icon"><Cloud size={21} aria-hidden="true" /></span><span className="mobile-account-stat-copy"><strong>{secondaryCount}</strong><small>{secondaryLabel}</small></span></div>
    </div></div>
    {actions && <div className="mobile-resource-page-actions">{actions}</div>}
    <div className={`mobile-resource-tools${filter ? " has-filter" : ""}`}>
      <label className="mobile-account-search"><Search size={18} aria-hidden="true" /><input type="search" aria-label={`搜索${title}`} placeholder={`搜索${title}名称 / 账号 / 状态…`} value={search} onChange={(event) => onSearch(event.currentTarget.value)} /></label>
      {filter && <label className="mobile-account-provider-filter"><Filter size={16} aria-hidden="true" />{filter}</label>}
    </div>
    <div className="mobile-domain-list-heading"><h2>{title}列表 <span>{count}</span></h2><button className="mobile-account-sort" type="button" aria-label={`按名称${ascending ? "升序" : "降序"}排列`} onClick={onSort}><ArrowUpDown size={16} aria-hidden="true" />{ascending ? "按名称" : "名称倒序"}</button></div>
    {search && <button className="mobile-resource-clear" type="button" onClick={() => onSearch("")}>清除搜索{count === 0 ? " · 没有匹配结果，请尝试其他关键词" : ""}</button>}
  </>;
}
