import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopPetClient as client, type PetComputerAction, type PetSettings } from "../../platform/clients/desktopPet";
import { platformErrorMessage } from "../../platform/api";
import { petComputerCommand } from "./petComputerCommand";

export interface PetVoiceCallbacks {
  openVoiceDraft: () => void;
  queueChat: (text: string, autoSend: boolean, commandId?: number, localReply?: string | null) => void;
  /** 需要人工确认的系统动作（关机/重启），由现有 ConfirmDialog 承接 */
  requestComputer: (action: "shutdown" | "restart") => void;
  /** 直接执行的低风险动作 */
  runComputer: (action: "lock" | "taskManager" | "explorer") => void;
  /** AI 提议的 CMD 命令：仅传入命令与摘要，执行前必须经用户弹窗确认 */
  requestShell: (command: string, summary: string) => void;
  /** 状态提示气泡；speak 为 true 时桌宠同步语音播报 */
  showHint: (text: string, speak?: boolean) => void;
  acknowledgeWake: (hasCommand: boolean) => void;
  showError: (message: string) => void;
}

interface ListeningEvent {
  active: boolean;
  error: string | null;
}

interface VoiceActivityEvent {
  generation: number;
  active: boolean;
}

function applyVoiceActivity(current: number | null, { generation, active }: VoiceActivityEvent) {
  if (active) return Math.max(current ?? generation, generation);
  return current === generation ? null : current;
}

const VOICE_ACTIONS: Record<string, string> = {
  lock: "已锁定电脑",
  taskManager: "已打开任务管理器",
  explorer: "已打开文件资源管理器",
};

/// 含系统操作/查询类关键词才走 LLM 意图分类，其余直接进聊天，省一跳请求延迟。
/// shell 关键词在未开启电脑指令时也会进分类，由意图层兜底回落 chat，避免误判漏网。
const INTENT_KEYWORDS = /关机|重启|重新启动|锁屏|锁定|任务管理器|资源管理器|天气|气温|云枢|执行|运行|命令|脚本/;

/// 桌宠语音编排：订阅常驻唤醒事件，转写结果经 AI 意图分类后调用既有白名单动作。
export function usePetVoice(settings: PetSettings, callbacks: PetVoiceCallbacks) {
  const [listening, setListening] = useState(false);
  const [listeningError, setListeningError] = useState("");
  const [recognizing, setRecognizing] = useState<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const [amplitude, setAmplitude] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const draftControls = useRef({ cancel: () => {}, send: () => {} });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const runRef = useRef<(text: string, commandId?: number) => void>(() => {});
  const lastTransient = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  /// 同一提示 30 秒内不重复弹出，避免连续语音段刷屏；speak 为 true 时同步语音播报。
  const notifyOnce = (text: string, format: (text: string) => string, speak = false) => {
    if (!text) return;
    const now = Date.now();
    if (lastTransient.current.text === text && now - lastTransient.current.at < 30_000) return;
    lastTransient.current = { text, at: now };
    callbacksRef.current.showHint(format(text), speak);
  };

  useEffect(() => {
    let disposed = false;
    let listeningVersion = 0;
    let commands = Promise.resolve();
    let draft: { text: string; commandId?: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let capturing: number | null = null;
    let recognizing: number | null = null;
    function takeDraft() {
      clearTimeout(timer);
      const current = draft;
      draft = null;
      if (!disposed) setDraftText("");
      return current;
    }
    function sendDraft() {
      const current = takeDraft();
      if (current && settingsRef.current.voice.enabled && settingsRef.current.voice.wakeEnabled) {
        runRef.current(current.text, current.commandId);
      }
    }
    function scheduleDraft() {
      clearTimeout(timer);
      if (draft && capturing === null && recognizing === null) {
        timer = setTimeout(sendDraft, 1800);
      }
    }
    draftControls.current = { cancel: takeDraft, send: sendDraft };
    async function runCommand(text: string, commandId?: number) {
      const trimmed = text.trim();
      if (!trimmed || disposed) return;
      const voice = settingsRef.current.voice;
      if (!voice.enabled) return;
      if (!voice.autoSend) { callbacksRef.current.queueChat(trimmed, false, commandId); return; }
      if (petComputerCommand(trimmed)) {
        callbacksRef.current.queueChat(trimmed, true, commandId);
        return;
      }
      setProcessing(true);
      try {
        const localReply = await client.chatLookup(trimmed);
        if (disposed || !settingsRef.current.voice.enabled) return;
        if (localReply !== null) {
          callbacksRef.current.queueChat(trimmed, true, commandId, localReply);
          return;
        }
        // 无系统操作关键词的普通聊天跳过意图分类，直接把原话交给聊天流式回复。
        if (!INTENT_KEYWORDS.test(trimmed)) {
          callbacksRef.current.queueChat(trimmed, true, commandId, null);
          return;
        }
        const services = await client.chatServices();
        const service = services[0];
        if (!service) { callbacksRef.current.showError("请先在AI设置中配置并启用一个服务"); return; }
        callbacksRef.current.showHint(`正在理解“${trimmed.slice(0, 20)}”…`);
        const intent = await client.voiceIntent(crypto.randomUUID(), service, trimmed, settingsRef.current.voice.shellEnabled);
        if (disposed || !settingsRef.current.voice.enabled) return;
        switch (intent.action) {
          case "shutdown":
          case "restart":
            callbacksRef.current.requestComputer(intent.action);
            break;
          case "shell": {
            const command = (intent.command || "").trim();
            // 后端仅在设置开启时才允许 shell 意图；这里再核对一次，未开启一律回落聊天。
            if (!settingsRef.current.voice.shellEnabled || !command) {
              callbacksRef.current.queueChat(intent.text || trimmed, true, commandId, null);
              break;
            }
            callbacksRef.current.requestShell(command, intent.summary);
            break;
          }
          case "lock":
          case "taskManager":
          case "explorer":
            await client.computerAction(intent.action as PetComputerAction);
            callbacksRef.current.showHint(VOICE_ACTIONS[intent.action] || intent.summary || "已完成", true);
            break;
          case "openApp":
            await client.open("resources");
            callbacksRef.current.showHint("已打开云枢工具箱", true);
            break;
          case "weather": {
            const state = await client.lifeWeather();
            const active = state.notices.filter(notice => notice.kind === "weather" && notice.expiresAt > Date.now() / 1000);
            callbacksRef.current.showHint(active.length
              ? `天气预警：${active.slice(0, 3).map(notice => notice.title).join("；")}`
              : `已查询${state.region || "所在地区"}：当前没有生效的天气预警`, true);
            break;
          }
          default:
            callbacksRef.current.queueChat(intent.text || trimmed, true, commandId, null);
        }
      } catch (error) {
        callbacksRef.current.showError(platformErrorMessage(error));
      } finally {
        if (!disposed) setProcessing(false);
      }
    }
    runRef.current = (text, commandId) => { commands = commands.then(() => runCommand(text, commandId)); };
    const subscriptions = [
      listen<ListeningEvent>("pet-voice-listening", e => {
        listeningVersion++;
        setListening(!!e.payload?.active);
        setListeningError(e.payload?.error || "");
        if (!e.payload?.active) { capturing = null; recognizing = null; takeDraft(); }
      }),
      listen<VoiceActivityEvent>("pet-voice-capturing", e => {
        capturing = applyVoiceActivity(capturing, e.payload);
        scheduleDraft();
      }),
      listen<VoiceActivityEvent>("pet-voice-recognizing", e => {
        recognizing = applyVoiceActivity(recognizing, e.payload);
        setRecognizing(recognizing);
        scheduleDraft();
      }),
      listen<VoiceActivityEvent>("pet-voice-playing", e => { setPlaying(current => applyVoiceActivity(current, e.payload)); if (!e.payload?.active) setAmplitude(null); else setAmplitude(0); }),
      // MiMo 播报的实时声纹（0..1）：小人嘴型按它开合；系统语音没有该事件，前端用伪随机口型。
      listen<{ generation: number; level: number }>("pet-voice-amplitude", e => {
        const level = e.payload?.level;
        if (typeof level === "number") setAmplitude(Math.max(0, Math.min(1, level)));
      }),
      listen("pet-voice-awake", () => callbacksRef.current.acknowledgeWake(false)),
      listen<{ text: string; woke: boolean; commandId: number }>("pet-voice-command", e => {
        if (e.payload?.woke) callbacksRef.current.acknowledgeWake(true);
        const text = e.payload?.text?.trim();
        const voice = settingsRef.current.voice;
        if (!text || !voice.enabled || !voice.wakeEnabled) return;
        if (!voice.autoSend) { runRef.current(text, e.payload.commandId); return; }
        if (!draft) callbacksRef.current.openVoiceDraft();
        draft = { text: draft ? `${draft.text} ${text}` : text, commandId: e.payload.commandId };
        setDraftText(draft.text);
        scheduleDraft();
      }),
      // 听到但未命中唤醒词：展示转写结果，便于确认麦克风工作并校准唤醒词选词。
      listen<{ text: string }>("pet-voice-heard", e => {
        const text = (e.payload?.text || "").trim();
        const word = settingsRef.current.voice.wakeWord.trim();
        notifyOnce(text, heard => word ? `听到“${heard.slice(0, 16)}”，请说“${word}”唤醒我` : `听到“${heard.slice(0, 16)}”，尚未设置唤醒词`);
      }),
      // 常驻监听中的瞬时识别失败（模型异常、推理失败、空转写、云端错误）：气泡 + 语音播报，让用户无需看屏也知道出了什么问题。
      listen<{ message: string }>("pet-voice-error", e => notifyOnce((e.payload?.message || "").trim(), message => message, true)),
      listen<{ message: string }>("pet-voice-playback-error", e => {
        if (e.payload?.message) callbacksRef.current.showError(e.payload.message);
      }),
    ];
    void subscriptions[0].then(async () => {
      if (disposed) return;
      const version = listeningVersion;
      const status = await client.voiceStatus();
      if (!disposed && listeningVersion === version) {
        setListening(!!status.listening);
        setListeningError(status.listeningError || "");
      }
    }).catch(() => {});
    return () => {
      disposed = true;
      takeDraft();
      subscriptions.forEach(promise => void promise.then(unlisten => unlisten()));
    };
  }, []);
  useEffect(() => {
    if (!settings.voice.enabled || !settings.voice.wakeEnabled) draftControls.current.cancel();
  }, [settings.voice.enabled, settings.voice.wakeEnabled]);
  return { listening, listeningError, recognizing: recognizing !== null, playing: playing !== null, amplitude, processing,
    draftText, cancelDraft: () => draftControls.current.cancel(), sendDraft: () => draftControls.current.send(),
    submit: (text: string) => runRef.current(text) };
}
