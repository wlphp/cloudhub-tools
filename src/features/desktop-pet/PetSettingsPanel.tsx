import { ToastNotice } from "../../shared/ToastNotice";
import { PetPortrait } from "./PetPortrait";
import { useEffect, useState } from "react";
import { ChevronDown, PawPrint } from "lucide-react";
import { petAppearances } from "./appearances";
import { PetLifeSettings } from "./PetLifeSettings";
import { PetVoiceSettings } from "./PetVoiceSettings";
import { listen } from "@tauri-apps/api/event";
import { runningInTauri, platformErrorMessage } from "../../platform/api";
import { defaultPetSettings, defaultPetLife, defaultPetVoice, desktopPetClient as client, type PetSettings, type PetVoiceXfyunCredentials } from "../../platform/clients/desktopPet";
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
  async function changeVoice(voice: PetSettings["voice"], quiet: boolean, xfyunCredentials?: PetVoiceXfyunCredentials) {
    const next = { ...settings, voice, quiet };
    setBusy(true); setError("");
    try { await client.save(next, xfyunCredentials); setSettings(next); }
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
      <PetVoiceSettings value={settings.voice ?? defaultPetVoice} quiet={settings.quiet} onSave={changeVoice} disabled={!ready || busy} petEnabled={settings.enabled} />
    </>}
    </div>}
  </section>;
}

function isPetSettings(value: unknown): value is PetSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Partial<PetSettings>;
  return ["enabled", "monitoring", "panels", "panelAccess", "certificates", "servers", "sound", "reducedMotion", "quiet", "keepInTray"].every(key => typeof settings[key as keyof PetSettings] === "boolean")
    && Array.isArray(settings.excludedAssetAlerts) && settings.excludedAssetAlerts.every(key => typeof key === "string")
    && ["alpaca", "dog", "penguin", "fish", "human"].includes(String(settings.appearance))
    && typeof settings.size === "number" && ["edge", "free", "still"].includes(String(settings.roam))
    && typeof settings.activity === "number" && typeof settings.intervalSeconds === "number" && typeof settings.expiryDays === "number"
    && typeof settings.cpuThreshold === "number" && typeof settings.diskThreshold === "number"
    && (!settings.voice || typeof settings.voice === "object");
}
