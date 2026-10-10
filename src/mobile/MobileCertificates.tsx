import { useState } from "react";
import { Award, CalendarDays, ChevronDown, Plus, Search, ScanLine, ShieldCheck } from "lucide-react";
import type { CertificateSummary } from "../platform/clients/certificates";
import "./mobile-certificates.css";

import { certificateHealth } from "./certificate-health";

const date = (value?: number | null) => value && Number.isFinite(value) ? new Date(value * 1000).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }) : "待补全";
const provider = (value: string) => ({ letsencrypt: "Let's Encrypt", litessl: "LiteSSL" })[value as "letsencrypt" | "litessl"] || value;

export function MobileCertificates({ items, loading, onSync, onRequest }: { items: CertificateSummary[]; loading: boolean; onSync: () => void; onRequest: () => void }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const now = Date.now();
  const states = items.map((item) => ({ item, health: certificateHealth(item, now) }));
  const expiring = states.filter(({ health }) => health.key === "expiring").length;
  const expired = states.filter(({ health }) => health.key === "expired").length;
  const filtered = states.filter(({ item, health }) => (filter === "all" || health.key === filter) && [item.primaryDomain, ...item.domains, item.issuer, provider(item.provider)].join(" ").toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a,b) => (a.item.notAfter ?? Infinity) - (b.item.notAfter ?? Infinity) || a.item.primaryDomain.localeCompare(b.item.primaryDomain));
  return <div className="mobile-certificates">
    <div className="mobile-cert-title"><div><h1>证书管理</h1><p>域名证书与有效期</p></div><div className="mobile-cert-title-actions"><button type="button" onClick={onSync}><ScanLine size={16} aria-hidden="true" />同步</button><button type="button" onClick={onRequest}><Plus size={16} aria-hidden="true" />申请证书</button></div></div>
    <div className="mobile-cert-stats" aria-label="证书统计">
      <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}><span>全部证书</span><strong>{items.length}</strong></button>
      <button type="button" data-state="expiring" aria-pressed={filter === "expiring"} onClick={() => setFilter(filter === "expiring" ? "all" : "expiring")}><span>即将到期</span><strong>{expiring}<small>30 天内</small></strong></button>
      <button type="button" data-state="expired" aria-pressed={filter === "expired"} onClick={() => setFilter(filter === "expired" ? "all" : "expired")}><span>已过期</span><strong>{expired}</strong></button>
    </div>
    <div className="mobile-cert-tools"><label><Search size={16} aria-hidden="true" /><input aria-label="搜索证书域名或签发者" placeholder="搜索域名、签发者…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="筛选证书状态" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option><option value="valid">有效</option><option value="expiring">即将到期</option><option value="expired">已过期</option><option value="pending">签发中 / 未生效</option><option value="failed">失败 / 吊销</option><option value="unknown">有效期待补全</option></select></div>
    <div className="mobile-cert-list-heading"><h2>域名证书 <span>{filtered.length}</span></h2><span>按到期时间</span></div>
    {loading && !items.length ? <div className="mobile-cert-empty" role="status">正在读取证书…</div> : !filtered.length ? <div className="mobile-cert-empty"><span className="mobile-cert-empty-icon"><Award size={25} aria-hidden="true" /></span><strong>{items.length ? "没有匹配的证书" : "还没有同步证书"}</strong><p>{items.length ? "试试其他关键词或查看全部状态" : "从电脑同步证书，随时查看域名与到期时间"}</p><button type="button" onClick={items.length ? () => { setSearch(""); setFilter("all"); } : onSync}>{items.length ? "清除筛选" : "从电脑同步"}</button></div> : <div className="mobile-cert-list">{filtered.map(({ item, health }) => <article className="mobile-cert-card" key={item.id} data-state={health.key}>
      <div className="mobile-cert-card-heading"><span className="mobile-cert-icon"><ShieldCheck size={19} aria-hidden="true" /></span><div><h3>{item.primaryDomain}</h3><p>{provider(item.issuer || item.provider)}</p></div><span className="mobile-cert-status">{health.label}</span></div>
      <div className="mobile-cert-validity"><span><CalendarDays size={14} aria-hidden="true" />{date(item.notAfter)} 到期</span><strong>{health.days === null ? health.label : health.key === "expired" ? `已过期 ${Math.abs(health.days)} 天` : <>{health.days}<small> 天剩余</small></>}</strong></div>
      <details><summary><span>{item.domains.length} 个域名 · 证书详情</span><ChevronDown size={14} aria-hidden="true" /></summary><dl><div><dt>覆盖域名</dt><dd>{item.domains.join("、")}</dd></div><div><dt>有效期</dt><dd>{date(item.notBefore)} 至 {date(item.notAfter)}</dd></div><div><dt>签发机构</dt><dd>{item.issuer ? provider(item.issuer) : "待补全"}</dd></div><div><dt>证书服务</dt><dd>{provider(item.provider)}</dd></div>{item.serialNumber && <div><dt>序列号</dt><dd>{item.serialNumber}</dd></div>}</dl></details>
    </article>)}</div>}
  </div>;
}
