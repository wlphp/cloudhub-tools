import type { MonitorSettings } from "../../platform/clients/monitorAlerts";
import "./monitor-scope-groups.css";

const groups = [
  { title: "到期监控", items: [["servers", "服务器"], ["lightServers", "轻量服务器"], ["domains", "域名"], ["databases", "云数据库"], ["redis", "Redis"], ["certificates", "HTTPS 证书"]] },
  { title: "宝塔面板监控", items: [["panels", "CPU 使用率"], ["panelDisk", "磁盘使用率"], ["panelServices", "服务状态"], ["panelAccess", "面板访问异常"]] },
] as const;
type ScopeKey = (typeof groups)[number]["items"][number][0];
const scopeDescriptions: Record<ScopeKey, string> = {
  servers: "检查已保存云服务器的到期时间，按设置的提前天数提醒；仅对采集到有效到期时间的资产生效。",
  lightServers: "检查已保存轻量服务器的到期时间，按设置的提前天数提醒；仅对采集到有效到期时间的资产生效。",
  domains: "检查已保存域名的有效期，按设置的提前天数提醒；以采集到的域名到期时间为准。",
  databases: "检查已保存云数据库的到期时间，按设置的提前天数提醒；仅对采集到有效到期时间的资产生效。",
  redis: "检查云 Redis 资源的到期时间；宝塔中的 Redis 服务运行状态由“服务状态”监控。",
  certificates: "检查本地 HTTPS 证书和已同步的宝塔站点证书有效期，按设置的提前天数提醒。",
  panels: "通过宝塔面板检查 CPU 使用率，连续两次达到或超过 CPU 告警阈值时提醒。",
  panelDisk: "通过宝塔面板检查磁盘使用率，连续两次达到或超过磁盘告警阈值时提醒。",
  panelServices: "检查宝塔面板报告的已安装服务：Web、MySQL、Redis、Memcached、FTP（pure-ftpd）；连续两次报告服务停止时提醒。",
  panelAccess: "检查宝塔面板 API 能否正常访问，连续两次访问失败或返回无效监控数据时提醒。",
};
export function MonitorScopeGroups({ settings, disabled, onChange }: { settings: Pick<MonitorSettings, ScopeKey>; disabled: boolean; onChange: (patch: Partial<Pick<MonitorSettings, ScopeKey>>) => void }) {
  return <div className="monitor-scope-groups">{groups.map(group => {
    const count = group.items.filter(([key]) => settings[key]).length;
    const all = count === group.items.length;
    const mixed = count > 0 && !all;
    return <section className="monitor-scope-group" key={group.title} aria-label={group.title}>
      <div className="monitor-scope-group-heading"><label><input type="checkbox" checked={all} aria-checked={mixed ? "mixed" : all} ref={input => { if (input) input.indeterminate = mixed; }} disabled={disabled} onChange={event => onChange(Object.fromEntries(group.items.map(([key]) => [key, event.target.checked])))} /><strong>{group.title}</strong></label><span>{mixed ? "部分选中" : all ? "全部选中" : "未选择"} · {count}/{group.items.length}</span></div>
      <div className="monitor-scope-group-items">{group.items.map(([key, label]) => <label key={key} title={scopeDescriptions[key]}><input type="checkbox" title={scopeDescriptions[key]} checked={settings[key]} disabled={disabled} onChange={event => onChange({ [key]: event.target.checked })} /><span>{label}</span></label>)}</div>
      <details className="monitor-scope-mobile-help"><summary>查看监控内容</summary>{group.items.map(([key, label]) => <p key={key}><strong>{label}：</strong>{scopeDescriptions[key]}</p>)}</details>
    </section>;
  })}</div>;
}
