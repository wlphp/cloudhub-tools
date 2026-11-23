import type { PetSettings, PetSpeechPreset, PetVoiceStatus } from "../../platform/clients/desktopPet";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ListChecks, Mic, Paperclip, Plus, ScissorsLineDashed, Send, ShieldAlert, Square, Volume2, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { desktopPetClient as client, type PetChatAttachment, type PetChatMessage, type PetChatService, type PetChatTraceStep, type PetChatTurn, type PetChatStreamEvent } from "../../platform/clients/desktopPet";
import { platformErrorMessage, runningInTauri, runningOnWindows } from "../../platform/api";
import type { AiImage } from "../../platform/clients/ai";
import { AiImageEditor } from "../ai/AiImageEditor";
import { petAppearances } from "./appearances";
import { PetChatSettings, type PetChatPage } from "./PetChatSettings";
import { petComputerCommand, requestsDesktopWorkbook, type PetComputerCommand } from "./petComputerCommand";
import { PetChatModelDialog, petChatModels } from "./PetChatModelDialog";
import { extractHtmlDocument, requestsDesktopHtml } from "./petComputerCommand";

const RECORD_RATE = 16000;
const hasWindowsSnipping = runningInTauri && runningOnWindows;
const attachmentIsMetadataOnly = (text: string) => text.startsWith("此文件已附加，但当前") || text.startsWith("图片已附加，但当前");
async function fileAsBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}
function mergePcm(chunks: Float32Array[], fromRate: number): Int16Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  const ratio = fromRate / RECORD_RATE;
  const outLength = Math.max(1, Math.floor(merged.length / ratio));
  const out = new Int16Array(outLength);
  for (let index = 0; index < outLength; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, merged.length - 1);
    const sample = merged[left] + (merged[right] - merged[left]) * (position - left);
    out[index] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }
  return out;
}
function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
function microphoneError(error: unknown): string {
  const name = (error as DOMException)?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限被拒绝，请在系统设置中允许桌面应用使用麦克风后重试。";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "未检测到可用麦克风，请连接麦克风后重试。";
  if (name === "NotReadableError") return "麦克风被其他应用占用，请关闭占用后重试。";
  return "麦克风启动失败，请检查设备后重试。";
}

/// 首段可在自然停顿点抢先播报，后续按句切分，减少反复合成。
function takeSentences(buffer: string, earlyFirst: boolean) {
  const sentences: string[] = [];
  let end = 0;
  for (let index = 0; index < buffer.length; index++) {
    const punctuation = "。！？!?；;\n";
    const early = earlyFirst && !sentences.length && index - end >= 12
      && ("，、：".includes(buffer[index])
        || (index - end >= 32 && /[\u3400-\u9fff]/.test(buffer[index]) && /[\u3400-\u9fff]/.test(buffer[index + 1] ?? "")));
    if (punctuation.includes(buffer[index]) || early) {
      let stop = index + 1;
      while (stop < buffer.length && punctuation.includes(buffer[stop])) stop++;
      const sentence = buffer.slice(end, stop).trim();
      if (sentence) sentences.push(sentence);
      end = stop;
      index = stop - 1;
    }
  }
  return { sentences, rest: buffer.slice(end) };
}

interface RecordingSession {
  stream: MediaStream;
  context: AudioContext;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  chunks: Float32Array[];
  startedAt: number;
  timer: number;
}

interface SpokenSentence {
  text: string;
  prepared?: Promise<string | undefined>;
}

export interface PetVoiceTurn {
  text: string;
  autoSend: boolean;
  commandId?: number;
  localReply?: string | null;
}

export type { PetChatPage } from "./PetChatSettings";

export function PetChat({ settings, settingsReady, onSettingsSave, page, onPageChange, skillsActions, alerts, visible, historyVersion, clearingHistory, pendingVoice, voiceActivity, onVoiceConsumed, onVoiceTranscript, voiceDraftText, onVoiceDraftSend, onVoiceDraftCancel, onPrepareSentence, onSpeakSentence, onInterruptSpeech, onVoiceReplyDone, onVoiceError, onReplay, onVoicePreview, onComputerCommand }: {
  settings: PetSettings;
  settingsReady: boolean;
  onSettingsSave: (settings: PetSettings) => Promise<void>;
  page: PetChatPage;
  onPageChange: (page: PetChatPage) => void;
  skillsActions: ReactNode;
  alerts: { count: number; page: ReactNode };
  visible: boolean;
  historyVersion: number;
  clearingHistory: boolean;
  pendingVoice: PetVoiceTurn | undefined;
  voiceActivity: { listening: boolean; listeningError: string; recognizing: boolean; processing: boolean; playing: boolean };
  onVoiceConsumed: () => void;
  onVoiceTranscript: (text: string) => void;
  voiceDraftText: string;
  onVoiceDraftSend: () => void;
  onVoiceDraftCancel: () => void;
  onComputerCommand: (command: PetComputerCommand) => Promise<string>;
  /** 逐句播报一句回复；done 在该句播完（或不可用）后调用，用于串行化句子顺序。 */
  onPrepareSentence: (text: string, id: string) => Promise<void>;
  onSpeakSentence: (text: string, done: () => void, preparedId?: string) => void;
  /** 打断当前语音播报：清空队列外，由上层停止系统语音与 Rust 侧播放。 */
  onInterruptSpeech: () => void;
  /** 本轮全部句子播报完成后回调，用于刷新语音追问窗口。 */
  onVoiceReplyDone: (commandId?: number) => void;
  onVoiceError: (message: string) => void;
  onReplay: (reply: string, done: () => void) => void;
  onVoicePreview: (preset: PetSpeechPreset) => Promise<void>;
}) {
  const { appearance, voice, quiet } = settings;
  const chatVisible = visible && page === "chat";
  const [services, setServices] = useState<PetChatService[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [modelChoice, setModelChoice] = useState<{ channelId: string; model: string } | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [turns, setTurns] = useState<PetChatTurn[]>([]);
  const [pendingMessage, setPendingMessage] = useState<PetChatMessage | null>(null);
  const [loadedHistoryVersion, setLoadedHistoryVersion] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<AiImage | null>(null);
  const [attachment, setAttachment] = useState<PetChatAttachment | null>(null);
  const [attachmentReading, setAttachmentReading] = useState(false);
  const [editingFile, setEditingFile] = useState<File | null>(null);
  const [imageReading, setImageReading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  async function setAgentAccessMode(mode: "ask" | "full") {
    try {
      await onSettingsSave({ ...settings, agentAccessMode: mode });
      setAccessMenuOpen(false);
      setError("");
    } catch (reason) {
      setError(platformErrorMessage(reason, "无法保存本机操作权限"));
    }
  }
  async function toggleHarnessTrace() {
    if (!settingsReady) return;
    const enabled = !settings.harnessTraceEnabled;
    try {
      await onSettingsSave({ ...settings, harnessTraceEnabled: enabled });
      setError("");
    } catch (reason) {
      setError(platformErrorMessage(reason, "无法切换步骤面板"));
    }
  }
  const [voiceStatus, setVoiceStatus] = useState<PetVoiceStatus | null>(null);
  const [requestingMic, setRequestingMic] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const harnessCreatedFile = useRef("");
  const imageEpoch = useRef(0);
  const request = useRef<string | null>(null);
  const lookupRequest = useRef<string | null>(null);
  const voiceDraft = useRef<PetVoiceTurn | null>(null);
  /// 流式回复的渐进显示与逐句播报队列：句子按到达顺序串行播报，全部播完后刷新追问窗口。
  const [streamedReply, setStreamedReply] = useState("");
  const [harnessStatus, setHarnessStatus] = useState("");
  const [traceSteps, setTraceSteps] = useState<PetChatTraceStep[]>([]);
  const [traceTask, setTraceTask] = useState("");
  const [traceResult, setTraceResult] = useState("");
  const [waitingForModel, setWaitingForModel] = useState(false);
  const [compressionRetry, setCompressionRetry] = useState<"context" | "response" | null>(null);
  const [pendingAction, setPendingAction] = useState<
    | { kind: "shell"; command: string; summary: string; userText: string }
    | { kind: "workbook"; summary: string; userText: string }
    | null
  >(null);
  const [actionExecuting, setActionExecuting] = useState(false);
  const showThinking = waitingForModel && !streamedReply.trim();
  const speakBuffer = useRef("");
  const speakQueue = useRef<{ pending: SpokenSentence[]; busy: boolean; finished: (() => void) | null; replyKey: string }>({ pending: [], busy: false, finished: null, replyKey: "pending-reply" });
  const suppressedSpeech = useRef<string | null>(null);
  const [automaticReplyKey, setAutomaticReplyKey] = useState<string | null>(null);
  const [replayKey, setReplayKey] = useState<string | null>(null);
  const replayRevision = useRef(0);
  const speakHandlers = useRef({ speak: onSpeakSentence, prepare: onPrepareSentence, interrupt: onInterruptSpeech });
  speakHandlers.current = { speak: onSpeakSentence, prepare: onPrepareSentence, interrupt: onInterruptSpeech };
  const visibleRef = useRef(chatVisible);
  visibleRef.current = chatVisible;
  const mounted = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const followReply = useRef(true);
  const prependScroll = useRef<{ height: number; top: number } | null>(null);
  const historyRead = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const session = useRef<RecordingSession | null>(null);
  const stopRef = useRef<(cancel?: boolean) => void>(() => {});
  const service = services.find(item => item.id === serviceId);
  const selectedModel = service && modelChoice?.channelId === service.id && petChatModels(service).includes(modelChoice.model)
    ? modelChoice.model : service?.model ?? "";
  const visionReady = !!service?.supportsImages && selectedModel === service.model;
  const imageBusy = !!editingFile || imageReading || attachmentReading;
  const voiceInputActive = requestingMic || recording || transcribing;
  const [savingWake, setSavingWake] = useState(false);
  const wakeEnabled = voice.enabled && voice.wakeEnabled;
  const listening = wakeEnabled && voiceActivity.listening;

  async function toggleWake() {
    if (!settingsReady || !voice.enabled || savingWake) return;
    setSavingWake(true);
    setError("");
    try {
      await onSettingsSave({ ...settings, voice: { ...voice, wakeEnabled: !wakeEnabled } });
    } catch (error) {
      if (mounted.current) setError(platformErrorMessage(error));
    } finally {
      if (mounted.current) setSavingWake(false);
    }
  }
  const historyReady = loadedHistoryVersion === historyVersion;
  function addImage(file: File) {
    if (busy || voiceInputActive) return;
    if (!visionReady) {
      setAttachment({ name: file.name, text: `图片已附加，但当前聊天服务未启用图像识别，因此模型暂时看不到图片内容。文件类型：${file.type || "图片"}；大小：${file.size.toLocaleString()} 字节。可在 AI 设置中完成图像能力测试后重新拖入。` });
      setError("");
      return;
    }
    imageEpoch.current++;
    setImageReading(false); setImage(null); setError(""); setEditingFile(file);
  }
  function addDocumentText(name: string, contents: string) {
    if (busy || voiceInputActive) return;
    const text = contents.replace(/^\uFEFF/, "").trim();
    if (!text || Array.from(text).length > 24_000) { setError("附件内容为空或超过 24,000 字符。"); return; }
    setAttachment({ name, text });
    setError("");
    input.current?.focus();
  }
  async function addDocumentFile(file: File) {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (file.size === 0 || file.size > 5 * 1024 * 1024) { setError("附件必须是非空文件，且不能超过 5 MiB。"); return; }
    if (runningInTauri) {
      setAttachmentReading(true); setError("");
      try {
        const document = await client.readChatDocumentBytes(file.name, await fileAsBase64(file));
        setAttachment(document);
        input.current?.focus();
      } catch (reason) { setError(platformErrorMessage(reason, "无法读取此附件")); }
      finally { setAttachmentReading(false); }
      return;
    }
    if (!["txt", "md", "csv", "tsv", "json", "log", "xml", "html", "yaml", "yml", "toml"].includes(extension)) {
      setAttachment({ name: file.name, text: `此文件已附加，但当前运行环境无法提取该格式的正文。模型收到的是文件名、类型和大小信息，不包含文件实际内容。文件类型：${file.type || extension || "未知"}；大小：${file.size.toLocaleString()} 字节。若需要分析正文，请将文件另存为 TXT、CSV、Markdown 或 XLSX 后重新拖入。` });
      setError("");
      return;
    }
    setAttachmentReading(true); setError("");
    try { addDocumentText(file.name, await file.text()); }
    catch { setError("无法读取此附件，请检查文件编码后重试。"); }
    finally { setAttachmentReading(false); }
  }
  async function pasteScreenshot() {
    const keyboardHint = "请先截屏，再在输入框按 Ctrl+V（macOS 按 ⌘V）粘贴。";
    if (!navigator.clipboard?.read) { setError(keyboardHint); input.current?.focus(); return; }
    const epoch = ++imageEpoch.current;
    setImageReading(true);
    setError("");
    try {
      const items = await navigator.clipboard.read();
      const item = items.find(entry => entry.types.includes("image/png") || entry.types.includes("image/jpeg"));
      const type = item?.types.includes("image/png") ? "image/png" : "image/jpeg";
      const blob = await item?.getType(type);
      if (!mounted.current || epoch !== imageEpoch.current || !visibleRef.current) return;
      if (blob) addImage(new File([blob], type === "image/png" ? "screenshot.png" : "screenshot.jpg", { type }));
      else setError("剪贴板中没有可用的图片。" + keyboardHint);
    } catch {
      if (mounted.current && epoch === imageEpoch.current && visibleRef.current) setError(keyboardHint);
    } finally {
      if (mounted.current && epoch === imageEpoch.current) setImageReading(false);
    }
  }
  function captureScreenshot() {
    if (!hasWindowsSnipping) { void pasteScreenshot(); return; }
    setError("");
    input.current?.focus();
    void client.open("screenshot").catch(e => { if (mounted.current) setError(platformErrorMessage(e)); });
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; imageEpoch.current++; if (request.current) void client.cancelChat(request.current).catch(() => {}); };
  }, []);
  useEffect(() => {
    const read = ++historyRead.current;
    setHistoryLoading(true);
    setTurns([]);
    setHasOlder(false);
    setError("");
    void client.chatHistory().then(result => {
      if (read !== historyRead.current) return;
      setTurns(result.turns);
      setHasOlder(result.hasOlder);
      setLoadedHistoryVersion(historyVersion);
    }).catch(e => { if (read === historyRead.current) setError(platformErrorMessage(e)); })
      .finally(() => { if (read === historyRead.current) setHistoryLoading(false); });
    return () => { historyRead.current++; prependScroll.current = null; };
  }, [historyVersion, historyRetry]);

  async function loadOlder() {
    if (!hasOlder || historyLoading || clearingHistory || !turns.length) return;
    const read = ++historyRead.current;
    setHistoryLoading(true);
    try {
      const before = turns.find(turn => typeof turn.id === "number")?.id;
      if (typeof before !== "number") return;
      const result = await client.chatHistory(before);
      if (read !== historyRead.current) return;
      if (log.current && result.turns.length) prependScroll.current = { height: log.current.scrollHeight, top: log.current.scrollTop };
      setTurns(current => [...result.turns, ...current]);
      setHasOlder(result.hasOlder);
    } catch (e) {
      if (read === historyRead.current) setError(platformErrorMessage(e));
    } finally {
      if (read === historyRead.current) setHistoryLoading(false);
    }
  }
  useEffect(() => {
    let disposed = false;
    void client.chatServices().then(items => {
      if (disposed) return;
      setServices(items);
      setServiceId(previous => items.some(item => item.id === previous) ? previous : items[0]?.id || "");
      setLoaded(true);
    }).catch(e => {
      if (!disposed) { setError(platformErrorMessage(e)); setLoaded(true); }
    });
    return () => { disposed = true; };
  }, [visible]);
  useEffect(() => {
    if (chatVisible && loaded) input.current?.focus();
    if (!chatVisible && session.current) stopRef.current(true);
  }, [chatVisible, loaded]);
  useEffect(() => {
    if (!visible) setTurns(current => current.some(turn => turn.local) ? current.filter(turn => !turn.local) : current);
    if (!visible) setModelDialogOpen(false);
  }, [visible]);
  useEffect(() => {
    if (!pendingAction) return;
    const timer = window.setTimeout(() => {
      setPendingAction(null);
      setTurns(current => [...current, { id: crypto.randomUUID(), user: "本机操作确认超时", reply: "待确认操作已过期，没有执行。需要时请重新提出请求。", local: true }]);
    }, 90_000);
    return () => window.clearTimeout(timer);
  }, [pendingAction?.kind, pendingAction?.kind === "shell" ? pendingAction.command : "", pendingAction?.userText]);
  useEffect(() => {
    if (!runningInTauri || !visible || !voice.enabled) return;
    let disposed = false;
    void client.voiceStatus().then(status => { if (!disposed) setVoiceStatus(status); }).catch(() => {});
    return () => { disposed = true; };
  }, [visible, voice.enabled]);
  useEffect(() => {
    if (!recording) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); stopRef.current(true); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [recording]);
  useEffect(() => {
    if (!pendingVoice || !loaded || !historyReady || clearingHistory || busy || recording || transcribing || request.current) return;
    const { text: incoming, autoSend } = pendingVoice;
    onVoiceConsumed();
    if (autoSend) {
      void sendText(incoming, pendingVoice);
      return;
    }
    voiceDraft.current = pendingVoice;
    setText(previous => previous ? `${previous}${previous.endsWith(" ") ? "" : " "}${incoming}` : incoming);
    if (visibleRef.current) input.current?.focus();
  }, [pendingVoice, loaded, historyReady, clearingHistory, busy, recording, transcribing, service, selectedModel]);
  useEffect(() => {
    if (!runningInTauri || !visible) return;
    let disposed = false;
    const listener = getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload;
      if (payload.type === "leave") { setDropActive(false); return; }
      const bounds = root.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio, y = payload.position.y / window.devicePixelRatio;
      const inside = visibleRef.current && !!bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
      setDropActive(inside && payload.type !== "drop" && !busy && !voiceInputActive);
      if (payload.type !== "drop" || !inside || busy || voiceInputActive) return;
      if (payload.paths.length !== 1) { setError("请一次拖入一个文件。"); return; }
      const sourcePath = payload.paths[0];
      const fileName = sourcePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
      if (!/\.(?:png|jpe?g|gif|webp)$/i.test(fileName)) {
        setAttachmentReading(true); setError("");
        void client.readChatDocument(sourcePath).then(document => {
          if (!disposed && mounted.current) setAttachment(document);
        }).catch(reason => { if (!disposed && mounted.current) setError(platformErrorMessage(reason)); })
          .finally(() => { if (!disposed && mounted.current) setAttachmentReading(false); });
        return;
      }
      if (!visionReady) {
        setAttachmentReading(true); setError("");
        void client.readChatDocument(sourcePath).then(document => { if (!disposed && mounted.current) setAttachment(document); })
          .catch(reason => { if (!disposed && mounted.current) setError(platformErrorMessage(reason)); })
          .finally(() => { if (!disposed && mounted.current) setAttachmentReading(false); });
        return;
      }
      const epoch = ++imageEpoch.current;
      setImageReading(true); setImage(null); setEditingFile(null); setError("");
      void client.readChatImage(sourcePath).then(async dataUrl => {
        const blob = await (await fetch(dataUrl)).blob();
        if (!disposed && mounted.current && epoch === imageEpoch.current) addImage(new File([blob], "dropped-image", { type: blob.type }));
      }).catch(e => { if (!disposed && mounted.current && epoch === imageEpoch.current) setError(platformErrorMessage(e)); })
        .finally(() => { if (!disposed && mounted.current && epoch === imageEpoch.current) setImageReading(false); });
    });
    return () => { disposed = true; void listener.then(unlisten => unlisten()); };
  }, [visible, busy, voiceInputActive, visionReady, serviceId, selectedModel]);
  useLayoutEffect(() => {
    if (!chatVisible || !log.current) return;
    const previous = prependScroll.current;
    prependScroll.current = null;
    if (previous) log.current.scrollTop = previous.top + log.current.scrollHeight - previous.height;
    else if (followReply.current) log.current.scrollTop = log.current.scrollHeight;
  }, [chatVisible, turns, busy, showThinking]);
  useLayoutEffect(() => {
    if (chatVisible && streamedReply && followReply.current && log.current) {
      log.current.scrollTop = log.current.scrollHeight;
    }
  }, [chatVisible, streamedReply]);
  function prepareNextSentence() {
    const queue = speakQueue.current;
    const next = queue.pending[0];
    if (!queue.busy || !next || next.prepared) return;
    const id = crypto.randomUUID();
    next.prepared = speakHandlers.current.prepare(next.text, id).then(() => id, () => undefined);
  }
  /// 播放始终串行。上一句播放期间只提前合成下一句。
  function drainSpeakQueue() {
    const queue = speakQueue.current;
    if (queue.busy) return;
    const sentence = queue.pending.shift();
    if (!sentence) {
      setAutomaticReplyKey(null);
      if (queue.finished) { const finished = queue.finished; queue.finished = null; finished(); }
      return;
    }
    queue.busy = true;
    setAutomaticReplyKey(queue.replyKey);
    const play = (preparedId?: string) => {
      if (!mounted.current || speakQueue.current !== queue) return;
      speakHandlers.current.speak(sentence.text, () => {
        if (!mounted.current || speakQueue.current !== queue) return;
        queue.busy = false;
        drainSpeakQueue();
      }, preparedId);
      if (speakQueue.current === queue) prepareNextSentence();
    };
    if (sentence.prepared) void sentence.prepared.then(play);
    else play();
  }
  function enqueueSpeak(sentences: string[]) {
    if (!sentences.length) return;
    speakQueue.current.pending.push(...sentences.map(text => ({ text })));
    drainSpeakQueue();
    prepareNextSentence();
  }
  /// 丢弃未播句子并打断当前句：新一轮语音回复或请求失败时调用。
  function stopSpeakQueue() {
    speakQueue.current = { pending: [], busy: false, finished: null, replyKey: "pending-reply" };
    setAutomaticReplyKey(null);
    speakHandlers.current.interrupt();
  }
  function replayReply(key: string, reply: string) {
    const revision = ++replayRevision.current;
    suppressedSpeech.current = request.current;
    speakQueue.current = { pending: [], busy: false, finished: null, replyKey: "pending-reply" };
    setAutomaticReplyKey(null);
    setReplayKey(key);
    onReplay(reply, () => { if (mounted.current && revision === replayRevision.current) setReplayKey(null); });
  }
  async function sendText(content: string, voiceTurn = voiceDraft.current) {
    const background = voiceTurn?.autoSend === true;
    const sentImage = background ? null : image;
    const sentAttachment = background ? null : attachment;
    if (!historyReady || clearingHistory || (!content.trim() && !sentImage && !sentAttachment) || request.current || (!background && imageBusy)) return;
    const userMessage = {
      role: "user" as const,
      text: content.trim() || (sentImage ? "请看看这张图片。" : `请查看附件：${sentAttachment?.name ?? ""}`),
      ...(sentImage ? { image: sentImage.dataUrl } : {}),
      ...(sentAttachment ? { attachment: sentAttachment } : {}),
    };
    const confirmation = /^(?:确认|继续|同意|执行|好|好的|可以)[。！! ]*$/.test(userMessage.text.trim());
    const cancellation = /^(?:取消|算了|不用|停止)[。！! ]*$/.test(userMessage.text.trim());
    if (pendingAction && (confirmation || cancellation)) {
      if (!background) { setText(""); setPendingMessage(userMessage); }
      const proposal = pendingAction;
      setPendingAction(null);
      if (cancellation) {
        setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: "已取消这项本机操作，没有执行。", local: true }]);
        setPendingMessage(null);
        return;
      }
      setBusy(true); setActionExecuting(true);
      try {
        if (proposal.kind === "workbook") {
          const name = await client.createDesktopWorkbook();
          setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: `已在桌面创建空白 Excel 工作簿：${name}`, local: true }]);
        } else {
          const result = await client.shellCommand(proposal.command);
          const status = result.timedOut ? "命令超时，已中止" : result.exitCode === 0 ? "命令执行完成" : `命令退出，退出码 ${result.exitCode}`;
          const output = result.output.trim();
          const reply = `${status}（耗时 ${(result.durationMs / 1000).toFixed(1)} 秒）${output ? `。\n\n${output.slice(0, 4000)}${output.length > 4000 ? "\n…（输出已截断）" : ""}` : "，命令没有输出。"}`;
          setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply, local: true, failed: result.exitCode !== 0 || result.timedOut }]);
        }
      } catch (reason) {
        setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: platformErrorMessage(reason, "本机操作执行失败"), local: true, failed: true }]);
      } finally { setBusy(false); setActionExecuting(false); setPendingMessage(null); }
      return;
    }
    if (pendingAction && !confirmation && !cancellation) {
      setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: "这项操作仍在等待确认。请点下方按钮，或直接回复“确认”或“取消”。", local: true }]);
      if (!background) { setText(""); setImage(null); }
      return;
    }
    const id = crypto.randomUUID(); request.current = id;
    lookupRequest.current = id;
    if (!background) { voiceDraft.current = null; setText(""); setImage(null); setAttachment(null); }
    setPendingMessage(userMessage); setError(""); setBusy(true); setStreamedReply("");
    setHarnessStatus(""); harnessCreatedFile.current = "";
    if (settings.harnessTraceEnabled) { setTraceSteps([]); setTraceTask(userMessage.text); setTraceResult("任务执行中…"); }
    followReply.current = true;
    speakBuffer.current = "";
    suppressedSpeech.current = null;
    replayRevision.current++;
    setReplayKey(null);
    stopSpeakQueue();
    try {
      if (!sentImage && requestsDesktopWorkbook(userMessage.text)) {
        if (settings.agentAccessMode === "full") {
          setActionExecuting(true);
          try {
            const name = await client.createDesktopWorkbook();
            setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: `已在桌面创建空白 Excel 工作簿：${name}`, local: true }]);
          } catch (reason) {
            setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: platformErrorMessage(reason, "创建工作簿失败"), local: true, failed: true }]);
          } finally { setActionExecuting(false); setBusy(false); setPendingMessage(null); }
          return;
        }
        setPendingAction({ kind: "workbook", summary: "在桌面创建一个空白 Excel 工作簿", userText: userMessage.text });
        setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: "我可以直接创建一个空白 .xlsx 工作簿。确认后会保存在桌面；若同名文件已存在，会自动使用下一个可用文件名，不会覆盖原文件。", local: true }]);
        setPendingMessage(null);
        return;
      }
      const command = typeof voiceTurn?.localReply !== "string" && !sentImage ? petComputerCommand(userMessage.text) : null;
      const localReply = sentAttachment ? null : command ? await onComputerCommand(command) : voiceTurn?.localReply === undefined
        ? await client.chatLookup(userMessage.text, !!sentImage)
        : voiceTurn.localReply;
      if (!mounted.current || request.current !== id) return;
      lookupRequest.current = null;
      if (localReply !== null) {
        if (settings.harnessTraceEnabled) setTraceResult(localReply);
        if (visibleRef.current) setTurns(current => [...current, { id, user: userMessage.text, reply: localReply, local: true }]);
        return;
      }
      if (!service) throw new Error("请先在 AI 设置中配置聊天服务，或输入“查资料”查看本地查询用法。");
      setWaitingForModel(true);
      const requestsShell = !sentImage && settings.voice.shellEnabled && /(?:执行|运行|打开|查询|查看|列出|创建|新建|写入|删除).{0,24}(?:命令|cmd|powershell|文件|文件夹|程序|电脑|本机)/i.test(userMessage.text);
      if (requestsShell) {
        const intent = await client.voiceIntent(id, service, userMessage.text, true);
        if (!mounted.current || request.current !== id) return;
        if (intent.action === "shell" && intent.command) {
          if (settings.agentAccessMode === "full") {
            setActionExecuting(true);
            try {
              const result = await client.shellCommand(intent.command);
              const status = result.timedOut ? "命令执行超时" : result.exitCode === 0 ? "命令执行完成" : `命令退出，退出码 ${result.exitCode}`;
              const output = result.output.trim();
              setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: `${status}${output ? `。\n\n${output.slice(0, 4000)}${output.length > 4000 ? "\n…（输出已截断）" : ""}` : "，命令没有输出。"}`, local: true, failed: result.exitCode !== 0 || result.timedOut }]);
            } catch (reason) {
              setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: platformErrorMessage(reason, "本机操作执行失败"), local: true, failed: true }]);
            } finally { setActionExecuting(false); setBusy(false); setPendingMessage(null); }
            return;
          }
          setPendingAction({ kind: "shell", command: intent.command, summary: intent.summary || "桌宠建议执行本机命令", userText: userMessage.text });
          setTurns(current => [...current, { id: crypto.randomUUID(), user: userMessage.text, reply: `待确认的本机命令：\n${intent.command}\n\n请在 90 秒内点击确认或取消；不确认不会执行。`, local: true }]);
          setPendingMessage(null);
          return;
        }
      }
      let receivedSpeechDelta = false;
      let queuedSpeech = false;
      const wantsDesktopHtml = !sentImage && requestsDesktopHtml(userMessage.text);
      const modelMessage = wantsDesktopHtml
        ? `${userMessage.text}\n\n请直接生成精简、可运行的 HTML5 单文件网页，所有 CSS 和 JavaScript 内嵌，控制在 12000 个字符内，并提供一个完整的 html 代码块，不要只给片段或保存说明。`
        : userMessage.text;
      const receiveDelta = (delta: string) => {
        if (!mounted.current || request.current !== id) return;
        setStreamedReply(previous => previous + delta);
        if (suppressedSpeech.current === id) return;
        receivedSpeechDelta = true;
        speakBuffer.current += delta;
        const { sentences, rest } = takeSentences(speakBuffer.current, !queuedSpeech);
        if (sentences.length) {
          queuedSpeech = true;
          speakBuffer.current = rest;
          enqueueSpeak(sentences);
        }
      };
      const receiveEvent = (event: PetChatStreamEvent) => {
        if (!mounted.current || request.current !== id) return;
        if (event.step) setTraceSteps(current => {
          const existing = current.findIndex(step => step.id === event.step!.id);
          if (existing < 0) return [...current, event.step!];
          const next = [...current]; next[existing] = event.step!; return next;
        });
        if (event.status) {
          setHarnessStatus(event.status);
          if (event.status.startsWith("已创建桌面文件：")) harnessCreatedFile.current = event.status.slice("已创建桌面文件：".length);
        }
        if (event.text) receiveDelta(event.text);
      };
      let turn: PetChatTurn;
      try {
        turn = await client.chatStream(id, service, modelMessage, receiveEvent, sentImage || undefined, selectedModel, false, false, sentAttachment || undefined);
      } catch (firstError) {
        const detail = platformErrorMessage(firstError, "");
        if (!/模型响应超过本地 4 MiB 接收上限|AI上下文超过模型限制|上下文.{0,8}(?:超限|过长)|context.{0,12}(?:length|limit|too large)|maximum context|too many tokens|prompt is too long/i.test(detail)) throw firstError;
        const responseTooLarge = /模型响应超过本地 4 MiB 接收上限/i.test(detail);
        setCompressionRetry(responseTooLarge ? "response" : "context");
        setStreamedReply("");
        speakBuffer.current = "";
        if (receivedSpeechDelta) { stopSpeakQueue(); receivedSpeechDelta = false; queuedSpeech = false; }
        try {
          turn = await client.chatStream(id, service, modelMessage, receiveEvent, sentImage || undefined, selectedModel, true, responseTooLarge, sentAttachment || undefined);
        } catch (retryError) {
          throw new Error(`${responseTooLarge ? "限制回复长度并压缩上下文后" : "压缩上下文后"}重试仍失败：${platformErrorMessage(retryError, "请缩短问题后重试")}`);
        } finally { setCompressionRetry(null); }
      }
      if (mounted.current && request.current === id) {
        if (settings.harnessTraceEnabled) setTraceResult(turn.reply);
        setTurns(current => [...current, { ...turn, user: userMessage.text, ...(sentAttachment ? { attachment: sentAttachment } : {}) }]);
        if (wantsDesktopHtml && !harnessCreatedFile.current) {
          const html = extractHtmlDocument(turn.reply);
          if (html) await saveDesktopHtml(html);
          else setTurns(current => [...current, { id: crypto.randomUUID(), user: "创建桌面 HTML 文件", reply: "模型没有返回完整 HTML 文档，未创建文件。可以让它重新生成完整 HTML。", local: true, failed: true }]);
        }
        speakQueue.current.replyKey = `${turn.id}-assistant`;
        setAutomaticReplyKey(key => key === "pending-reply" ? `${turn.id}-assistant` : key);
        if (suppressedSpeech.current !== id) {
          if (voiceTurn) speakQueue.current.finished = () => onVoiceReplyDone(voiceTurn.commandId);
          const tail = (receivedSpeechDelta ? speakBuffer.current : turn.reply).trim();
          speakBuffer.current = "";
          if (tail) enqueueSpeak([tail]);
          else drainSpeakQueue();
        }
      }
    } catch (e) {
      if (mounted.current && request.current === id) {
        const message = platformErrorMessage(e);
        if (settings.harnessTraceEnabled) setTraceResult(`执行失败：${message}`);
        if (visibleRef.current) {
          setTurns(current => [...current, { id, user: userMessage.text, image: userMessage.image, attachment: userMessage.attachment, reply: message, local: true, failed: true }]);
        } else if (background) onVoiceError(message);
        if (suppressedSpeech.current !== id) stopSpeakQueue();
        setStreamedReply("");
      }
    } finally {
      if (lookupRequest.current === id) lookupRequest.current = null;
      if (mounted.current && request.current === id) { request.current = null; setPendingMessage(null); setBusy(false); setWaitingForModel(false); setStreamedReply(""); setHarnessStatus(""); harnessCreatedFile.current = ""; if (visibleRef.current) input.current?.focus(); }
    }
  }
  async function startRecording() {
    if (voiceInputActive || session.current || busy || imageBusy) return;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined" || !AudioContext.prototype.createScriptProcessor) { setError("当前环境不支持麦克风录音。"); return; }
    setRequestingMic(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || !visibleRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const context = new AudioContext({ sampleRate: RECORD_RATE });
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = event => { chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
      source.connect(processor);
      const sink = context.createGain();
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(context.destination);
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        setRecordSeconds(Math.floor((Date.now() - startedAt) / 1000));
        if (Date.now() - startedAt >= voice.maxSeconds * 1000) stopRef.current(false);
      }, 250);
      session.current = { stream, context, processor, source, chunks, startedAt, timer };
      setRecording(true); setRecordSeconds(0);
    } catch (e) {
      setError(microphoneError(e));
    } finally {
      if (mounted.current) setRequestingMic(false);
    }
  }
  async function stopRecording(cancel = false) {
    const current = session.current;
    if (!current) return;
    session.current = null;
    window.clearInterval(current.timer);
    setRecording(false);
    try {
      current.processor.disconnect(); current.source.disconnect();
      current.stream.getTracks().forEach(track => track.stop());
      void current.context.close();
    } catch { /* 录音清理失败不影响转写 */ }
    if (cancel) return;
    setTranscribing(true);
    try {
      const pcm = mergePcm(current.chunks, current.context.sampleRate);
      const transcript = await client.voiceTranscribe(pcmToBase64(pcm));
      if (!mounted.current || transcript === null) return;
      onVoiceTranscript(transcript);
    } catch (e) {
      if (mounted.current) setError(platformErrorMessage(e));
    } finally {
      if (mounted.current) setTranscribing(false);
    }
  }
  stopRef.current = cancel => void stopRecording(cancel);
  async function stop() {
    const id = request.current;
    if (!id) return;
    suppressedSpeech.current = id;
    stopSpeakQueue();
    if (lookupRequest.current === id) {
      lookupRequest.current = null;
      request.current = null;
      setPendingMessage(null);
      setBusy(false);
      return;
    }
    try {
      await client.cancelChat(id);
      if (mounted.current && request.current === id) setWaitingForModel(false);
    } catch (e) { if (mounted.current) setError(platformErrorMessage(e)); }
  }
  const showingVoiceDraft = !text && !!voiceDraftText;
  const hasDraft = !!(text.trim() || image || attachment || voiceDraftText);
  const contextDraft = pendingMessage?.text ?? (showingVoiceDraft ? voiceDraftText : text);
  const contextCharacters = Array.from([
    settings.chatPrompt ?? "",
    ...turns.slice(-9).flatMap(turn => [turn.user, turn.reply, turn.attachment?.text ?? ""]),
    contextDraft, attachment?.text ?? "",
  ].filter(Boolean).join("\n")).length;
  function submitComposer() {
    if (voiceInputActive) return;
    if (showingVoiceDraft) onVoiceDraftSend();
    else void sendText(text);
  }
  const liveStatus = requestingMic ? { label: "正在打开麦克风", tone: "active" }
    : recording ? { label: "录音中", tone: "listening" }
    : transcribing ? { label: "识别中", tone: "active" }
    : busy ? { label: "回复中", tone: "active" }
    : voiceActivity.processing ? { label: "理解指令中", tone: "active" }
    : voiceActivity.playing ? { label: "播报中", tone: "active" }
    : wakeEnabled && voiceActivity.recognizing ? { label: "识别中", tone: "active" }
    : voiceDraftText ? { label: "停顿后自动发送", tone: "active" }
    : attachmentReading ? { label: "读取附件中", tone: "active" }
    : imageReading ? { label: "读取图片中", tone: "active" }
    : voiceActivity.listeningError && wakeEnabled ? { label: "监听异常", tone: "error", title: voiceActivity.listeningError }
    : listening ? { label: "聆听中…", tone: "listening", title: `等待唤醒词“${voice.wakeWord}”` }
    : wakeEnabled ? { label: "正在启动监听", tone: "active" }
    : { label: "待命", tone: "idle" };
  const voiceTitle = !voice.enabled ? "语音对话未启用，可在宠物设置中开启"
    : !voiceStatus ? "正在检查语音模型…"
    : !voiceStatus.ready ? `尚未放置语音模型，请先在宠物设置中配置（模型文件夹：${voiceStatus.modelsDir}）`
    : recording ? "停止录音并识别" : "语音输入，点击开始说话";
  const modelButton = <button type="button" className="pet-chat-model-button"
    aria-label={selectedModel ? `切换聊天模型，当前 ${selectedModel}` : "选择聊天模型"}
    aria-haspopup="dialog" title={service ? `${service.name} · ${selectedModel}` : "选择聊天模型"}
    disabled={busy || !loaded || voiceInputActive} onClick={() => setModelDialogOpen(true)}>
    <span>{selectedModel || (loaded ? "选择模型" : "读取中…")}</span><ChevronDown size={13} aria-hidden="true" />
  </button>;
  const serviceControls = <div className="pet-chat-service">{modelButton}</div>;
  const messages = turns.flatMap<PetChatMessage & { key: string; local?: boolean; failed?: boolean }>(turn => [
    { key: `${turn.id}-user`, role: "user", text: turn.user, image: turn.image, attachment: turn.attachment },
    { key: `${turn.id}-assistant`, role: "assistant", text: turn.reply, local: turn.local, failed: turn.failed },
  ]);
  async function saveDesktopHtml(content: string) {
    const traceId = 100;
    if (settings.harnessTraceEnabled) setTraceSteps(current => [...current, { id: traceId, tool: "create_desktop_html", title: "保存 HTML 到桌面", state: "running" }]);
    try {
      const name = await client.createDesktopHtml(content);
      if (settings.harnessTraceEnabled) {
        setTraceSteps(current => current.map(step => step.id === traceId ? { ...step, state: "completed", detail: `已保存：${name}` } : step));
        setTraceResult(`HTML 已保存到桌面：${name}`);
      }
      if (mounted.current && visibleRef.current) setTurns(current => [...current, { id: crypto.randomUUID(), user: "本机文件操作", reply: `已直接保存到桌面：${name}`, local: true }]);
    } catch (reason) {
      const message = platformErrorMessage(reason, "创建桌面 HTML 文件失败");
      if (settings.harnessTraceEnabled) {
        setTraceSteps(current => current.map(step => step.id === traceId ? { ...step, state: "failed", detail: message } : step));
        setTraceResult(`执行失败：${message}`);
      }
      if (mounted.current && visibleRef.current) setTurns(current => [...current, { id: crypto.randomUUID(), user: "创建桌面 HTML 文件", reply: message, local: true, failed: true }]);
    }
  }
  if (pendingMessage) {
    messages.push({ key: "pending", ...pendingMessage });
    if (streamedReply.trim()) messages.push({ key: "pending-reply", role: "assistant", text: streamedReply });
  }
  const speakingReplyKey = voiceActivity.playing ? replayKey ?? automaticReplyKey : null;
  return <>
    {visible && modelDialogOpen && <PetChatModelDialog services={services} current={service} currentModel={selectedModel} busy={busy}
      onClose={() => setModelDialogOpen(false)}
      onManage={() => { setModelDialogOpen(false); void client.open("aiSettings").catch(error => setError(platformErrorMessage(error))); }}
      onApply={(channel, model) => {
        if (channel.id !== serviceId || model !== selectedModel) {
          imageEpoch.current++;
          setServiceId(channel.id);
          setModelChoice({ channelId: channel.id, model });
          setImage(null);
          setEditingFile(null);
          setImageReading(false);
          setError("");
        }
        setModelDialogOpen(false);
      }} />}
    {page !== "chat" && <PetChatSettings page={page} onPageChange={onPageChange} settings={settings} ready={settingsReady} serviceControls={serviceControls} skillsActions={skillsActions} alerts={alerts}
      supportsImages={visionReady} canTry={!!service && !busy && !imageBusy && !recording} canTryLocal={!busy && !imageBusy && !recording}
      onSave={onSettingsSave} onVoicePreview={onVoicePreview} onTry={prompt => { voiceDraft.current = null; setText(previous => previous.trim() ? `${previous}\n${prompt}` : prompt); onPageChange("chat"); }} />}
    <div hidden={page !== "chat"} ref={root} className={`pet-chat${dropActive ? " is-file-drag-over" : ""}`} data-trace-visible={settings.harnessTraceEnabled || undefined} onDragOver={e => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDropActive(!busy && !voiceInputActive); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false); }} onDrop={e => { if (runningInTauri) { e.preventDefault(); return; } const files = Array.from(e.dataTransfer.files); if (!files.length) return; e.preventDefault(); setDropActive(false); if (busy || voiceInputActive) return; if (files.length !== 1) { setError("请一次拖入一个文件。"); return; } const file = files[0]; if (file.type.startsWith("image/")) addImage(file); else void addDocumentFile(file); }}>
    <div className="pet-chat-main">
    {error && <p className="pet-chat-error" role="alert">{error}</p>}
    <div className="pet-chat-log" ref={log} role="log" aria-label="与宠物的聊天记录" aria-live="polite"
      onScroll={event => {
        const element = event.currentTarget;
        followReply.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
      }}>
      {hasOlder && <button type="button" className="pet-chat-pill pet-chat-load-older" disabled={historyLoading} onClick={() => void loadOlder()}>{historyLoading ? "读取中…" : "查看更早的消息"}</button>}
      {!historyReady && !historyLoading && <button type="button" className="pet-chat-pill" onClick={() => setHistoryRetry(value => value + 1)}>重试读取聊天记录</button>}
      {!hasOlder && historyReady &&
      <div className="pet-chat-message assistant pet-chat-welcome">
        <p>你好，我是{petAppearances[appearance].label}。可以试试“查备忘录 项目交接”或“查资料”。</p>
        {loaded && !services.length && <button type="button" className="pet-chat-pill" onClick={() => onPageChange("general")}>设置聊天服务</button>}
      </div>}
      {messages.map(message => <div key={message.key} className={`pet-chat-message ${message.role}${message.failed ? " is-failed" : ""}`}>
        <span className="pet-chat-input-label">{message.role === "user" ? "你" : petAppearances[appearance].label}</span>
        {message.image && <img className="pet-chat-message-image" src={message.image} alt="本次消息附带的图片" />}
        {message.attachment && <details className="pet-chat-attachment"><summary>附件：{message.attachment.name}{attachmentIsMetadataOnly(message.attachment.text) ? " · 正文未解析" : ""}</summary><pre>{message.attachment.text}</pre></details>}
        <p data-pet-message-text>{message.text}</p>
        {message.role === "assistant" && <div className="pet-chat-message-meta"><small>{message.failed ? "请求失败" : message.local ? "本地查询" : "AI 生成"}</small>
          {!message.local && voice.enabled && voice.speak && !quiet && <button type="button" className="pet-chat-replay"
            data-speaking={speakingReplyKey === message.key || undefined} aria-label={speakingReplyKey === message.key ? "正在朗读这条回复" : "朗读这条回复"}
            title={speakingReplyKey === message.key ? "正在朗读这条回复" : "朗读这条回复"} onClick={() => replayReply(message.key, message.text)}><Volume2 size={15} aria-hidden="true" /></button>}
        </div>}
      </div>)}
      {showThinking && <div className="pet-chat-message assistant pet-chat-thinking" role="status">{compressionRetry === "response" ? "模型响应过大，正在精简对话并限制回复长度后重试…" : compressionRetry === "context" ? "上下文超过模型限制，正在精简较早对话并重试…" : harnessStatus || "模型正在思考…"}</div>}
      {pendingAction && <section className="pet-chat-message assistant pet-chat-tool-proposal" aria-label="待确认的本机操作">
        <strong>{pendingAction.summary || "本机操作待确认"}</strong>
        <p>原请求：{pendingAction.userText}</p>
        {pendingAction.kind === "shell" && <pre>{pendingAction.command}</pre>}
        {pendingAction.kind === "workbook" && <p>目标位置：桌面 · 新建空白 Excel（.xlsx）</p>}
        <p>90 秒内未确认会自动取消。执行结果会显示在本对话中。</p>
        <div className="pet-chat-tool-actions">
          <button type="button" className="secondary" disabled={actionExecuting} onClick={() => { setPendingAction(null); setTurns(current => [...current, { id: crypto.randomUUID(), user: "取消本机操作", reply: "已取消操作，没有执行。", local: true }]); }}>取消</button>
          <button type="button" className="primary" disabled={actionExecuting} onClick={() => { setText("确认"); void sendText("确认"); }}>{actionExecuting ? "执行中…" : "确认执行"}</button>
        </div>
      </section>}
    </div>
    {editingFile && <div className="pet-chat-image-editor"><AiImageEditor initialFile={editingFile} onCancel={() => { imageEpoch.current++; setEditingFile(null); }} onPrepared={prepared => { setImage(prepared); setEditingFile(null); input.current?.focus(); }} /></div>}
    <form className="pet-chat-composer" data-voice-active={voiceInputActive || undefined} data-listening={listening || undefined} onSubmit={e => { e.preventDefault(); submitComposer(); }}>
      {image && <div className="pet-chat-image-preview"><img src={image.dataUrl} alt="待发送的处理后图片" /><span>已准备图片<small>随本条消息发送</small></span><button type="button" aria-label="移除待发送图片" title="移除图片" disabled={busy} onClick={() => setImage(null)}><X size={14} /></button></div>}
      {attachment && <div className="pet-chat-attachment-preview"><Paperclip size={14} aria-hidden="true" /><span>{attachment.name}<small>{attachmentIsMetadataOnly(attachment.text) ? "正文未解析 · 仅发送文件信息" : `随本条消息发送 · ${attachment.text.length.toLocaleString()} 字`}</small></span><button type="button" aria-label="移除附件" title="移除附件" disabled={busy} onClick={() => setAttachment(null)}><X size={14} /></button></div>}
      <div className="pet-chat-composer-status">
        <div className="pet-chat-live-status" role="status" data-tone={liveStatus.tone} title={liveStatus.title}>
          <span className="pet-chat-status-dot" aria-hidden="true" />
          <span>{liveStatus.label}</span>
          {recording && <span aria-hidden="true">· {recordSeconds}s</span>}
        </div>
        <div className="pet-chat-status-actions">
          <label className="pet-chat-listening-toggle" title={!voice.enabled ? "请先在桌宠设置中启用语音对话" : "开关常驻麦克风监听和语音唤醒"}>
            <span>{savingWake ? "保存中…" : "实时监听"}</span>
            <input type="checkbox" role="switch" aria-label="实时监听" checked={wakeEnabled} disabled={!settingsReady || !voice.enabled || savingWake} onChange={() => void toggleWake()} />
          </label>
          <button type="button" className={`pet-chat-trace-toggle${settings.harnessTraceEnabled ? " is-active" : ""}`} aria-label="步骤面板" aria-pressed={!!settings.harnessTraceEnabled} title={settings.harnessTraceEnabled ? "关闭执行步骤面板" : "显示执行步骤面板"} disabled={!settingsReady} onClick={() => void toggleHarnessTrace()}><ListChecks size={15} aria-hidden="true" /><span>步骤</span></button>
        </div>
      </div>
      <label className="pet-chat-input-label" htmlFor="pet-chat-input">和宠物说句话</label><textarea id="pet-chat-input" ref={input} rows={2} maxLength={2000} disabled={busy || imageBusy || voiceInputActive} value={showingVoiceDraft ? voiceDraftText : text} onChange={e => { if (showingVoiceDraft) onVoiceDraftCancel(); if (!e.target.value.trim()) voiceDraft.current = null; setText(e.target.value); }} placeholder={voiceInputActive ? "" : "输入问题，也可拖入任意文件"} onPaste={e => { const file = Array.from(e.clipboardData.items).find(item => item.kind === "file")?.getAsFile(); if (file) { e.preventDefault(); if (file.type.startsWith("image/")) addImage(file); else void addDocumentFile(file); } }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submitComposer(); } }} />
      <div className="pet-chat-compose-tools">
        <button type="button" aria-label="添加文件" disabled={busy || imageBusy || voiceInputActive} title="添加图片或文档" onClick={() => fileInput.current?.click()}><Plus size={18} aria-hidden="true" /></button>
        <div className="pet-chat-access-control">
          <button type="button" className={`pet-chat-access-trigger${settings.agentAccessMode === "full" ? " is-full" : ""}`} aria-haspopup="menu" aria-expanded={accessMenuOpen} onClick={() => setAccessMenuOpen(value => !value)}>
            {settings.agentAccessMode === "full" ? <ShieldAlert size={13} aria-hidden="true" /> : null}{settings.agentAccessMode === "full" ? "完全访问" : "请求批准"}<ChevronDown size={12} aria-hidden="true" />
          </button>
          {accessMenuOpen && <div className="pet-chat-access-menu" role="menu" aria-label="本机操作权限">
            <p>本机操作权限</p>
            <button type="button" role="menuitemradio" aria-checked={settings.agentAccessMode !== "full"} onClick={() => void setAgentAccessMode("ask")}>
              <span><strong>请求批准</strong><small>每次执行本机操作前询问</small></span>{settings.agentAccessMode !== "full" && <Check size={14} aria-hidden="true" />}
            </button>
            <button type="button" role="menuitemradio" aria-checked={settings.agentAccessMode === "full"} onClick={() => void setAgentAccessMode("full")}>
              <span><strong>完全访问</strong><small>自动执行已接入的操作；高危命令仍会拦截</small></span>{settings.agentAccessMode === "full" && <Check size={14} aria-hidden="true" />}
            </button>
          </div>}
        </div>
        <button type="button" aria-label={hasWindowsSnipping ? "系统截图" : "粘贴截图"} disabled={busy || imageReading || voiceInputActive || (!hasWindowsSnipping && !visionReady)}
          title={hasWindowsSnipping ? "Windows 截图（Win+Shift+S），截完可用 Ctrl+V 粘贴" : "粘贴剪贴板里的图片"} onClick={captureScreenshot}><ScissorsLineDashed size={17} aria-hidden="true" /></button>
        <div className="pet-chat-compose-actions">
          <span className="pet-chat-context-length" aria-label={`当前上下文约 ${contextCharacters.toLocaleString()} 字`} title="按最近 9 轮对话、当前输入和角色提示词估算；图片不计入，字符数不等于模型 Token 数。">{contextCharacters.toLocaleString()} 字</span>
          {modelButton}
          {voice.enabled && <button type="button" className="pet-chat-voice" disabled={!recording && (busy || voiceInputActive || imageBusy || !voiceStatus)} title={voiceTitle} aria-label={recording ? "停止录音" : "语音输入"} onClick={() => void (recording ? stopRecording(false) : startRecording())}><Mic size={17} aria-hidden="true" /></button>}
          {busy && <button type="button" className="pet-chat-stop" aria-label="停止生成" title="停止生成" onClick={() => void stop()}><Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" /></button>}
          {!busy && hasDraft && !voiceInputActive && <button type="submit" className="pet-chat-send" aria-label="发送" title="Enter 发送 · Shift+Enter 换行" disabled={!historyReady || clearingHistory || imageBusy}><Send size={16} aria-hidden="true" /></button>}
        </div>
      </div>
      <input hidden ref={fileInput} type="file" accept="*/*" aria-label="选择聊天附件" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) { if (file.type.startsWith("image/")) addImage(file); else void addDocumentFile(file); } }} />
    </form>
    </div>
    {settings.harnessTraceEnabled && <section className="pet-chat-trace-panel" role="region" aria-label="本轮执行步骤" aria-live="polite">
      <header><strong><ListChecks size={15} aria-hidden="true" />执行步骤</strong><span>{busy ? "进行中" : "最近一轮"}</span></header>
      {traceTask && <p className="pet-chat-trace-task" title={traceTask}>{traceTask}</p>}
      <ol>{traceSteps.map(step => <li key={step.id} data-state={step.state}><span className="pet-chat-trace-marker" aria-hidden="true">{step.state === "completed" ? <Check size={12} /> : step.state === "failed" ? <X size={12} /> : <i />}</span><div><strong>{step.title}</strong>{step.detail && <small>{step.detail}</small>}</div></li>)}</ol>
      {!traceSteps.length && <p className="pet-chat-trace-empty">{busy ? "等待模型选择下一步操作…" : "发送指令后，这里会逐条显示工具操作。"}</p>}
      {traceResult && <section className="pet-chat-trace-result"><strong>{busy ? "当前状态" : traceResult.startsWith("执行失败：") ? "执行失败" : "最终结果"}</strong><p>{traceResult.slice(0, 500)}{traceResult.length > 500 ? "…" : ""}</p></section>}
    </section>}
    </div>
  </>;
}
