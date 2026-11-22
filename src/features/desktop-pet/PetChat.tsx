import type { PetSettings, PetSpeechPreset, PetVoiceStatus } from "../../platform/clients/desktopPet";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Mic, Paperclip, ScissorsLineDashed, Send, Square, Volume2, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { desktopPetClient as client, type PetChatMessage, type PetChatService, type PetChatTurn } from "../../platform/clients/desktopPet";
import { platformErrorMessage, runningInTauri, runningOnWindows } from "../../platform/api";
import type { AiImage } from "../../platform/clients/ai";
import { AiImageEditor } from "../ai/AiImageEditor";
import { petAppearances } from "./appearances";
import { PetChatSettings, type PetChatPage } from "./PetChatSettings";

const RECORD_RATE = 16000;
const hasWindowsSnipping = runningInTauri && runningOnWindows;
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

/// 从累积文本中切出完整句子（中英文句读与换行，连续终止符并入同句）；返回句子与剩余未完部分。
function takeSentences(buffer: string) {
  const sentences: string[] = [];
  let end = 0;
  for (let index = 0; index < buffer.length; index++) {
    if ("。！？!?；;\n".includes(buffer[index])) {
      let stop = index + 1;
      while (stop < buffer.length && "。！？!?；;\n".includes(buffer[stop])) stop++;
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

export interface PetVoiceTurn {
  text: string;
  autoSend: boolean;
  commandId?: number;
  localReply?: string | null;
}

export type { PetChatPage } from "./PetChatSettings";

export function PetChat({ settings, settingsReady, onSettingsSave, page, onPageChange, skillsActions, alerts, visible, historyVersion, clearingHistory, pendingVoice, voiceActivity, onVoiceConsumed, onVoiceTranscript, onSpeakSentence, onInterruptSpeech, onVoiceReplyDone, onVoiceError, onReplay, onVoicePreview }: {
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
  /** 逐句播报一句回复；done 在该句播完（或不可用）后调用，用于串行化句子顺序。 */
  onSpeakSentence: (text: string, done: () => void) => void;
  /** 打断当前语音播报：清空队列外，由上层停止系统语音与 Rust 侧播放。 */
  onInterruptSpeech: () => void;
  /** 本轮全部句子播报完成后回调，用于刷新语音追问窗口。 */
  onVoiceReplyDone: (commandId?: number) => void;
  onVoiceError: (message: string) => void;
  onReplay: (reply: string) => void;
  onVoicePreview: (preset: PetSpeechPreset) => Promise<void>;
}) {
  const { appearance, voice, quiet } = settings;
  const chatVisible = visible && page === "chat";
  const [services, setServices] = useState<PetChatService[]>([]);
  const [serviceId, setServiceId] = useState("");
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
  const [editingFile, setEditingFile] = useState<File | null>(null);
  const [imageReading, setImageReading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<PetVoiceStatus | null>(null);
  const [requestingMic, setRequestingMic] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const imageEpoch = useRef(0);
  const request = useRef<string | null>(null);
  const lookupRequest = useRef<string | null>(null);
  const voiceDraft = useRef<PetVoiceTurn | null>(null);
  /// 流式回复的渐进显示与逐句播报队列：句子按到达顺序串行播报，全部播完后刷新追问窗口。
  const [streamedReply, setStreamedReply] = useState("");
  const speakBuffer = useRef("");
  const speakQueue = useRef<{ pending: string[]; busy: boolean; finished: (() => void) | null }>({ pending: [], busy: false, finished: null });
  const speakHandlers = useRef({ speak: onSpeakSentence, interrupt: onInterruptSpeech });
  speakHandlers.current = { speak: onSpeakSentence, interrupt: onInterruptSpeech };
  const visibleRef = useRef(chatVisible);
  visibleRef.current = chatVisible;
  const mounted = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const prependScroll = useRef<{ height: number; top: number } | null>(null);
  const historyRead = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const session = useRef<RecordingSession | null>(null);
  const stopRef = useRef<(cancel?: boolean) => void>(() => {});
  const service = services.find(item => item.id === serviceId);
  const visionReady = !!service?.supportsImages;
  const imageBusy = !!editingFile || imageReading;
  const voiceInputActive = requestingMic || recording || transcribing;
  const historyReady = loadedHistoryVersion === historyVersion;
  function addImage(file: File) {
    if (busy || voiceInputActive) return;
    if (!visionReady) { setError("请先在 AI 设置中完成所选服务的图像能力测试。"); return; }
    imageEpoch.current++;
    setImageReading(false); setImage(null); setError(""); setEditingFile(file);
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
  }, [visible]);
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
  }, [pendingVoice, loaded, historyReady, clearingHistory, busy, recording, transcribing, service]);
  useEffect(() => {
    if (!runningInTauri || !visible) return;
    let disposed = false;
    const listener = getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload;
      if (payload.type === "leave") { setDropActive(false); return; }
      const bounds = root.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio, y = payload.position.y / window.devicePixelRatio;
      const inside = visibleRef.current && !!bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
      setDropActive(inside && payload.type !== "drop" && !busy && !voiceInputActive && visionReady);
      if (payload.type !== "drop" || !inside || busy || voiceInputActive) return;
      if (payload.paths.length !== 1) { setError("请一次拖入一张图片。"); return; }
      if (!visionReady) { setError("请先在 AI 设置中完成所选服务的图像能力测试。"); return; }
      const epoch = ++imageEpoch.current;
      setImageReading(true); setImage(null); setEditingFile(null); setError("");
      void client.readChatImage(payload.paths[0]).then(async dataUrl => {
        const blob = await (await fetch(dataUrl)).blob();
        if (!disposed && mounted.current && epoch === imageEpoch.current) addImage(new File([blob], "dropped-image", { type: blob.type }));
      }).catch(e => { if (!disposed && mounted.current && epoch === imageEpoch.current) setError(platformErrorMessage(e)); })
        .finally(() => { if (!disposed && mounted.current && epoch === imageEpoch.current) setImageReading(false); });
    });
    return () => { disposed = true; void listener.then(unlisten => unlisten()); };
  }, [visible, busy, voiceInputActive, visionReady, serviceId]);
  useLayoutEffect(() => {
    if (!chatVisible || !log.current) return;
    const previous = prependScroll.current;
    prependScroll.current = null;
    log.current.scrollTop = previous ? previous.top + log.current.scrollHeight - previous.height : log.current.scrollHeight;
  }, [chatVisible, turns, busy]);
  /// 播报队列串行出队；队列清空时触发 finished（本轮全部句子播完）。
  function drainSpeakQueue() {
    const queue = speakQueue.current;
    if (queue.busy) return;
    const sentence = queue.pending.shift();
    if (!sentence) {
      if (queue.finished) { const finished = queue.finished; queue.finished = null; finished(); }
      return;
    }
    queue.busy = true;
    speakHandlers.current.speak(sentence, () => { queue.busy = false; drainSpeakQueue(); });
  }
  function enqueueSpeak(sentences: string[]) {
    if (!sentences.length) return;
    speakQueue.current.pending.push(...sentences);
    drainSpeakQueue();
  }
  /// 丢弃未播句子并打断当前句：新一轮语音回复或请求失败时调用。
  function stopSpeakQueue() {
    speakQueue.current = { pending: [], busy: false, finished: null };
    speakHandlers.current.interrupt();
  }
  async function sendText(content: string, voiceTurn = voiceDraft.current) {
    const background = voiceTurn?.autoSend === true;
    const sentImage = background ? null : image;
    if (!historyReady || clearingHistory || (!content.trim() && !sentImage) || request.current || (!background && imageBusy)) return;
    const userMessage = { role: "user" as const, text: content.trim() || "请看看这张图片。", ...(sentImage ? { image: sentImage.dataUrl } : {}) };
    const id = crypto.randomUUID(); request.current = id;
    lookupRequest.current = id;
    if (!background) { voiceDraft.current = null; setText(""); setImage(null); }
    setPendingMessage(userMessage); setError(""); setBusy(true); setStreamedReply("");
    speakBuffer.current = "";
    speakQueue.current = { pending: [], busy: false, finished: null };
    // 新一轮语音回复开始前打断上一轮残留播报，避免新旧声音叠加。
    if (background) speakHandlers.current.interrupt();
    try {
      const localReply = voiceTurn?.localReply === undefined
        ? await client.chatLookup(userMessage.text, !!sentImage)
        : voiceTurn.localReply;
      if (!mounted.current || request.current !== id) return;
      lookupRequest.current = null;
      if (localReply !== null) {
        if (visibleRef.current) setTurns(current => [...current, { id, user: userMessage.text, reply: localReply, local: true }]);
        return;
      }
      if (!service) throw new Error("请先在 AI 设置中配置聊天服务，或输入“查资料”查看本地查询用法。");
      const turn = await client.chatStream(id, service, userMessage.text, delta => {
        if (!mounted.current || request.current !== id) return;
        speakBuffer.current += delta;
        setStreamedReply(previous => previous + delta);
        const { sentences, rest } = takeSentences(speakBuffer.current);
        if (sentences.length) {
          speakBuffer.current = rest;
          enqueueSpeak(sentences);
        }
      }, sentImage || undefined);
      if (mounted.current && request.current === id) {
        setTurns(current => [...current, turn]);
        if (voiceTurn) {
          // 流结束：最后一段未完句入队，全部句子播完后刷新语音追问窗口。
          speakQueue.current.finished = () => onVoiceReplyDone(voiceTurn.commandId);
          const tail = speakBuffer.current.trim();
          speakBuffer.current = "";
          if (tail) enqueueSpeak([tail]);
          else drainSpeakQueue();
        }
      }
    } catch (e) {
      if (mounted.current && request.current === id) {
        if (!background) { voiceDraft.current = voiceTurn; setText(userMessage.text); setImage(sentImage); }
        const message = platformErrorMessage(e);
        setError(message);
        if (background && !visibleRef.current) onVoiceError(message);
        if (background) stopSpeakQueue();
        setStreamedReply("");
      }
    } finally {
      if (lookupRequest.current === id) lookupRequest.current = null;
      if (mounted.current && request.current === id) { request.current = null; setPendingMessage(null); setBusy(false); setStreamedReply(""); if (visibleRef.current) input.current?.focus(); }
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
    if (lookupRequest.current === id) {
      lookupRequest.current = null;
      request.current = null;
      setPendingMessage(null);
      setBusy(false);
      return;
    }
    try { await client.cancelChat(id); } catch (e) { if (mounted.current) setError(platformErrorMessage(e)); }
  }
  const hasDraft = !!(text.trim() || image);
  const liveStatus = requestingMic ? { label: "正在打开麦克风", tone: "active" }
    : recording ? { label: "录音中", tone: "listening" }
    : transcribing ? { label: "识别中", tone: "active" }
    : busy ? { label: "回复中", tone: "active" }
    : voiceActivity.processing ? { label: "理解指令中", tone: "active" }
    : voiceActivity.playing ? { label: "播报中", tone: "active" }
    : voiceActivity.recognizing ? { label: "识别中", tone: "active" }
    : imageReading ? { label: "读取图片中", tone: "active" }
    : voiceActivity.listeningError && voice.enabled && voice.wakeEnabled ? { label: "监听异常", tone: "error", title: voiceActivity.listeningError }
    : voiceActivity.listening && voice.enabled && voice.wakeEnabled ? { label: "监听中", tone: "listening", title: `等待唤醒词“${voice.wakeWord}”` }
    : { label: "待命", tone: "idle" };
  const voiceTitle = !voice.enabled ? "语音对话未启用，可在宠物设置中开启"
    : !voiceStatus ? "正在检查语音模型…"
    : !voiceStatus.ready ? `尚未放置语音模型，请先在宠物设置中配置（模型文件夹：${voiceStatus.modelsDir}）`
    : recording ? "停止录音并识别" : "语音输入，点击开始说话";
  const serviceControls = <div className="pet-chat-service">
    <label><span className="pet-chat-input-label">聊天使用的 AI 服务</span>
      <select disabled={busy || !services.length} value={serviceId} onChange={e => { imageEpoch.current++; setServiceId(e.target.value); setImage(null); setEditingFile(null); setImageReading(false); setError(""); }}>
        {!services.length && <option value="">{loaded ? "尚未配置" : "读取中…"}</option>}
        {services.map(service => <option key={service.id} value={service.id}>{service.name} · {service.model}</option>)}
      </select>
    </label>
  </div>;
  const messages = turns.flatMap<PetChatMessage & { key: string; local?: boolean }>(turn => [
    { key: `${turn.id}-user`, role: "user", text: turn.user, image: turn.image },
    { key: `${turn.id}-assistant`, role: "assistant", text: turn.reply, local: turn.local },
  ]);
  if (pendingMessage) {
    messages.push({ key: "pending", ...pendingMessage });
    if (streamedReply) messages.push({ key: "pending-reply", role: "assistant", text: streamedReply });
  }
  return <>
    {page !== "chat" && <PetChatSettings page={page} onPageChange={onPageChange} settings={settings} ready={settingsReady} serviceControls={serviceControls} skillsActions={skillsActions} alerts={alerts}
      supportsImages={visionReady} canTry={!!service && !busy && !imageBusy && !recording}
      onSave={onSettingsSave} onVoicePreview={onVoicePreview} onTry={prompt => { voiceDraft.current = null; setText(previous => previous.trim() ? `${previous}\n${prompt}` : prompt); onPageChange("chat"); }} />}
    <div hidden={page !== "chat"} ref={root} className={`pet-chat${dropActive ? " is-image-drag-over" : ""}`} onDragOver={e => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDropActive(!busy && !voiceInputActive && visionReady); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false); }} onDrop={e => { const files = Array.from(e.dataTransfer.files); if (!files.length) return; e.preventDefault(); setDropActive(false); if (busy || voiceInputActive) return; if (files.length !== 1) { setError("请一次拖入一张图片。"); return; } addImage(files[0]); }}>
    {error && <p className="pet-chat-error" role="alert">{error}</p>}
    <div className="pet-chat-log" ref={log} role="log" aria-label="与宠物的聊天记录" aria-live="polite">
      {hasOlder && <button type="button" className="pet-chat-pill pet-chat-load-older" disabled={historyLoading} onClick={() => void loadOlder()}>{historyLoading ? "读取中…" : "查看更早的消息"}</button>}
      {!historyReady && !historyLoading && <button type="button" className="pet-chat-pill" onClick={() => setHistoryRetry(value => value + 1)}>重试读取聊天记录</button>}
      {!hasOlder && historyReady &&
      <div className="pet-chat-message assistant pet-chat-welcome">
        <p>你好，我是{petAppearances[appearance].label}。可以试试“查备忘录 项目交接”或“查资料”。</p>
        {loaded && !services.length && <button type="button" className="pet-chat-pill" onClick={() => onPageChange("general")}>设置聊天服务</button>}
      </div>}
      {messages.map(message => <div key={message.key} className={`pet-chat-message ${message.role}`}>
        <span className="pet-chat-input-label">{message.role === "user" ? "你" : petAppearances[appearance].label}</span>
        {message.image && <img className="pet-chat-message-image" src={message.image} alt="本次消息附带的图片" />}
        <p>{message.text}</p>
        {message.role === "assistant" && <div className="pet-chat-message-meta"><small>{message.local ? "本地查询" : "AI 生成"}</small>
          {!message.local && voice.enabled && voice.speak && !quiet && <button type="button" aria-label="朗读这条回复" title="朗读这条回复" onClick={() => onReplay(message.text)}><Volume2 size={15} aria-hidden="true" /></button>}
        </div>}
      </div>)}
    </div>
    {editingFile && <div className="pet-chat-image-editor"><AiImageEditor initialFile={editingFile} onCancel={() => { imageEpoch.current++; setEditingFile(null); }} onPrepared={prepared => { setImage(prepared); setEditingFile(null); input.current?.focus(); }} /></div>}
    <form className="pet-chat-composer" data-voice-active={voiceInputActive || undefined} onSubmit={e => { e.preventDefault(); if (!voiceInputActive) void sendText(text); }}>
      {image && <div className="pet-chat-image-preview"><img src={image.dataUrl} alt="待发送的处理后图片" /><span>已准备图片<small>随本条消息发送</small></span><button type="button" aria-label="移除待发送图片" title="移除图片" disabled={busy} onClick={() => setImage(null)}><X size={14} /></button></div>}
      <div className="pet-chat-live-status" role="status" data-tone={liveStatus.tone} title={liveStatus.title}>
        <span className="pet-chat-status-dot" aria-hidden="true" />
        <span>{liveStatus.label}</span>
        {recording && <span aria-hidden="true">· {recordSeconds}s</span>}
      </div>
      <label className="pet-chat-input-label" htmlFor="pet-chat-input">和宠物说句话</label><textarea id="pet-chat-input" ref={input} rows={2} maxLength={2000} disabled={busy || imageBusy || voiceInputActive} value={text} onChange={e => { if (!e.target.value.trim()) voiceDraft.current = null; setText(e.target.value); }} placeholder={voiceInputActive ? "" : visionReady ? "输入问题或直接发送图片" : "输入你想问的问题"} onPaste={e => { const file = Array.from(e.clipboardData.items).find(item => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile(); if (file) { e.preventDefault(); addImage(file); } }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendText(text); } }} />
      <div className="pet-chat-compose-tools">
        <button type="button" aria-label={visionReady ? "添加图片" : "设置图片识别"} disabled={busy || imageReading || voiceInputActive} title={visionReady ? "选择图片，也可粘贴或拖入 PNG / JPEG" : "在 AI 设置中启用图片识别"} onClick={() => {
          if (visionReady) fileInput.current?.click();
          else void client.open("settings").catch(e => setError(platformErrorMessage(e)));
        }}><Paperclip size={17} aria-hidden="true" /></button>
        <button type="button" aria-label={hasWindowsSnipping ? "系统截图" : "粘贴截图"} disabled={busy || imageReading || voiceInputActive || (!hasWindowsSnipping && !visionReady)}
          title={hasWindowsSnipping ? "Windows 截图（Win+Shift+S），截完可用 Ctrl+V 粘贴" : "粘贴剪贴板里的图片"} onClick={captureScreenshot}><ScissorsLineDashed size={17} aria-hidden="true" /></button>
        <div className="pet-chat-compose-actions">
          {busy && <button type="button" className="pet-chat-send" aria-label="停止生成" title="停止生成" onClick={() => void stop()}><Square size={14} aria-hidden="true" /></button>}
          {!busy && hasDraft && !voiceInputActive && <button type="submit" className="pet-chat-send" aria-label="发送" title="Enter 发送 · Shift+Enter 换行" disabled={!historyReady || clearingHistory || imageBusy}><Send size={16} aria-hidden="true" /></button>}
          {voice.enabled && <button type="button" className="pet-chat-voice" disabled={!recording && (busy || voiceInputActive || imageBusy || !voiceStatus)} title={voiceTitle} aria-label={recording ? "停止录音" : "语音输入"} onClick={() => void (recording ? stopRecording(false) : startRecording())}><Mic size={17} aria-hidden="true" /></button>}
        </div>
      </div>
      <input hidden ref={fileInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label="选择聊天图片" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) addImage(file); }} />
    </form>
    </div>
  </>;
}
