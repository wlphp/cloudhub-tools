import { ToastNotice } from "../../shared/ToastNotice";
import { PetPortrait } from "./PetPortrait";
import { useEffect, useId, useState } from "react";
import { Save } from "lucide-react";
import { petAppearances } from "./appearances";
import { PetLifeSettings } from "./PetLifeSettings";
import { PetVoiceSettings } from "./PetVoiceSettings";
import { listen } from "@tauri-apps/api/event";
import { runningInTauri, platformErrorMessage } from "../../platform/api";
import { defaultPetSettings, defaultPetLife, defaultPetVoice, desktopPetClient as client, type PetSettings, type PetVoiceXfyunCredentials } from "../../platform/clients/desktopPet";
import "./desktop-pet.css";

const tabs = [
  { id: "companion", label: "桌宠陪伴" },
  { id: "life", label: "生活陪伴" },
  { id: "voice", label: "语音对话" },
] as const;

type CompanionSettings = Pick<PetSettings, "enabled" | "appearance" | "size" | "roam" | "activity" | "sound" | "reducedMotion">;

let previewSettings = defaultPetSettings;

// 桌宠是桌面端窗口功能；手机端按 H5 调试入口约定保留面板入口，但精灵图不进入移动端构建，这里给出诚实说明而不是缺图预览。
const petUnavailableOnMobile = import.meta.env.VITE_APP_TARGET === "mobile";

export function PetSettingsPanel() {
  if (petUnavailableOnMobile) {
    return <section className="desktop-pet-panel" role="note" aria-label="桌宠为桌面端功能说明">
      <h2>桌面宠物</h2>
      <p>桌宠是桌面端专属功能：手机端不运行桌宠窗口，也不预览形象动画，相关精灵图资源不随手机安装包分发。</p>
      <p>配置、形象预览与语音对话请在 Windows / macOS 客户端的软件商店中打开本应用。</p>
    </section>;
  }
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]["id"]>("companion");
  const [settings, setSettings] = useState<PetSettings>(() => runningInTauri ? defaultPetSettings : previewSettings);
  const [companionDraft, setCompanionDraft] = useState<Partial<CompanionSettings>>({});
  const [ready, setReady] = useState(!runningInTauri);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!runningInTauri) return;
    let disposed = false;
    void client.settings().then(s => {
      if (disposed) return;
      if (!isPetSettings(s)) { setError("桌宠设置无效，请重启应用后重试。"); return; }
      setSettings({ ...s, life: { ...defaultPetLife, ...s.life } }); setReady(true);
    }).catch(e => { if (!disposed) setError(platformErrorMessage(e)); });
    const events = [listen<PetSettings>("pet-settings-changed", e => {
      if (disposed) return;
      const next = { ...e.payload, life: { ...defaultPetLife, ...e.payload.life } };
      setSettings(current => ({
        ...next,
        life: JSON.stringify(current.life) === JSON.stringify(next.life) ? current.life : next.life,
        voice: JSON.stringify(current.voice) === JSON.stringify(next.voice) ? current.voice : next.voice,
      }));
    })];
    return () => { disposed = true; events.forEach(p => void p.then(unlisten => unlisten())); };
  }, []);
  async function work(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(platformErrorMessage(e)); } finally { setBusy(false); } }
  async function save(next: PetSettings, credentials?: PetVoiceXfyunCredentials) {
    if (runningInTauri) await client.save(next, credentials);
    else {
      if (credentials) throw new Error("请在桌面客户端保存语音服务凭据。");
      previewSettings = next;
    }
    setSettings(next);
  }
  const companion = { ...settings, ...companionDraft };
  const companionDirty = (Object.keys(companionDraft) as (keyof CompanionSettings)[]).some(key => companion[key] !== settings[key]);
  function change(patch: Partial<CompanionSettings>) { setCompanionDraft(current => ({ ...current, ...patch })); }
  async function changeLife(life: PetSettings["life"]) {
    const next = { ...settings, life };
    setBusy(true); setError("");
    try { await save(next); }
    finally { setBusy(false); }
  }
  async function changeVoice(voice: PetSettings["voice"], quiet: boolean, xfyunCredentials?: PetVoiceXfyunCredentials) {
    const next = { ...settings, voice, quiet };
    setBusy(true); setError("");
    try { await save(next, xfyunCredentials); }
    finally { setBusy(false); }
  }
  const toggle = (key: "enabled" | "sound" | "reducedMotion", label: string, detail?: string, disabled = false) => <label className="pet-option"><span>{label}{detail && <small>{detail}</small>}</span><input type="checkbox" disabled={!ready || busy || disabled} checked={companion[key]} onChange={e => change({ [key]: e.target.checked })} /></label>;
  return <section className="pet-settings-section" aria-label="桌面宠物设置">
    <div className="pet-settings-tabs" role="tablist" aria-label="宠物设置分类">
      {tabs.map(({ id, label }, index) => <button
        key={id}
        type="button"
        role="tab"
        id={`${tabsId}-tab-${id}`}
        aria-controls={`${tabsId}-panel-${id}`}
        aria-selected={activeTab === id}
        tabIndex={activeTab === id ? 0 : -1}
        onClick={() => setActiveTab(id)}
        onKeyDown={event => {
          let next: number;
          switch (event.key) {
            case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break;
            case "ArrowRight": next = (index + 1) % tabs.length; break;
            case "Home": next = 0; break;
            case "End": next = tabs.length - 1; break;
            default: return;
          }
          event.preventDefault();
          setActiveTab(tabs[next].id);
          event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
        }}
      >{label}</button>)}
    </div>
    {!runningInTauri && <p>浏览器调试预览。设置在当前页面会话内生效，显示桌宠、播报与查询天气等操作需使用桌面客户端。</p>}
      {error && <ToastNotice message={error} tone="error" />}
      <div role="tabpanel" id={`${tabsId}-panel-companion`} aria-labelledby={`${tabsId}-tab-companion`} hidden={activeTab !== "companion"}>
        <form className="pet-companion-card" onSubmit={event => {
          event.preventDefault();
          void work(async () => { await save(companion); setCompanionDraft({}); });
        }}>
          <fieldset disabled={!ready || busy}>
            <div className="pet-settings-topic">
              <PetPortrait appearance={companion.appearance} className="pet-settings-portrait" />
              <div><h3>桌宠陪伴</h3><p>点击宠物查看提醒，拖动可移动</p></div>
              <span role="status">{ready ? (settings.enabled ? "桌宠已启用" : "桌宠已关闭") : error ? "设置读取失败" : "正在读取设置"}</span>
            </div>
            <div className="pet-settings-groups">
            <section className="pet-life-group" aria-label="外观与显示">
              <h4>外观与显示</h4>
              <div className="pet-life-options">{toggle("enabled", "启用桌宠")}</div>
              <div className="pet-life-grid">
            <label>宠物形象<select disabled={!ready || busy} value={companion.appearance} onChange={e => change({ appearance: e.target.value as PetSettings["appearance"] })}>{Object.entries(petAppearances).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
            <label>桌宠大小<select disabled={!ready || busy} value={companion.size} onChange={e => change({ size: Number(e.target.value) })}><option value={80}>特小</option><option value={120}>小</option><option value={160}>中</option><option value={200}>大</option></select></label>
              </div>
              <div className="pet-settings-actions">
                <button type="button" className="secondary" disabled={!settings.enabled} onClick={() => void work(client.show)}>显示桌宠</button>
                <button type="button" className="secondary" disabled={!settings.enabled} onClick={() => void work(() => client.move(0, 0, true, true))}>重置位置</button>
              </div>
            </section>
            <section className="pet-life-group" aria-label="活动与互动">
              <h4>活动与互动</h4>
              <div className="pet-life-grid">
            <label>活动范围<select disabled={!ready || busy} value={companion.roam} onChange={e => change({ roam: e.target.value as PetSettings["roam"] })}><option value="edge">沿屏幕下沿</option><option value="free">屏幕内漫游</option><option value="still">原地陪伴</option></select></label>
            <label>活跃程度<select disabled={!ready || busy} value={companion.activity} onChange={e => change({ activity: Number(e.target.value) })}><option value={0}>安静</option><option value={1}>适中</option><option value={2}>活泼</option></select></label>
              </div>
              <div className="pet-life-options">
                {toggle("reducedMotion", "减少动态", "遵循系统减少动态设置", !companion.enabled)}
                {toggle("sound", "互动声音", "默认静音", !companion.enabled)}
              </div>
            </section>
            </div>
            <div className="pet-life-actions"><span>{companionDirty ? "有未保存的修改" : "设置已保存"}</span><button type="submit" className="primary" disabled={!companionDirty}><Save size={14} />保存桌宠设置</button></div>
          </fieldset>
        </form>
      </div>
      <div role="tabpanel" id={`${tabsId}-panel-life`} aria-labelledby={`${tabsId}-tab-life`} hidden={activeTab !== "life"}>
        <PetLifeSettings value={settings.life} onSave={changeLife} disabled={!ready || busy} petEnabled={settings.enabled} />
      </div>
      <div role="tabpanel" id={`${tabsId}-panel-voice`} aria-labelledby={`${tabsId}-tab-voice`} hidden={activeTab !== "voice"}>
        <PetVoiceSettings value={settings.voice ?? defaultPetVoice} quiet={settings.quiet} onSave={changeVoice} disabled={!ready || busy} petEnabled={settings.enabled} />
      </div>
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
