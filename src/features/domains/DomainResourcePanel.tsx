import { Globe2, RefreshCw } from "lucide-react";
import type { Account, DomainTool } from "../../shared/types";
import { displayValue } from "../../shared/utils/display";
import { daysUntil, displayDnsServers, domainStatus } from "../resources/presentation";

export function DomainResourcePanel({
  account,
  items,
  loading,
  searchLoading,
  keyword,
  onKeywordChange,
  onSearch,
  onRefresh,
  onOpenTool,
}: {
  account: Account;
  items: Record<string, unknown>[];
  loading: boolean;
  searchLoading: boolean;
  keyword: string;
  onKeywordChange: (value: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  onOpenTool: (kind: DomainTool["kind"], domain: string) => void;
}) {
  const recordCount = items.reduce((sum, item) => sum + Number(item.RecordCount || 0), 0);
  const expiringCount = items.filter((item) => { const days = daysUntil(item.ExpirationDate); return days !== null && days >= 0 && days <= 90; }).length;
  const expiredCount = items.filter((item) => (daysUntil(item.ExpirationDate) ?? 0) < 0).length;
  const unauditedCount = items.filter((item) => item.DomainAuditStatus && item.DomainAuditStatus !== "SUCCEED").length;
  return (
    <div className="domain-reference">
      <div className="domain-toolbar">
        <input value={keyword} onChange={(event) => onKeywordChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onSearch()} placeholder="搜索域名/持有者" />
        <button className="layui-btn" disabled={searchLoading} onClick={onSearch}><RefreshCw className={searchLoading ? "spin" : undefined} size={14} />{searchLoading ? "筛选中…" : "搜索"}</button>
        <button className="layui-btn layui-btn-primary" disabled={loading} onClick={onRefresh}><RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "拉取中…" : "实时拉取"}</button>
      </div>
      <div className="domain-summary"><span>域名总数：<strong>{items.length}</strong></span><span>解析记录：<strong className="blue-text">{recordCount}</strong></span><span>即将到期：<strong className="orange-text">{expiringCount}</strong></span><span>已过期：<strong className="red-text">{expiredCount}</strong></span><span>未实名：<strong className="gray-text">{unauditedCount}</strong></span></div>
      {!items.length ? <div className="domain-empty"><Globe2 size={42} /><p>暂无域名</p></div> : items.map((item, index) => {
        const [status, statusClass] = domainStatus(item);
        const days = daysUntil(item.ExpirationDate);
        const dns = displayDnsServers(item.DnsServers);
        const domain = String(item.DomainName || "");
        return (
          <article className="domain-card" key={domain || index}>
            <div className="domain-header"><div className="domain-name">◉ {displayValue(item.DomainName)}
              {item.NotInDns ? <span className="dns-tag dns-not-added">未添加DNS解析</span> : dns.includes("alidns") || dns.includes("hichina") ? <span className="dns-tag dns-aliyun">{dns.includes("alidns") ? "阿里云DNS" : "万网DNS"}</span> : dns ? <span className="dns-tag dns-other">第三方DNS</span> : null}
              {Boolean(item.DomainType) && <span className="dns-tag domain-type-tag">{displayValue(item.DomainType)}</span>}
              {Boolean(item.RegistrantType) && <span className="registrant-type">{String(item.RegistrantType) === "1" ? "个人" : "企业"}</span>}
              {Boolean(item.DomainAuditStatus) && <span className={`dns-tag ${item.DomainAuditStatus === "SUCCEED" ? "audit-succeed" : item.DomainAuditStatus === "AUDITING" ? "audit-auditing" : "audit-nonaudit"}`}>{item.DomainAuditStatus === "SUCCEED" ? "已认证" : item.DomainAuditStatus === "AUDITING" ? "审核中" : "未认证"}</span>}
            </div><span className={`domain-status ${statusClass}`}>{status}</span></div>
            <div className="domain-info">
              {Boolean(item.RegistrantOrganization) && <div><span>域名持有者：</span><b>{displayValue(item.RegistrantOrganization)}</b></div>}
              {Boolean(item.RegistrationDate) && <div><span>注册时间：</span>{displayValue(item.RegistrationDate)}</div>}
              {Boolean(item.ExpirationDate) && <div><span>到期时间：</span>{displayValue(item.ExpirationDate)} {days !== null && days < 90 && <b className={days < 0 ? "expire-danger" : "expire-warning"}>（{days < 0 ? `已过期 ${Math.abs(days)} 天` : `${days} 天后到期`}）</b>}</div>}
              <div><span>解析记录数：</span><b className="blue-text">{displayValue(item.RecordCount || 0)} 条</b></div>
              {dns && <div><span>DNS服务器：</span>{dns}</div>}
              {Boolean(item.CreateTime) && <div><span>DNS添加时间：</span>{displayValue(item.CreateTime)}</div>}
              {Boolean(item.VersionCode) && <div><span>DNS版本：</span>{displayValue(item.VersionCode)}</div>}
            </div>
            <div className="domain-actions"><button className="layui-btn layui-btn-normal" onClick={() => onOpenTool("dns", domain)}>解析管理</button>{account.cloud_type === "aliyun" && <button className="layui-btn" onClick={() => onOpenTool("logs", domain)}>操作日志</button>}{account.cloud_type === "aliyun" && <button className="layui-btn layui-btn-primary" onClick={() => onOpenTool("whois", domain)}>WHOIS</button>}</div>
          </article>
        );
      })}
    </div>
  );
}
