import { ToastNotice } from "../../shared/ToastNotice";
import { PetPortrait } from "./PetPortrait";
import { useEffect, useState } from "react";
import { Check, ChevronDown, PawPrint } from "lucide-react";
import { petAppearances } from "./appearances";
import { PetLifeSettings } from "./PetLifeSettings";
import { listen } from "@tauri-apps/api/event";
import { runningInTauri, platformErrorMessage } from "../../platform/api";
import { defaultPetSettings, defaultPetLife, petSeverityLabel, sortPetAlerts, desktopPetClient as client, type PetSettings, type PetSnapshot } from "../../platform/clients/desktopPet";
import "./desktop-pet.css";

export function PetSettingsPanel({ embedded = false }: { embedded?: boolean }) {
  const [settings, setSettings] = useState<PetSettings>(defaultPetSettings);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(embedded);
  useEffect(() => {
    if (!runningInTauri) return;
    let disposed = false;
    void client.settings().then(s => {
      if (disposed) return;
      if (!isPetSettings(s)) { setError("桌宠设置无效，请重启应用后重试。"); return; }
      setSettings({ ...s, life: { ...defaultPetLife, ...s.life } }); setReady(true);
    }).catch(e => { if (!disposed) setError(platformErrorMessage(e)); });
    const events = [listen<PetSettings>("pet-settings-changed", e => { if (!disposed) setSettings(e.payload); })];
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
  const toggle = (key: "enabled" | "sound" | "reducedMotion", label: string, detail?: string, disabled = false) => <label className="pet-option"><span>{label}{detail && <small>{detail}</small>}</span><input type="checkbox" disabled={!ready || busy || disabled} checked={settings[key]} onChange={e => void change({ [key]: e.target.checked })} /></label>;
  return <section className={expanded ? "pet-settings-section is-expanded" : "pet-settings-section"} aria-label="桌面陪伴与生活陪伴设置">
    <div className="pet-settings-heading"><PawPrint size={20} /><div className="pet-settings-title"><strong>桌面陪伴与生活陪伴</strong><small>桌宠互动与生活提醒设置</small></div><div className="pet-settings-summary" aria-label="桌面陪伴状态">
      <span className={settings.enabled ? "is-on" : "is-off"}><i aria-hidden="true" />桌宠 {settings.enabled ? "已启用" : "已关闭"}</span>
    </div>{!embedded && <button className="pet-settings-expand" aria-expanded={expanded} aria-controls="pet-settings-content" onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开"}<ChevronDown size={15} /></button>}</div>
    {expanded && <div id="pet-settings-content">
    {!runningInTauri ? <p>桌宠、后台巡检和托盘驻留仅支持桌面应用，浏览器预览不可用。</p> : <>
      {error && <ToastNotice message={error} tone="error" />}
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
      </div>
      <PetLifeSettings value={settings.life} onSave={changeLife} disabled={!ready || busy} petEnabled={settings.enabled} />
    </>}
    </div>}
  </section>;
}

function isPetSettings(value: unknown): value is PetSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Partial<PetSettings>;
  return ["enabled", "monitoring", "panels", "panelAccess", "certificates", "servers", "sound", "reducedMotion", "quiet", "keepInTray"].every(key => typeof settings[key as keyof PetSettings] === "boolean")
    && Array.isArray(settings.excludedAssetAlerts) && settings.excludedAssetAlerts.every(key => typeof key === "string")
    && ["alpaca", "dog", "penguin", "fish"].includes(String(settings.appearance))
    && typeof settings.size === "number" && ["edge", "free", "still"].includes(String(settings.roam))
    && typeof settings.activity === "number" && typeof settings.intervalSeconds === "number" && typeof settings.expiryDays === "number"
    && typeof settings.cpuThreshold === "number" && typeof settings.diskThreshold === "number";
}

export function AlertList({ snapshot, onSnooze, onIgnore, busy = false, showIgnored = false }: { snapshot: PetSnapshot; onSnooze: (key: string) => void; onIgnore: (keys: string[], ignored: boolean) => void; busy?: boolean; showIgnored?: boolean }) {
  const [openError,setOpenError]=useState("");
  const [status, setStatus] = useState<"active" | "recovered">("active");
  const visibleAlerts = snapshot.alerts.filter(a => showIgnored || !a.ignored);
  const alerts = sortPetAlerts(visibleAlerts.filter(a => status === "active" ? a.active : !a.active));
  const pendingKeys = snapshot.alerts.filter(a => a.active && !a.ignored).map(a => a.key);
  return <><div className="pet-alert-tools"><div className="pet-alert-filters" role="group" aria-label="提醒状态筛选"><button aria-pressed={status === "active"} onClick={() => setStatus("active")}>未解除 <span>{visibleAlerts.filter(a => a.active).length}</span></button><button aria-pressed={status === "recovered"} onClick={() => setStatus("recovered")}>已解除 <span>{visibleAlerts.filter(a => !a.active).length}</span></button></div>{status === "active" && pendingKeys.length > 0 && <button className="secondary" disabled={busy} title="将当前所有未解除提醒静音；预警仍会继续监控" onClick={() => onIgnore(pendingKeys, true)}>全部静音</button>}</div><div className="pet-alert-list">{openError && <p role="alert" className="pet-error">{openError}</p>}{!alerts.length && <div className="pet-alert-empty"><Check size={22} aria-hidden="true" /><strong>{status === "active" ? "暂无未解除提醒" : "暂无已解除提醒"}</strong><p>{status === "active" ? "未获取到数据的资源不视为正常。" : "恢复后的提醒会显示在这里。"}</p></div>}{alerts.map(a => <article className={`pet-alert-item ${a.active ? a.severity : "recovered"}`} key={a.key}>
    <div className="pet-alert-title"><span className="pet-alert-dot" aria-hidden="true" /><strong>{a.title}</strong><span className="pet-alert-state">{!a.active ? "已解除" : a.ignored ? "已静音" : a.snoozedUntil > Date.now()/1000 ? "已暂缓" : petSeverityLabel(a.severity)}</span></div>
    {a.active && a.ignored && <p className="pet-alert-muted-note">预警仍在监控，系统已停止重复通知。</p>}<p>{a.detail}</p>
    <div className="pet-alert-actions"><time dateTime={new Date(a.updatedAt * 1000).toISOString()} title={new Date(a.updatedAt * 1000).toLocaleString()}>{new Date(a.updatedAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><button className="secondary pet-alert-open" onClick={() => void client.open(a.section, a.key).catch(e=>setOpenError(platformErrorMessage(e)))}>查看详情</button>{a.active && !a.ignored && <button className="secondary" disabled={busy} onClick={() => onSnooze(a.key)}>一小时后提醒</button>}{a.active && <button className="secondary" disabled={busy} onClick={() => onIgnore([a.key], !a.ignored)}>{a.ignored ? "取消静音" : "静音提醒"}</button>}</div>
  </article>)}</div></>;
}
