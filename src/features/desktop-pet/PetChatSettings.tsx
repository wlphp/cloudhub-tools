import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bell, Box, ChevronRight, Info, LayoutGrid, MessageCircle, Mic, Paperclip } from "lucide-react";
import { version } from "../../../package.json";
import { platformErrorMessage } from "../../platform/api";
import { desktopPetClient as client, type PetSettings, type PetSpeechPreset } from "../../platform/clients/desktopPet";
import { petAppearances } from "./appearances";
import { PetPortrait } from "./PetPortrait";
import { PetSpeechPresets } from "./PetSpeechPresets";

export type PetChatPage = "chat" | "settings" | "general" | "alerts" | "skills" | "about";

const pages = {
  settings: "设置",
  general: "通用设置",
  alerts: "查看提醒",
  skills: "全部技能",
  about: "关于桌宠",
};

export function PetChatSettings({ page, onPageChange, settings, ready, serviceControls, skillsActions, alerts, supportsImages, canTry, onSave, onTry, onVoicePreview }: {
  page: Exclude<PetChatPage, "chat">;
  onPageChange: (page: PetChatPage) => void;
  settings: PetSettings;
  ready: boolean;
  serviceControls: ReactNode;
  skillsActions: ReactNode;
  alerts: { count: number; page: ReactNode };
  supportsImages: boolean;
  canTry: boolean;
  onSave: (settings: PetSettings) => Promise<void>;
  onTry: (prompt: string) => void;
  onVoicePreview: (preset: PetSpeechPreset) => Promise<void>;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const name = petAppearances[settings.appearance].label;

  useEffect(() => { title.current?.focus(); }, [page]);

  async function save(next: PetSettings) {
    setSaving(true);
    setError("");
    try { await onSave(next); }
    catch (e) { setError(platformErrorMessage(e)); }
    finally { setSaving(false); }
  }

  function open(section: string) {
    setError("");
    void client.open(section).catch(e => setError(platformErrorMessage(e)));
  }

  return <div className={`pet-chat-settings${page === "alerts" ? " pet-chat-alerts-page" : ""}`}>
    <div className="pet-chat-page-head">
      <button type="button" aria-label={page === "settings" ? "返回聊天" : "返回设置"} onClick={() => onPageChange(page === "settings" ? "chat" : "settings")}><ArrowLeft size={20} aria-hidden="true" /></button>
      <h1 ref={title} tabIndex={-1}>{pages[page]}</h1>
    </div>
    {error && <p className="pet-chat-error" role="alert">{error}</p>}
    {page === "settings" && <>
      <div className="pet-chat-settings-profile">
        <PetPortrait appearance={settings.appearance} pose="happy" />
        <strong>{name}</strong>
        <span>云枢桌面陪伴</span>
      </div>
      <nav className="pet-chat-settings-group" aria-label="桌宠设置">
        <button type="button" onClick={() => onPageChange("general")}><LayoutGrid size={19} aria-hidden="true" />通用设置<ChevronRight size={16} aria-hidden="true" /></button>
        <button type="button" onClick={() => onPageChange("alerts")}><Bell size={19} aria-hidden="true" />查看提醒{alerts.count > 0 && <small className="pet-chat-alert-count">{alerts.count} 项待处理</small>}<ChevronRight size={16} aria-hidden="true" /></button>
        <button type="button" onClick={() => onPageChange("skills")}><Box size={19} aria-hidden="true" />全部技能<ChevronRight size={16} aria-hidden="true" /></button>
        <button type="button" onClick={() => onPageChange("about")}><Info size={19} aria-hidden="true" />关于桌宠<ChevronRight size={16} aria-hidden="true" /></button>
      </nav>
    </>}
    {page === "general" && <>
      <section className="pet-chat-settings-section">
        <h2>桌宠形象</h2>
        <div className="pet-chat-appearances" role="group" aria-label="桌宠形象">
          {(Object.keys(petAppearances) as PetSettings["appearance"][]).map(appearance => <button key={appearance} type="button" data-appearance={appearance}
            aria-pressed={settings.appearance === appearance} disabled={!ready || saving}
            onClick={() => { if (appearance !== settings.appearance) void save({ ...settings, appearance }); }}>
            <PetPortrait appearance={appearance} pose="happy" /><span>{petAppearances[appearance].label}</span>
          </button>)}
        </div>
      </section>
      <PetSpeechPresets value={settings.voice.speechPreset ?? "system"} profileId={settings.voice.speechMimoProfileId ?? ""} disabled={!ready || saving} quiet={settings.quiet}
        onChange={speechPreset => void save({ ...settings, voice: { ...settings.voice, speechPreset } })}
        onProfileChange={speechMimoProfileId => void save({ ...settings, voice: { ...settings.voice, speechMimoProfileId } })}
        onManageAi={() => open("aiSettings")} onPreview={onVoicePreview} />
      <section className="pet-chat-settings-section">
        <h2>语音设置</h2>
        <div className="pet-chat-settings-group">
          <label className="pet-chat-setting-toggle">
            <span><strong>语音唤醒</strong><small>说“{settings.voice.wakeWord}”唤醒桌宠</small></span>
            <input type="checkbox" role="switch" aria-label="语音唤醒" checked={settings.voice.wakeEnabled} disabled={!ready || saving || !settings.voice.enabled || settings.quiet}
              onChange={e => void save({ ...settings, voice: { ...settings.voice, wakeEnabled: e.target.checked } })} />
          </label>
          {settings.voice.cloudAsrEnabled && <p className="pet-chat-setting-note">常驻监听开启后，命中唤醒词前的录音片段也会发送至所选识别服务。</p>}
          {(!settings.voice.enabled || settings.quiet) && <p className="pet-chat-setting-note">{settings.quiet ? "免打扰期间已暂停语音唤醒。" : "请在高级设置中启用语音对话。"}</p>}
          <button type="button" onClick={() => open("petSettings")}>高级设置<ChevronRight size={16} aria-hidden="true" /></button>
        </div>
      </section>
      <section className="pet-chat-settings-section">
        <h2>聊天服务</h2>
        <div className="pet-chat-settings-group">
          {serviceControls}
          <button type="button" onClick={() => open("aiSettings")}>管理 AI 服务<ChevronRight size={16} aria-hidden="true" /></button>
        </div>
      </section>
    </>}
    {page === "alerts" && alerts.page}
    {page === "skills" && <div className="pet-chat-skills">
      {skillsActions}
      <article className="pet-chat-settings-group">
        <h2><MessageCircle size={18} aria-hidden="true" />聊天问答</h2>
        {["你会做什么？", "分享一个有趣的知识", "帮我整理今天的待办"].map(prompt => <div key={prompt} className="pet-chat-skill-row">
          <span>{prompt}</span><button type="button" className="pet-chat-pill" disabled={!canTry} onClick={() => onTry(prompt)}>试试</button>
        </div>)}
      </article>
      <article className="pet-chat-settings-group">
        <h2><Paperclip size={18} aria-hidden="true" />图片聊天</h2>
        <div className="pet-chat-skill-row"><span>{supportsImages ? "在聊天中选择、粘贴或拖入图片" : "在 AI 设置中测试所选服务的图像能力"}</span>
          <button type="button" className="pet-chat-pill" onClick={() => supportsImages ? onPageChange("chat") : open("settings")}>{supportsImages ? "去聊天" : "去设置"}</button>
        </div>
      </article>
      <article className="pet-chat-settings-group">
        <h2><Mic size={18} aria-hidden="true" />语音陪伴</h2>
        <div className="pet-chat-skill-row"><span>配置语音输入、播报和唤醒</span><button type="button" className="pet-chat-pill" onClick={() => onPageChange("general")}>设置</button></div>
      </article>
      <article className="pet-chat-settings-group">
        <h2><Bell size={18} aria-hidden="true" />桌面提醒</h2>
        <div className="pet-chat-skill-row"><span>配置生活提醒和桌宠互动</span><button type="button" className="pet-chat-pill" onClick={() => open("petSettings")}>设置</button></div>
      </article>
    </div>}
    {page === "about" && <>
      <div className="pet-chat-settings-group">
        <div className="pet-chat-about-version"><strong>当前版本　{version}</strong><button type="button" className="pet-chat-pill" onClick={() => open("about")}>查看更新</button></div>
      </div>
      <p className="pet-chat-about-caption">云枢工具箱 · 桌面陪伴</p>
    </>}
  </div>;
}
