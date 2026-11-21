import { useEffect, useState } from "react";
import { Check, ChevronRight, Volume2 } from "lucide-react";
import { platformErrorMessage, runningOnWindows } from "../../platform/api";
import { desktopPetClient as client, isMimoSpeechPreset, type PetChatService, type PetSpeechPreset } from "../../platform/clients/desktopPet";
import warmPortrait from "./voice-portraits/warm.webp";
import clearPortrait from "./voice-portraits/clear.webp";
import brightPortrait from "./voice-portraits/bright.webp";
import steadyPortrait from "./voice-portraits/steady.webp";

const presets = {
  warm: { name: "暖柚", description: "温柔甜美", portrait: warmPortrait },
  clear: { name: "清禾", description: "清晰自然", portrait: clearPortrait },
  bright: { name: "星芽", description: "明快活泼", portrait: brightPortrait },
  steady: { name: "远山", description: "沉稳低音", portrait: steadyPortrait },
};
const mimoPresets = { mimoBingtang: "冰糖", mimoMoli: "茉莉" } as const;

export function PetSpeechPresets({ value, profileId, disabled, quiet, onChange, onProfileChange, onManageAi, onPreview }: {
  value: PetSpeechPreset;
  profileId: string;
  disabled: boolean;
  quiet: boolean;
  onChange: (preset: PetSpeechPreset) => void;
  onProfileChange: (id: string) => void;
  onManageAi: () => void;
  onPreview: (preset: PetSpeechPreset) => Promise<void>;
}) {
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const [profiles, setProfiles] = useState<PetChatService[]>([]);
  const [profileStatus, setProfileStatus] = useState<"loading" | "ready" | "error">("loading");
  const cloudSelected = isMimoSpeechPreset(value);
  const selected = value === "system" ? "系统默认" : cloudSelected ? `小米 MiMo · ${mimoPresets[value]}` : presets[value].name;
  const hasProfile = profiles.some(profile => profile.id === profileId);
  useEffect(() => {
    let request = 0;
    const refresh = () => {
      const id = ++request;
      void client.chatServices().then(result => {
        if (id !== request) return;
        setProfiles(result.filter(profile => profile.supportsMimoSpeech));
        setProfileStatus("ready");
      }).catch(() => {
        if (id === request) setProfileStatus("error");
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { ++request; window.removeEventListener("focus", refresh); };
  }, []);

  async function preview() {
    setError("");
    setPreviewing(true);
    try { await onPreview(value); }
    catch (e) { setError(platformErrorMessage(e)); }
    finally { setPreviewing(false); }
  }

  function change(preset: PetSpeechPreset) {
    setError("");
    onChange(preset);
  }

  return <section className="pet-chat-settings-section pet-speech-presets" aria-labelledby="pet-speech-presets-title">
    <h2 id="pet-speech-presets-title">播报音色</h2>
    <div className="pet-chat-settings-group pet-speech-mimo">
      <div className="pet-speech-mimo-head">
        <strong>小米 MiMo 云端女声</strong>
        <small>启用后，待播报的文字会发送到小米合成。合成失败时使用系统语音。</small>
      </div>
      <div className="pet-speech-mimo-options" role="group" aria-label="小米 MiMo 音色">
        {(Object.keys(mimoPresets) as (keyof typeof mimoPresets)[]).map(preset => <button key={preset} type="button" className="pet-chat-pill"
          aria-pressed={value === preset} disabled={disabled || previewing || !hasProfile}
          onClick={() => { if (value !== preset) change(preset); }}>
          <Volume2 size={15} aria-hidden="true" />{mimoPresets[preset]}{value === preset && <Check size={14} aria-hidden="true" />}
        </button>)}
      </div>
      <label className="pet-speech-profile">
        <span>MiMo API 配置</span>
        <select value={hasProfile ? profileId : ""} disabled={disabled || previewing || !profiles.length}
          onChange={e => { setError(""); onProfileChange(e.target.value); }}>
          <option value="" disabled>{profileStatus === "loading" ? "读取中…" : "请选择已保存的配置"}</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
      {profileStatus === "error" && <p className="pet-chat-setting-note" role="alert">无法读取 AI 配置，切回此窗口可重试。</p>}
      {profileStatus === "ready" && !profiles.length && <p className="pet-chat-setting-note">请在 AI 设置添加小米 MiMo 服务并保存 API Key。普通 API 地址为 https://api.xiaomimimo.com/v1。</p>}
      <button type="button" onClick={onManageAi}>管理 AI 服务<ChevronRight size={16} aria-hidden="true" /></button>
    </div>
    <div className="pet-speech-grid" role="group" aria-labelledby="pet-speech-presets-title">
      {(Object.keys(presets) as (keyof typeof presets)[]).map(preset => {
        const { name, description, portrait } = presets[preset];
        return <button key={preset} type="button" aria-pressed={value === preset} disabled={disabled || previewing}
          onClick={() => { if (value !== preset) change(preset); }}>
          <img src={portrait} width={320} height={320} alt="" loading="lazy" decoding="async" />
          <span className="pet-speech-name"><strong>{name}</strong><span>{description}</span></span>
          {value === preset && <span className="pet-speech-selected"><Check size={13} aria-hidden="true" /></span>}
        </button>;
      })}
    </div>
    <div className="pet-speech-actions">
      <p role="status">当前音色：{selected}</p>
      <div>
        {value !== "system" && <button type="button" className="pet-chat-pill" disabled={disabled || previewing} onClick={() => change("system")}>恢复默认</button>}
        <button type="button" className="pet-chat-pill" disabled={disabled || quiet || previewing || (cloudSelected && !hasProfile)} onClick={() => void preview()}>
          <Volume2 size={15} aria-hidden="true" />{previewing ? "试听中…" : "试听"}
        </button>
      </div>
    </div>
    {quiet && <p className="pet-chat-setting-note">勿扰期间暂停试听。</p>}
    {error && <p className="pet-chat-error" role="alert">{error}</p>}
    <details className="pet-speech-install">
      <summary>按需安装系统语音包</summary>
      <p>音色使用设备上的系统语音，并调整语速和音高。试听效果随已安装的语音而变化。</p>
      <p>{runningOnWindows
        ? "Windows：设置 → 时间和语言 → 语音 → 管理语音 → 添加语音。选择所需语言后重新试听。"
        : "macOS：系统设置 → 辅助功能 → 阅读与朗读 → 系统声音。选择并下载所需语音后重新试听。"}</p>
    </details>
  </section>;
}
