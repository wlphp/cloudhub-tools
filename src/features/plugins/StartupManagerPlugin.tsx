import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleCheck, Ellipsis, Loader2, Power, RefreshCw, Search, ShieldCheck, Undo2 } from "lucide-react";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MoreMenu } from "../../shared/MoreMenu";
import { runningInTauri, runningOnPhone } from "../../platform/api";
import { nativeOnly } from "../../platform/clients/base";
import "./startup-manager.css";

type Kind = "startup" | "task" | "service";
type Entry = { id: string; kind: Kind; name: string; detail: string; source: string; status: string; recommendation: string; canChange: boolean; iconData?: string | null };
type Snapshot = { supported: boolean; entries: Entry[] };
type Target = { item: Entry; enabled: boolean };
const tabs: { id: Kind; title: string }[] = [{ id: "startup", title: "启动项" }, { id: "service", title: "服务项" }, { id: "task", title: "计划任务" }];
const ignoredKey = "cloudhub.startup-manager.ignored.v1";
const historyKey = "cloudhub.startup-manager.history.v1";
function readList(key: string): string[] { try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
function StartupIcon({ entry }: { entry: Entry }) {
  const [failed, setFailed] = useState(false);
  return <span className="startup-manager-icon-box">{entry.iconData && !failed ? <img className="startup-manager-app-icon" src={entry.iconData} alt="" loading="lazy" onError={() => setFailed(true)} /> : <Power size={17} aria-hidden="true" />}</span>;
}

export function StartupManagerPlugin() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<Kind>("startup");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(runningInTauri && !runningOnPhone);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [ignored, setIgnored] = useState<string[]>(() => readList(ignoredKey));
  const [history, setHistory] = useState<string[]>(() => readList(historyKey));
  const [hideDisabled, setHideDisabled] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const refresh = useCallback(async () => {
    if (!runningInTauri || runningOnPhone) return;
    setBusy(true); setError("");
    try { setSnapshot(await nativeOnly<Snapshot>("startup_manager_list")); }
    catch (reason) { setError(typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "读取系统管理信息失败"); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const entries = useMemo(() => (snapshot?.entries ?? []).filter(item => item.kind === tab && !ignored.includes(item.id) && !(hideDisabled && item.status === "已禁用") && `${item.name} ${item.detail} ${item.source}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [snapshot, tab, query, ignored, hideDisabled]);
  function setIgnoredItems(next: string[]) { setIgnored(next); try { localStorage.setItem(ignoredKey, JSON.stringify(next)); } catch { /* 忽略清单是可选的本地偏好 */ } }
  async function apply() {
    if (!target) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await nativeOnly<void>("startup_manager_set", { request: { kind: target.item.kind, id: target.item.id, enabled: target.enabled } });
      const nextHistory = [`${new Date().toLocaleString()} · ${target.item.name} · ${target.enabled ? "启用" : "禁用"}`, ...history].slice(0, 100);
      setHistory(nextHistory); try { localStorage.setItem(historyKey, JSON.stringify(nextHistory)); } catch { /* 操作已成功，不因记录不可用而回滚 */ }
      setMessage(`${target.item.name}已${target.enabled ? "启用" : "禁用"}。`); setTarget(null); await refresh();
    } catch (reason) { setError(typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "操作失败，请刷新后重试"); }
    finally { setBusy(false); }
  }

  return <section className="startup-manager">
    <header className="startup-manager-heading"><div><h2><Power size={19} aria-hidden="true" />系统启动管理</h2><p>管理各类软件的开机启动；所有系统更改均逐项确认。</p></div><button type="button" className="secondary" onClick={() => void refresh()} disabled={!runningInTauri || runningOnPhone || busy}><RefreshCw size={14} aria-hidden="true" />刷新</button></header>
    <div className="startup-manager-summary"><span className="startup-manager-summary-icon"><ShieldCheck size={17} aria-hidden="true" /></span><strong>Windows 启动环境</strong><span>{snapshot?.entries.filter(item => item.kind === "startup").length ?? "—"} 个启动项</span><span>{snapshot?.entries.filter(item => item.kind === "startup" && item.canChange).length ?? "—"} 个可调整</span><span className="startup-manager-summary-note">更改前会逐项确认</span></div>
    {(!runningInTauri || runningOnPhone) && <p className="startup-manager-notice" role="status">{runningOnPhone ? "系统启动管理只支持 Windows 桌面客户端，手机端暂不支持。" : "系统启动管理只支持 Windows 桌面客户端；浏览器预览不提供本机系统控制。"}</p>}
    {runningInTauri && snapshot && !snapshot.supported && <p className="startup-manager-notice" role="status">当前平台暂不支持此功能。</p>}
    <div className="startup-manager-safety"><ShieldCheck size={16} aria-hidden="true" /><span>安全范围：启动项仅支持当前用户 Run/RunOnce 项逐项启停，并可恢复原值；系统级和其他来源只读。计划任务与服务仍按保护规则逐项调整。</span></div>
    <div className="startup-manager-controls"><nav className="startup-manager-tabs" aria-label="系统项目类别">{tabs.map(item => <button key={item.id} type="button" aria-pressed={tab === item.id} className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>{item.title}<span>{snapshot?.entries.filter(entry => entry.kind === item.id).length ?? "—"}</span></button>)}</nav>
    <div className="startup-manager-toolbar"><label htmlFor="startup-manager-search">筛选</label><div><Search size={14} aria-hidden="true" /><input id="startup-manager-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="名称、说明或来源" /></div></div></div>
    {error && <p className="startup-manager-error" role="alert">{error}</p>}{message && <p className="startup-manager-feedback" role="status">{message}</p>}
    {busy && snapshot && <p className="startup-manager-refreshing" role="status"><Loader2 size={14} aria-hidden="true" />正在刷新系统项目…</p>}
    {busy && !snapshot ? <div className="startup-manager-loading" role="status" aria-live="polite" aria-busy="true"><div className="startup-manager-loading-title"><Loader2 size={17} aria-hidden="true" /><span><strong>正在扫描本机启动配置</strong><small>正在读取启动项、服务和计划任务，首次加载可能需要几秒</small></span></div><div className="startup-manager-skeleton" aria-hidden="true"><div className="startup-manager-skeleton-head"><i /><i /><i /><i /><i /></div>{Array.from({ length: 7 }, (_, index) => <div className="startup-manager-skeleton-row" key={index}><span className="skeleton-name"><i /><b><i /><i /></b></span><i /><i /><i /><i /></div>)}</div></div> : entries.length === 0 ? <div className="startup-manager-empty">{snapshot ? "没有符合条件的项目。" : error ? "读取未完成，请检查错误后重试。" : "请使用 Windows 桌面客户端查看。"}{error && runningInTauri && <button type="button" className="secondary" onClick={() => void refresh()} disabled={busy}>重试</button>}</div> :
      <div className="startup-manager-table-wrap"><table className="startup-manager-table"><thead><tr><th>名称</th><th>当前状态</th><th>官方建议</th><th>设置启用方式</th><th aria-label="更多操作" /></tr></thead><tbody>{entries.map(item => {
        const enabled = item.status !== "已禁用";
        return <tr key={item.id}><td data-label="名称"><StartupIcon entry={item} /><span className="startup-manager-item-copy"><strong>{item.name}</strong><small title={`${item.detail} · ${item.source}`}>{item.detail || item.source || "无说明"}</small></span></td><td data-label="当前状态"><span className={enabled ? "startup-state is-enabled" : "startup-state"}>{item.status}</span></td><td data-label="官方建议">{item.recommendation}</td><td data-label="设置启用方式">{item.canChange ? <select aria-label={`设置启动方式：${item.name}`} className={`startup-manager-policy ${enabled ? "is-allowed" : "is-blocked"}`} value={enabled ? "enabled" : "disabled"} disabled={busy} onChange={event => setTarget({ item, enabled: event.target.value === "enabled" })}><option value="enabled">✓　允许启动</option><option value="disabled">⊖　禁止启动</option></select> : <span className="startup-readonly">只读</span>}</td><td className="startup-manager-more-cell"><MoreMenu triggerClassName="startup-manager-more" triggerIcon={<Ellipsis size={18} aria-hidden="true" />} triggerTitle={`更多操作：${item.name}`} triggerAriaLabel={`更多操作：${item.name}`} items={[{ id: "ignore", label: "忽略此项", icon: <Undo2 size={14} aria-hidden="true" />, onSelect: () => setIgnoredItems([...ignored, item.id]) }, ...(item.canChange ? [{ id: "disable", label: enabled ? "禁用此项" : "恢复此项", icon: enabled ? <Power size={14} aria-hidden="true" /> : <CircleCheck size={14} aria-hidden="true" />, onSelect: () => setTarget({ item, enabled: !enabled }) }] : []), { id: "info", label: `来源：${item.source || "未知"}`, icon: <ShieldCheck size={14} aria-hidden="true" />, disabled: true }]} /></td></tr>;
      })}</tbody></table></div>}
    <footer className="startup-manager-footer"><label><input type="checkbox" checked={hideDisabled} onChange={event => setHideDisabled(event.target.checked)} />隐藏已禁用的启动项</label><div><button type="button" onClick={() => setShowHistory(value => !value)}>优化记录（{history.length}）</button><button type="button" onClick={() => setShowIgnored(value => !value)}>忽略区（{ignored.length}）</button></div></footer>
    {showHistory && <section className="startup-manager-panel"><h3>操作记录</h3>{history.length ? <ul>{history.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p>暂无操作记录</p>}</section>}
    {showIgnored && <section className="startup-manager-panel"><h3>忽略区</h3>{ignored.length ? <ul>{ignored.map(id => { const item = snapshot?.entries.find(entry => entry.id === id); return <li key={id}><span>{item?.name ?? "已不存在的项目"}</span><button type="button" onClick={() => setIgnoredItems(ignored.filter(value => value !== id))}>恢复显示</button></li>; })}</ul> : <p>暂无忽略项目</p>}</section>}
    {target && <ConfirmDialog title={target.enabled ? "启用系统项目" : "禁用系统项目"} confirmLabel={target.enabled ? "确认启用" : "确认禁用"} busy={busy} error={error} message={target.item.kind === "service" ? `将把服务“${target.item.name}”的启动类型设为${target.enabled ? "自动" : "禁用"}。不会停止正在运行的服务；禁用可能影响依赖此服务的软件。确认继续吗？` : target.item.kind === "startup" ? target.enabled ? `将把“${target.item.name}”的原始启动值恢复到当前用户 Run/RunOnce 注册表位置。若同名值已存在，系统会拒绝覆盖。确认继续吗？` : `将从当前用户 Run/RunOnce 移除“${target.item.name}”的启动值，并把原值和类型保存在 CloudHub Tools 恢复区；不会删除程序文件。确认继续吗？` : `将${target.enabled ? "启用" : "禁用"}计划任务“${target.item.name}”（${target.item.source}）。它可能影响系统维护或相关软件行为，建议先确认用途。确认继续吗？`} onResolve={confirmed => { if (confirmed) void apply(); else setTarget(null); }} />}
  </section>;
}
