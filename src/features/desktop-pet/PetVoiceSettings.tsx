import { ToastNotice } from "../../shared/ToastNotice";
import { useEffect, useState } from "react";
import { AudioLines, Download, FolderOpen, RefreshCw, Save, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { defaultPetVoice, desktopPetClient as client, type PetVoiceDownloadProgress, type PetVoiceSettings as VoiceSettings, type PetVoiceStatus } from "../../platform/clients/desktopPet";
import { platformErrorMessage, runningInTauri } from "../../platform/api";

/// 桌宠语音设置卡片：语音开关、常驻唤醒词、识别模型下载与状态检测。
const MODEL_NOTES: Record<string, string> = {
  "ggml-tiny.bin": "速度最快，识别较弱",
  "ggml-base.bin": "速度快，日常够用",
  "ggml-small.bin": "识别更准，唤醒词场景推荐",
};
const mb = (bytes: number) => `${Math.round(bytes / 1048576)}MB`;
export function PetVoiceSettings({ value, onSave, disabled, petEnabled }: { value: VoiceSettings; onSave: (value: VoiceSettings) => Promise<void>; disabled: boolean; petEnabled: boolean }) {
  const [draft, setDraft] = useState<VoiceSettings>({ ...defaultPetVoice, ...value });
  const [status, setStatus] = useState<PetVoiceStatus | null>(null);
  const [listening, setListening] = useState<{ active: boolean; error: string | null } | null>(null);
  const [download, setDownload] = useState<{ name: string; progress: PetVoiceDownloadProgress | null } | null>(null);
  const [heard, setHeard] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { setDraft({ ...defaultPetVoice, ...value }); }, [value]);
  const refresh = () => { if (!runningInTauri) return; void client.voiceStatus().then(setStatus).catch(() => setStatus(null)); };
  useEffect(() => {
    refresh();
    const sub = listen<{ active: boolean; error: string | null }>("pet-voice-listening", e => setListening(e.payload));
    const heardSub = listen<{ text: string }>("pet-voice-heard", e => setHeard(e.payload?.text || ""));
    return () => { void sub.then(fn => fn()); void heardSub.then(fn => fn()); };
  }, []);
  const change = (patch: Partial<VoiceSettings>) => { setDraft(d => ({ ...d, ...patch })); setError(""); };
  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...defaultPetVoice, ...value });
  async function run(action: () => Promise<void>) { setLoading(true); setError(""); try { await action(); } catch (e) { setError(platformErrorMessage(e)); } finally { setLoading(false); } }
  /// 点击下载：进度经 Channel 回传，结束后 Rust 返回最新状态；失败时仍可按指引手动下载。
  async function startDownload(name: string) {
    setDownload({ name, progress: null });
    setError("");
    try {
      const next = await client.voiceDownloadModel(name, progress => setDownload(current => current?.name === name ? { ...current, progress } : current));
      setStatus(next);
    } catch (e) {
      setError(platformErrorMessage(e));
    } finally {
      setDownload(null);
    }
  }
  async function cancelDownload() { try { await client.voiceCancelModelDownload(); } catch { /* 取消标志已置位，无需提示 */ } }
  const check = (key: "enabled" | "wakeEnabled" | "autoSend", label: string, description?: string) => <label className="pet-option"><span>{label}{description && <small>{description}</small>}</span><input type="checkbox" checked={draft[key]} onChange={e => change({ [key]: e.target.checked })} /></label>;
  const percent = download?.progress?.totalBytes ? Math.min(100, Math.round((download.progress.downloadedBytes / download.progress.totalBytes) * 100)) : null;
  return <article className="pet-control-card pet-voice-settings">
    <header><div><strong><AudioLines size={15} aria-hidden="true" />语音对话</strong><small>本地识别唤醒词与语音指令，录音不出本机</small></div><span className={value?.enabled ? "pet-life-enabled" : "pet-life-muted"}>{value?.enabled ? "已开启" : "未开启"}</span></header>
    <details className="pet-settings-disclosure"><summary>语音识别与常驻唤醒</summary>
      <form onSubmit={e => { e.preventDefault(); void run(() => onSave(draft)); }}>
        <fieldset disabled={disabled || loading}>
          <div className="pet-life-options">
            {check("enabled", "启用语音对话", "聊天面板出现麦克风按钮；唤醒桌宠后可直接说指令。")}
            {check("autoSend", "识别后自动执行", "关闭后识别文本填入聊天输入框，由你确认后再发送。")}
            {check("wakeEnabled", "常驻监听唤醒词", "麦克风保持采集，仅在本机判断唤醒词；未命中唤醒词的语音不会离开本机。")}
          </div>
          <div className="pet-life-grid">
            <label>唤醒词<input value={draft.wakeWord} maxLength={24} placeholder="如：小驼" onChange={e => change({ wakeWord: e.target.value })} /></label>
            <label>识别语言<select value={draft.language} onChange={e => change({ language: e.target.value })}><option value="zh">中文</option><option value="en">English</option><option value="auto">自动检测</option></select></label>
            <label>最长录音<select value={draft.maxSeconds} onChange={e => change({ maxSeconds: Number(e.target.value) })}>{[30, 60, 90, 120].map(seconds => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select></label>
            <label>识别模型<select value={draft.modelFile} onChange={e => change({ modelFile: e.target.value })}><option value="">{status?.models.length ? `自动选择（${status.models[0].name}）` : "自动选择"}</option>{status?.models.map(model => <option key={model.name} value={model.name}>{model.name} · {mb(model.sizeBytes)}</option>)}</select></label>
          </div>
          <div className="pet-life-weather-status"><span>
            {status ? (status.ready ? `模型就绪：${status.selected}` : "未找到模型：可点击下方按钮在线下载，或手动放入模型文件夹") : runningInTauri ? "正在检查语音模型…" : "仅桌面端支持"}
            {listening?.active && <small role="status">{listening.error ? listening.error : `正在监听唤醒词“${draft.wakeWord}”`}</small>}
            {listening?.active && heard && <small role="status">最后听到：“{heard}”</small>}
          </span>
          <div className="pet-life-status-actions">
            <button type="button" className="secondary" onClick={() => void run(client.openVoiceModelsDir).finally(refresh)}><FolderOpen size={13} />打开模型文件夹</button>
            <button type="button" className="secondary" onClick={refresh}><RefreshCw size={13} />重新检测</button>
          </div>
        </div>
          {status && !status.ready && !download && <div className="pet-voice-model-list">
            {status.catalog?.map(model => <div key={model.name} className="pet-voice-model-row">
              <span><strong>{model.name}</strong><small>{mb(model.sizeBytes)} · {MODEL_NOTES[model.name] ?? "标准 ggml 模型"}</small></span>
              <button type="button" className="secondary" onClick={() => void startDownload(model.name)}><Download size={13} />下载</button>
            </div>)}
          </div>}
          {download && <div className="pet-voice-model-progress">
            <span className="pet-voice-model-progress-text">
              {download.name} · {download.progress ? percent === null ? mb(download.progress.downloadedBytes) : `${percent}%` : "正在连接下载源…"}
              {download.progress?.totalBytes ? <small>{` ${mb(download.progress.bytesPerSecond)}/s · ${download.progress.source}`}</small> : null}
            </span>
            <div className="pet-voice-model-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0}><span style={{ width: `${percent ?? 0}%` }} /></div>
            <button type="button" className="secondary" onClick={() => void cancelDownload()}><X size={13} />取消下载</button>
          </div>}
          <details className="pet-life-overrides"><summary>手动下载指引（在线下载失败时使用）</summary>
            <p className="pet-life-help">语音识别使用 whisper.cpp 的 ggml 模型，为控制安装包体积模型不随软件分发。下载模型文件放入上方打开的文件夹，点“重新检测”即可：</p>
            <ul className="pet-life-help">
              <li>ggml-base.bin（约 142MB，速度快，日常够用）</li>
              <li>ggml-small.bin（约 466MB，识别更准，唤醒词场景推荐）</li>
              <li>下载地址：huggingface.co/ggerganov/whisper.cpp 的 Models 目录（国内可用 hf-mirror.com 镜像）</li>
            </ul>
            <p className="pet-life-help">语音全程在本机识别；只有唤醒后的指令或聊天文本会发送给你选择的 AI 服务。</p>
          </details>
          {!petEnabled && <p className="pet-life-help">开启桌宠后可使用语音对话。</p>}
          {error && <ToastNotice message={error} tone="error" />}
          <div className="pet-life-actions"><span>{dirty ? "有未保存的修改" : "设置已保存"}</span><button type="submit" className="secondary" disabled={!dirty}><Save size={14} />保存语音设置</button></div>
        </fieldset>
      </form>
    </details>
  </article>;
}
