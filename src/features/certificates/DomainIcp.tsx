import { useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { platformErrorMessage } from "../../platform/api";
import { icpClient, type IcpResult } from "../../platform/clients/icp";
import { registrableSiteDomain } from "./siteDomains";

export type IcpState = { data?: IcpResult; loading: boolean; error?: string };
export function icpDomain(domain: string) { return registrableSiteDomain(domain); }
export async function queryIcp(domain: string, previous?: IcpResult): Promise<IcpState> {
  try { return { data: await icpClient.query(domain), loading: false }; }
  catch (reason) { return { data: previous, loading: false, error: platformErrorMessage(reason, "备案查询失败，请稍后重试") }; }
}
const fields: Array<[keyof IcpResult, string]> = [
  ["site_beian_code", "网站备案号"], ["company_beian_code", "主体备案号"],
  ["company_name", "主办单位"], ["name", "网站名称"], ["domain", "备案域名"],
  ["website_index", "网站首页"], ["type", "备案类型"], ["verify_time", "审核时间"], ["update_time", "数据更新时间"],
];
export function DomainIcp({ domain, state, onQuery }: { domain: string; state?: IcpState; onQuery: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const target = icpDomain(domain);
  if (!target) return <span className="baota-domain-site-meta">不支持查询</span>;
  const { data, loading = false, error } = state ?? {};
  const summary = data ? data.registered ? data.site_beian_code || data.company_beian_code || "已备案" : "未备案" : "未检测";
  return <>
    <div className="baota-domain-icp" aria-busy={loading} aria-live="polite">
      <span title={summary}>{summary}</span>
      <button type="button" className="baota-domain-copy baota-domain-icp-action" disabled={loading} aria-label={`查看 ${domain} 的备案详情`} onClick={() => setOpen(true)}>查看</button>
    </div>
    {error && <small className="form-error" role="alert">{error}</small>}
    {open && <SharedDialog title="ICP备案详情" subtitle={`${domain} · 使用宝塔服务查询`} icon={<ShieldCheck size={18} aria-hidden="true" />} onClose={() => setOpen(false)} busy={loading} className="baota-icp-dialog" footer={<><button type="button" className="secondary" onClick={() => setOpen(false)}>关闭</button><button type="button" className="primary" disabled={loading} onClick={() => void onQuery()}><RefreshCw size={14} className={loading ? "spin" : undefined} aria-hidden="true" />{loading ? "查询中…" : data ? "重新查询" : "查询备案"}</button></>}>
      <p className="baota-domain-site-meta">按主域名 {target} 查询，子域名与通配符共用备案信息。宝塔有查询次数限制，仅手动点击查询时请求。</p>
      {error && <p className="form-error" role="alert">{error}{data ? "，当前显示上次查询结果。" : ""}</p>}
      <p role="status">{loading ? "正在查询备案信息…" : data ? data.registered ? "已备案" : "宝塔返回未备案" : "尚未取得查询结果"}</p>
      {data && <dl className="baota-icp-fields">{fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{data[key] || "暂无"}</dd></div>)}<div><dt>查询时间</dt><dd>{data.checkedAt ? new Date(data.checkedAt * 1000).toLocaleString("zh-CN") : "暂无"}</dd></div></dl>}
    </SharedDialog>}
  </>;
}
