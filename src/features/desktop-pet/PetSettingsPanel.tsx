import { PetPortrait } from "./PetPortrait";
import { useEffect, useState } from "react";
import { Bell, Check, ChevronDown, PawPrint, RefreshCw } from "lucide-react";
import { petAppearances } from "./appearances";
import { PetLifeSettings } from "./PetLifeSettings";
import { SharedDialog } from "../../shared/SharedDialog";
import { listen } from "@tauri-apps/api/event";
import { runningInTauri, platformErrorMessage } from "../../platform/api";
import { defaultPetSettings, defaultPetLife, petSeverityLabel, sortPetAlerts, desktopPetClient as client, type PetSettings, type PetSnapshot } from "../../platform/clients/desktopPet";
import "./desktop-pet.css";

export function PetSettingsPanel({ embedded = false }: { embedded?: boolean }) {
  const [settings, setSettings] = useState<PetSettings>(defaultPetSettings);
  const [snapshot, setSnapshot] = useState<PetSnapshot>({ alerts: [], checkedAt: 0, lastError: null });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(embedded);
  const [history, setHistory] = useState(false);
  useEffect(() => {
    if (!runningInTauri) return;
    let disposed = false;
    void Promise.all([client.settings(), client.snapshot()]).then(([s, a]) => {
      if (disposed) return;
      if (!isPetSettings(s) || !isPetSnapshot(a)) { setError("桌宠设置或提醒状态无效，请重启应用后重试。"); return; }
      setSettings({ ...s, life: { ...defaultPetLife, ...s.life } }); setSnapshot(a); setReady(true);
    }).catch(e => { if (!disposed) setError(platformErrorMessage(e)); });
    const events = [listen<PetSettings>("pet-settings-changed", e => { if (!disposed) setSettings(e.payload); }), listen<PetSnapshot>("pet-alerts-changed", e => { if (!disposed) setSnapshot(e.payload); })];
    return () => { disposed = true; events.forEach(p => void p.then(unlisten => unlisten())); };
  }, []);
  async function work(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(platformErrorMessage(e)); } finally { setBusy(false); } }
  async function change(patch: Partial<PetSettings>) { const next = { ...settings, ...patch }; await work(async () => { await client.save(next); setSettings(next); }); }
  async function changeLife(life: PetSettings["life"]) {
    const next = { ...settings, life };
    setBusy(true); setError("");
    try { await client.save(next); setSettings(next); }
    finally { setBusy(false); }
  }
  const toggle = (key: "enabled" | "monitoring" | "panels" | "panelAccess" | "certificates" | "servers" | "sound" | "reducedMotion" | "quiet" | "keepInTray", label: string, detail?: string, disabled = false) => <label className="pet-option"><span>{label}{detail && <small>{detail}</small>}</span><input type="checkbox" disabled={!ready || busy || disabled} checked={settings[key]} onChange={e => void change({ [key]: e.target.checked })} /></label>;
  return <section className={expanded ? "pet-settings-section is-expanded" : "pet-settings-section"} aria-label="桌宠与运维预警">
    <div className="pet-settings-heading"><PawPrint size={20} /><div className="pet-settings-title"><strong>桌宠与运维预警</strong><small>桌宠陪伴与后台巡检独立开启</small></div><div className="pet-settings-summary" aria-label="桌宠与预警状态">
      <span className={settings.enabled ? "is-on" : "is-off"}><i aria-hidden="true" />桌宠 {settings.enabled ? "已启用" : "已关闭"}</span>
      <span className={settings.monitoring ? "is-on" : "is-off"}><i aria-hidden="true" />运维预警 {settings.monitoring ? "已启用" : "已关闭"}</span>
      {snapshot.alerts.some(alert => alert.active && !alert.ignored) && <span className="pet-summary-alert">{snapshot.alerts.filter(alert => alert.active && !alert.ignored).length} 项待处理</span>}
    </div>{!embedded && <button className="pet-settings-expand" aria-expanded={expanded} aria-controls="pet-settings-content" onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开"}<ChevronDown size={15} /></button>}</div>
    {expanded && <div id="pet-settings-content">
    {!runningInTauri ? <p>桌宠、后台巡检和托盘驻留仅支持桌面应用，浏览器预览不可用。</p> : <>
      {error && <p role="alert" className="pet-error">{error}</p>}
      <div className="pet-settings-columns">
        <article className="pet-control-card pet-companion-card">
          <header><div><PetPortrait appearance={settings.appearance} className="pet-settings-portrait" /><strong>桌宠陪伴</strong><small>点击宠物查看提醒，拖动可移动</small></div>{toggle("enabled", "启用桌宠")}</header>
          <details className="pet-settings-disclosure"><summary>桌宠外观与行为</summary><div className="pet-settings-detail-grid">
            <label className="pet-option">宠物形象<select disabled={!ready || busy} value={settings.appearance} onChange={e => void change({ appearance: e.target.value as PetSettings["appearance"] })}>{Object.entries(petAppearances).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
            <label className="pet-option">桌宠大小<select disabled={!ready || busy} value={settings.size} onChange={e => void change({ size: Number(e.target.value) })}><option value={80}>特小</option><option value={120}>小</option><option value={160}>中</option><option value={200}>大</option></select></label>
            <label className="pet-option">活动范围<select disabled={!ready || busy} value={settings.roam} onChange={e => void change({ roam: e.target.value as PetSettings["roam"] })}><option value="edge">沿屏幕下沿</option><option value="free">屏幕内漫游</option><option value="still">原地陪伴</option></select></label>
            <label className="pet-option">活跃程度<select disabled={!ready || busy} value={settings.activity} onChange={e => void change({ activity: Number(e.target.value) })}><option value={0}>安静</option><option value={1}>适中</option><option value={2}>活泼</option></select></label>
            {toggle("reducedMotion", "减少动态", "遵循系统减少动态设置", !settings.enabled)}
            {toggle("sound", "互动声音", "默认静音", !settings.enabled)}
          </div><div className="pet-settings-actions"><button className="secondary" disabled={!ready || busy || !settings.enabled} onClick={() => void work(client.show)}>显示桌宠</button><button className="secondary" disabled={!ready || busy || !settings.enabled} onClick={() => void work(() => client.move(0, 0, true, true))}>重置位置</button></div></details>
        </article>
        <article className="pet-control-card pet-monitor-card">
          <header><div><strong>运维提醒</strong><small>独立后台巡检，退出或休眠时暂停</small></div>{toggle("monitoring", "启用运维预警")}</header>
          <details className="pet-settings-disclosure"><summary>检查范围与提醒规则</summary><div className="pet-settings-subchecks pet-check-scope">
            {toggle("certificates", "HTTPS 证书到期", undefined, !settings.monitoring)}
            {toggle("servers", "服务器到期", undefined, !settings.monitoring)}
            {toggle("panels", "宝塔资源与服务巡检", undefined, !settings.monitoring)}
            {toggle("panelAccess", "面板访问异常", undefined, !settings.monitoring)}
          </div><p className="pet-severity-note">超级严重：面板连续两次访问异常、磁盘连续两次超阈值、HTTPS 证书进入到期提醒范围。</p><div className="pet-settings-detail-grid">
            <label className="pet-option">巡检间隔<select disabled={!ready || busy || !settings.monitoring} value={settings.intervalSeconds} onChange={e => void change({ intervalSeconds: Number(e.target.value) })}><option value={60}>1 分钟</option><option value={300}>5 分钟</option><option value={900}>15 分钟</option></select></label>
            <label className="pet-option">到期提醒<select disabled={!ready || busy || !settings.monitoring} value={settings.expiryDays} onChange={e => void change({ expiryDays: Number(e.target.value) })}><option value={7}>提前 7 天</option><option value={30}>提前 30 天</option><option value={60}>提前 60 天</option></select></label>
            {(["cpuThreshold", "diskThreshold"] as const).map(key => <label className="pet-option" key={key}>{key === "cpuThreshold" ? "CPU" : "磁盘"}告警阈值<select disabled={!ready || busy || !settings.monitoring} value={settings[key]} onChange={e => void change({ [key]: Number(e.target.value) })}>{[70,80,90,95].map(n => <option key={n} value={n}>{n}%</option>)}</select></label>)}
          </div><div className="pet-settings-subchecks">
            {toggle("quiet", "免打扰", "暂停运维及生活气泡", !settings.monitoring && !settings.life?.enabled)}
            {toggle("keepInTray", "关闭后驻留托盘", "后台继续提醒，从托盘退出", !settings.monitoring && !settings.life?.enabled)}
          </div></details>
        </article>
      </div>
      <PetLifeSettings value={settings.life} onSave={changeLife} disabled={!ready || busy} petEnabled={settings.enabled} />
      <div className="pet-settings-footer"><span>{snapshot.checkedAt ? `最近检查：${new Date(snapshot.checkedAt * 1000).toLocaleString()}` : "尚未执行巡检"}{snapshot.lastError && <small className="pet-error">{snapshot.lastError}</small>}</span><button className="secondary" disabled={!ready || busy || !settings.monitoring} onClick={() => void work(client.check)}><RefreshCw size={14} />立即检查</button><button className="secondary" onClick={() => setHistory(true)}><Bell size={14} />提醒记录（{snapshot.alerts.filter(a => a.active && !a.ignored).length}）</button></div>
      {history && <SharedDialog title="运维提醒记录" className="pet-history" closeLabel="关闭提醒记录" onClose={() => setHistory(false)} footer={<button type="button" className="secondary" onClick={() => setHistory(false)}>关闭</button>}><AlertList snapshot={snapshot} onSnooze={key => void work(() => client.snooze(key))} onIgnore={(keys, ignored) => void work(async () => { setSnapshot(await client.ignore(keys, ignored)); })} busy={busy} showIgnored /></SharedDialog>}
    </>}
    </div>}
  </section>;
}

function isPetSettings(value: unknown): value is PetSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Partial<PetSettings>;
  return ["enabled", "monitoring", "panels", "panelAccess", "certificates", "servers", "sound", "reducedMotion", "quiet", "keepInTray"].every(key => typeof settings[key as keyof PetSettings] === "boolean")
    && ["alpaca", "dog", "penguin", "fish"].includes(String(settings.appearance))
    && typeof settings.size === "number" && ["edge", "free", "still"].includes(String(settings.roam))
    && typeof settings.activity === "number" && typeof settings.intervalSeconds === "number" && typeof settings.expiryDays === "number"
    && typeof settings.cpuThreshold === "number" && typeof settings.diskThreshold === "number";
}

function isPetSnapshot(value: unknown): value is PetSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<PetSnapshot>;
  return Array.isArray(snapshot.alerts) && typeof snapshot.checkedAt === "number" && (snapshot.lastError === null || typeof snapshot.lastError === "string");
}

export function AlertList({ snapshot, onSnooze, onIgnore, busy = false, showIgnored = false }: { snapshot: PetSnapshot; onSnooze: (key: string) => void; onIgnore: (keys: string[], ignored: boolean) => void; busy?: boolean; showIgnored?: boolean }) {
  const [openError,setOpenError]=useState("");
  const [status, setStatus] = useState<"active" | "recovered">("active");
  const visibleAlerts = snapshot.alerts.filter(a => showIgnored || !a.ignored);
  const alerts = sortPetAlerts(visibleAlerts.filter(a => status === "active" ? a.active : !a.active));
  const pendingKeys = snapshot.alerts.filter(a => a.active && !a.ignored).map(a => a.key);
  return <><div className="pet-alert-tools"><div className="pet-alert-filters" role="group" aria-label="提醒状态筛选"><button aria-pressed={status === "active"} onClick={() => setStatus("active")}>未解除 <span>{visibleAlerts.filter(a => a.active).length}</span></button><button aria-pressed={status === "recovered"} onClick={() => setStatus("recovered")}>已解除 <span>{visibleAlerts.filter(a => !a.active).length}</span></button></div>{status === "active" && pendingKeys.length > 0 && <button className="secondary" disabled={busy} title="忽略当前所有待处理提醒，历史记录保留" onClick={() => onIgnore(pendingKeys, true)}>全部忽略</button>}</div><div className="pet-alert-list">{openError && <p role="alert" className="pet-error">{openError}</p>}{!alerts.length && <div className="pet-alert-empty"><Check size={22} aria-hidden="true" /><strong>{status === "active" ? "暂无未解除提醒" : "暂无已解除提醒"}</strong><p>{status === "active" ? "未获取到数据的资源不视为正常。" : "恢复后的提醒会显示在这里。"}</p></div>}{alerts.map(a => <article className={`pet-alert-item ${a.active ? a.severity : "recovered"}`} key={a.key}>
    <div className="pet-alert-title"><span className="pet-alert-dot" aria-hidden="true" /><strong>{a.title}</strong><span className="pet-alert-state">{!a.active ? "已解除" : a.ignored ? "已忽略" : a.snoozedUntil > Date.now()/1000 ? "已暂缓" : petSeverityLabel(a.severity)}</span></div>
    <p>{a.detail}</p>
    <div className="pet-alert-actions"><time dateTime={new Date(a.updatedAt * 1000).toISOString()} title={new Date(a.updatedAt * 1000).toLocaleString()}>{new Date(a.updatedAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><button className="secondary pet-alert-open" onClick={() => void client.open(a.section, a.key).catch(e=>setOpenError(platformErrorMessage(e)))}>查看详情</button>{a.active && !a.ignored && <button className="secondary" disabled={busy} onClick={() => onSnooze(a.key)}>一小时后提醒</button>}{a.active && <button className="secondary" disabled={busy} onClick={() => onIgnore([a.key], !a.ignored)}>{a.ignored ? "恢复提醒" : "忽略"}</button>}</div>
  </article>)}</div></>;
}
