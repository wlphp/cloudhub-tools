import { ToastNotice } from "../../shared/ToastNotice";
import { SecretField } from "../../shared/SecretField";
import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Download, FolderOpen, RefreshCw, Save, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { defaultPetVoice, desktopPetClient as client, type PetVoiceDownloadProgress, type PetVoiceSettings as VoiceSettings, type PetVoiceStatus, type PetVoiceXfyunCredentials } from "../../platform/clients/desktopPet";
import { aiClient, type AiProfile } from "../../platform/clients/ai";
import { platformErrorMessage, runningInTauri } from "../../platform/api";

/// 桌宠语音设置卡片：语音开关、常驻唤醒词、识别模型下载与状态检测。
const MODEL_NOTES: Record<string, string> = {
  "ggml-tiny.bin": "速度最快，识别较弱",
  "ggml-base.bin": "速度快，日常够用",
  "ggml-small.bin": "识别更准，唤醒词场景推荐",
};
const mb = (bytes: number) => `${Math.round(bytes / 1048576)}MB`;
const WAKE_RESULTS = {
  transcribing: "正在识别",
  unclear: "未识别到清晰语音",
  unmatched: "未命中唤醒词",
  awakened: "已唤醒，等待指令",
  command: "已识别指令",
  failed: "转写失败",
} satisfies Record<NonNullable<PetVoiceStatus["lastResult"]>, string>;
/// 已知服务商的语音识别模型与转写端点预置：选择 AI 配置后自动带出，免手填。
const CLOUD_ASR_PRESETS: Array<{ match: string; models: string[]; endpoint?: (baseUrl: string) => string }> = [
  { match: "minimax", models: ["asr-1.0"], endpoint: (baseUrl) => `${originOf(baseUrl)}/v1/speech_to_text` },
  { match: "siliconflow", models: ["FunAudioLLM/SenseVoiceSmall"] },
  { match: "api.openai.com", models: ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"] },
];
function cloudAsrPreset(baseUrl: string | undefined) {
  const lower = (baseUrl || "").toLowerCase();
  return CLOUD_ASR_PRESETS.find(preset => lower.includes(preset.match));
}
function originOf(baseUrl: string) {
  try { return new URL(baseUrl).origin; } catch { return baseUrl.trim().replace(/\/.*$/, ""); }
}
export function PetVoiceSettings({ value, quiet, onSave, disabled, petEnabled }: { value: VoiceSettings; quiet: boolean; onSave: (value: VoiceSettings, quiet: boolean, credentials?: PetVoiceXfyunCredentials) => Promise<void>; disabled: boolean; petEnabled: boolean }) {
  const [draft, setDraft] = useState<VoiceSettings>({ ...defaultPetVoice, ...value });
  const [draftQuiet, setDraftQuiet] = useState(quiet);
  /// 讯飞凭据只在填写时一次性提交，后端加密落库后清空输入框；已保存值仅在用户点小眼睛时按需解密回显。
  const [xfyun, setXfyun] = useState<PetVoiceXfyunCredentials>({ appId: "", apiKey: "", apiSecret: "" });
  /// 保存成功后递增，用于重置三个密钥框的小眼睛状态（恢复遮罩）。
  const [xfyunEpoch, setXfyunEpoch] = useState(0);
  /// 已解密凭据的临时缓存：三个小眼睛共用一份回显结果，避免每点一次都重新解密；保存后立即作废。
  const xfyunSaved = useRef<PetVoiceXfyunCredentials | null>(null);
  const [status, setStatus] = useState<PetVoiceStatus | null>(null);
  const [download, setDownload] = useState<{ name: string; progress: PetVoiceDownloadProgress | null } | null>(null);
  const [heard, setHeard] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [customCloudModel, setCustomCloudModel] = useState(false);
  useEffect(() => { setDraft({ ...defaultPetVoice, ...value }); }, [value]);
  useEffect(() => { setDraftQuiet(quiet); }, [quiet]);
  const statusRequest = useRef(0);
  const refresh = useCallback(() => {
    if (!runningInTauri) return;
    const request = ++statusRequest.current;
    void client.voiceStatus().then(next => {
      if (request === statusRequest.current) setStatus(next);
    }).catch(() => {
      if (request === statusRequest.current) setStatus(null);
    });
  }, []);
  useEffect(() => { if (!runningInTauri) return; void aiClient.list().then(setProfiles).catch(() => setProfiles([])); }, []);
  useEffect(() => {
    if (!runningInTauri) return;
    refresh();
    const sub = listen("pet-voice-listening", () => { setHeard(""); refresh(); });
    const heardSub = listen<{ text: string }>("pet-voice-heard", e => setHeard(e.payload?.text || ""));
    return () => {
      statusRequest.current++;
      void sub.then(fn => fn());
      void heardSub.then(fn => fn());
    };
  }, [refresh]);
  const change = (patch: Partial<VoiceSettings>) => { setDraft(d => ({ ...d, ...patch })); setError(""); };
  /// 监听期间轮询状态：实际麦克风与分段计数随语音活动实时更新。
  useEffect(() => {
    if (!runningInTauri || !value.enabled || !value.wakeEnabled) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh, value.enabled, value.wakeEnabled]);
  const dirty = draftQuiet !== quiet || JSON.stringify(draft) !== JSON.stringify({ ...defaultPetVoice, ...value });
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
  /// 小眼睛回显：按字段取本机已保存的凭据；未保存时后端返回提示，错误信息不含任何凭据内容。
  const revealXfyun = useCallback(async (field: keyof PetVoiceXfyunCredentials) => {
    const saved = xfyunSaved.current ?? await client.voiceRevealXfyun();
    xfyunSaved.current = saved;
    return saved[field];
  }, []);
  const check = (key: "enabled" | "wakeEnabled" | "autoSend" | "speak" | "cloudAsrEnabled" | "shellEnabled", label: string, description?: string) => <label className="pet-option"><span>{label}{description && <small>{description}</small>}</span><input type="checkbox" checked={draft[key]} onChange={e => change({ [key]: e.target.checked })} /></label>;
  const percent = download?.progress?.totalBytes ? Math.min(100, Math.round((download.progress.downloadedBytes / download.progress.totalBytes) * 100)) : null;
  const cloudProfile = profiles.find(profile => profile.id === draft.cloudProfileId);
  const cloudPreset = cloudAsrPreset(cloudProfile?.baseUrl);
  const cloudModelOptions = cloudPreset?.models ?? [];
  const useCustomCloudModel = customCloudModel || (draft.cloudModel !== "" && !cloudModelOptions.includes(draft.cloudModel));
  return <article className="pet-control-card pet-voice-settings">
    <header><div><strong><AudioLines size={15} aria-hidden="true" />语音对话</strong><small>唤醒与语音指令，支持本地或云端识别</small></div><span className={value.enabled && !quiet ? "pet-life-enabled" : "pet-life-muted"}>{!value.enabled ? "未开启" : quiet ? "勿扰中 · 播报静音" : "已开启"}</span></header>
    <details className="pet-settings-disclosure"><summary>语音识别与常驻唤醒</summary>
      <form onSubmit={e => { e.preventDefault(); void run(async () => {
        const credentials = draft.cloudProvider === "xfyun" && (xfyun.appId.trim() || xfyun.apiKey.trim() || xfyun.apiSecret.trim())
          ? { appId: xfyun.appId.trim(), apiKey: xfyun.apiKey.trim(), apiSecret: xfyun.apiSecret.trim() }
          : undefined;
        if (credentials && (!credentials.appId || !credentials.apiKey || !credentials.apiSecret)) throw new Error("讯飞凭据不完整：APPID、APIKey、APISecret 均需填写");
        await onSave(draft, draftQuiet, credentials);
        setXfyun({ appId: "", apiKey: "", apiSecret: "" });
        xfyunSaved.current = null;
        setXfyunEpoch(current => current + 1);
        setHeard("");
        refresh();
      }); }}>
        <fieldset disabled={disabled || loading}>
          <div className="pet-life-options">
            {check("enabled", "启用语音对话", "唤醒后可连续追问，回答结束后有 20 秒可继续说话。聊天窗口可手动打开查看记录。")}
            {check("autoSend", "识别后自动执行", "关闭后识别文本填入聊天输入框，由你确认后再发送。")}
            {check("shellEnabled", "电脑指令（CMD）", "开启后可在语音或聊天中请求单条 CMD 命令。聊天会先展示完整命令，可点确认或回复“确认”后执行；语音使用确认弹窗。命令链、脚本和一批高危操作会被拒绝并记录审计日志。默认关闭。")}
            {check("speak", "语音回应", "播报唤醒提示、执行结果和语音提问的回答。")}
            <label className="pet-option"><span>桌宠勿扰<small>开启后静音语音播报和互动声音，并暂停主动提醒。</small></span><input type="checkbox" checked={draftQuiet} onChange={e => setDraftQuiet(e.target.checked)} /></label>
            {check("cloudAsrEnabled", "云端识别", "判定为人声的片段上传到所选识别服务商转写，更快更准；失败自动回落本地识别。关闭则全程本机识别。")}
            {check("wakeEnabled", "常驻监听唤醒词", "麦克风保持采集；开启云端识别时命中前的片段会上传所选服务商，未命中且关闭云端时不会离开本机。")}
          </div>
          <div className="pet-life-grid">
            {draft.cloudAsrEnabled && <label>识别服务商<select value={draft.cloudProvider} onChange={e => {
              const provider = e.target.value as VoiceSettings["cloudProvider"];
              setCustomCloudModel(false);
              change(provider === "xfyun" ? { cloudProvider: provider, cloudProfileId: "", cloudEndpoint: "", cloudModel: "" } : { cloudProvider: provider });
            }}><option value="openai">OpenAI 兼容接口（AI 配置密钥）</option><option value="xfyun">讯飞语音听写</option></select><small>讯飞凭据独立加密保存，不复用 AI 配置密钥</small></label>}
            {draft.cloudAsrEnabled && draft.cloudProvider === "xfyun" && <label>讯飞 APPID<SecretField key={`xfyun-appid-${xfyunEpoch}`} secretLabel="讯飞 APPID" aria-label="讯飞 APPID" value={xfyun.appId} maxLength={128} autoComplete="off" spellCheck={false} placeholder={status?.xfyunConfigured ? "已保存，留空保持不变" : "讯飞开放平台应用的 APPID"} reveal={() => revealXfyun("appId")} revealErrorMessage={failure => platformErrorMessage(failure, "无法读取已保存的讯飞凭据")} onChange={e => setXfyun(current => ({ ...current, appId: e.target.value }))} /><small>控制台 → 我的应用管理</small></label>}
            {draft.cloudAsrEnabled && draft.cloudProvider === "xfyun" && <label>讯飞 APIKey<SecretField key={`xfyun-apikey-${xfyunEpoch}`} secretLabel="讯飞 APIKey" aria-label="讯飞 APIKey" value={xfyun.apiKey} maxLength={128} autoComplete="off" spellCheck={false} placeholder={status?.xfyunConfigured ? "已保存，留空保持不变" : "应用的 APIKey"} reveal={() => revealXfyun("apiKey")} revealErrorMessage={failure => platformErrorMessage(failure, "无法读取已保存的讯飞凭据")} onChange={e => setXfyun(current => ({ ...current, apiKey: e.target.value }))} /><small>与 APISecret 成对，来自同一应用</small></label>}
            {draft.cloudAsrEnabled && draft.cloudProvider === "xfyun" && <label>讯飞 APISecret<SecretField key={`xfyun-apisecret-${xfyunEpoch}`} secretLabel="讯飞 APISecret" aria-label="讯飞 APISecret" value={xfyun.apiSecret} maxLength={128} autoComplete="new-password" spellCheck={false} placeholder={status?.xfyunConfigured ? "已保存，留空保持不变" : "应用的 APISecret"} reveal={() => revealXfyun("apiSecret")} revealErrorMessage={failure => platformErrorMessage(failure, "无法读取已保存的讯飞凭据")} onChange={e => setXfyun(current => ({ ...current, apiSecret: e.target.value }))} /><small>本地加密保存；需在讯飞控制台开通「语音听写」（免费额度每日 500 次）</small></label>}
            {draft.cloudAsrEnabled && draft.cloudProvider !== "xfyun" && <label>云端识别配置（用它的密钥）<select value={draft.cloudProfileId} onChange={e => {
              const profile = profiles.find(item => item.id === e.target.value);
              const preset = cloudAsrPreset(profile?.baseUrl);
              setCustomCloudModel(false);
              change({ cloudProfileId: e.target.value, cloudEndpoint: preset?.endpoint ? preset.endpoint(profile?.baseUrl ?? "") : "", cloudModel: "" });
            }}><option value="">请选择</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select><small>选择后自动带出转写地址与识别模型</small></label>}
            {draft.cloudAsrEnabled && draft.cloudProvider !== "xfyun" && <label>转写接口地址<input value={draft.cloudEndpoint} maxLength={200} placeholder="留空 = {服务地址}/audio/transcriptions" onChange={e => change({ cloudEndpoint: e.target.value })} /><small>MiniMax 已自动填 speech_to_text；密钥只发往此地址，请使用官方文档地址</small></label>}
            {draft.cloudAsrEnabled && draft.cloudProvider !== "xfyun" && <label>云端识别模型
              {cloudModelOptions.length > 0 && !useCustomCloudModel
                ? <select value={draft.cloudModel} onChange={e => { if (e.target.value === "__custom") { setCustomCloudModel(true); change({ cloudModel: "" }); } else change({ cloudModel: e.target.value }); }}><option value="">请选择模型</option>{cloudModelOptions.map(model => <option key={model} value={model}>{model}</option>)}<option value="__custom">自定义…</option></select>
                : <input value={draft.cloudModel} maxLength={120} placeholder="按服务商文档填写模型名" onChange={e => change({ cloudModel: e.target.value })} />}
              <small>{cloudModelOptions.length > 0 ? (useCustomCloudModel ? "自定义模式：按服务商文档填写" : "已按所选服务商预置，无需手填") : "该服务商未收录预置模型，请查文档填写"}</small>
              {useCustomCloudModel && cloudModelOptions.length > 0 && <button type="button" className="secondary" onClick={() => { setCustomCloudModel(false); change({ cloudModel: "" }); }}>返回预置选择</button>}
            </label>}
            <label>唤醒词<input value={draft.wakeWord} maxLength={24} placeholder="如：小驼，小花" onChange={e => change({ wakeWord: e.target.value })} /><small>多个唤醒词用逗号隔开，喊任意一个即可；识别成同音字（如“驼/坨”）也能唤醒。</small></label>
            <label>识别语言<select value={draft.language} onChange={e => change({ language: e.target.value })}><option value="zh">中文</option><option value="en">English</option><option value="auto">自动检测</option></select></label>
            <label>最长录音<select value={draft.maxSeconds} onChange={e => change({ maxSeconds: Number(e.target.value) })}>{[30, 60, 90, 120].map(seconds => <option key={seconds} value={seconds}>{seconds} 秒</option>)}</select></label>
            <label>识别模型<select value={draft.modelFile} onChange={e => change({ modelFile: e.target.value })}><option value="">{status?.models.length ? `自动选择（${status.models[0].name}）` : "自动选择"}</option>{status?.models.map(model => <option key={model.name} value={model.name}>{model.name} · {mb(model.sizeBytes)}</option>)}</select></label>
            <label>麦克风<select value={draft.device === "系统默认" ? "" : draft.device} onChange={e => change({ device: e.target.value })}><option value="">系统默认</option>{status?.devices.map(device => <option key={device} value={device}>{device}</option>)}{draft.device && draft.device !== "系统默认" && !status?.devices.includes(draft.device) && <option value={draft.device}>{draft.device}{status ? "（已断开）" : ""}</option>}</select></label>
          </div>
          <div className="pet-life-weather-status"><span>
            {status ? (status.ready ? `模型就绪：${status.selected}` : "未找到模型：可点击下方按钮在线下载，或手动放入模型文件夹") : runningInTauri ? "正在检查语音模型…" : "仅桌面端支持"}
            {status && <small role="status">
              {status.listeningError || (status.listening
                ? status.activeDevice ? `正在监听“${value.wakeWord}” · 实际麦克风：${status.activeDevice}` : "正在启动麦克风…"
                : "常驻监听未启动")}
              {status.listening && status.activeDevice && ` · 已送识别 ${status.segments} 段 · 命中 ${status.matched} 次`}
              {status.listening && status.lastResult && ` · ${WAKE_RESULTS[status.lastResult]}`}
              {status.listening && status.activeDevice && status.segments === 0 && " · 语音段一直为 0 时，请检查输入电平或选择实体麦克风"}
            </small>}
            {status?.listening && status.lastResult === "unmatched" && heard && <small>最后听到：“{heard.slice(0, 80)}”</small>}
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
