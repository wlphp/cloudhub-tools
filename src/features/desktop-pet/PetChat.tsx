import { PetPortrait } from "./PetPortrait";
import type { PetSettings, PetVoiceSettings, PetVoiceStatus } from "../../platform/clients/desktopPet";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Mic, Send, Square, Trash2, X, Image as ImageIcon } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { desktopPetClient as client, type PetChatMessage, type PetChatService } from "../../platform/clients/desktopPet";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import type { AiImage } from "../../platform/clients/ai";
import { AiImageEditor } from "../ai/AiImageEditor";

const RECORD_RATE = 16000;
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

interface RecordingSession {
  stream: MediaStream;
  context: AudioContext;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  chunks: Float32Array[];
  startedAt: number;
  timer: number;
}

export function PetChat({ appearance, voice, pendingVoice, onVoiceConsumed, onVoiceTranscript }: {
  appearance: PetSettings["appearance"];
  voice: PetVoiceSettings;
  pendingVoice: { text: string; autoSend: boolean } | null;
  onVoiceConsumed: () => void;
  onVoiceTranscript: (text: string) => void;
}) {
  const [services, setServices] = useState<PetChatService[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<PetChatMessage[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<AiImage | null>(null);
  const [editingFile, setEditingFile] = useState<File | null>(null);
  const [imageReading, setImageReading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<PetVoiceStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const imageEpoch = useRef(0);
  const request = useRef<string | null>(null);
  const mounted = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const session = useRef<RecordingSession | null>(null);
  const stopRef = useRef<(cancel?: boolean) => void>(() => {});
  const service = services.find(item => item.id === serviceId);
  const visionReady = !!service?.supportsImages;
  const imageBusy = !!editingFile || imageReading;
  function addImage(file: File) {
    if (busy) return;
    if (!visionReady) { setError("请先在 AI 设置中完成所选服务的图像能力测试。"); return; }
    imageEpoch.current++;
    setImageReading(false); setImage(null); setError(""); setEditingFile(file);
  }
  useEffect(() => {
    mounted.current = true;
    void client.chatServices().then(items => { if (mounted.current) { setServices(items); setServiceId(items[0]?.id || ""); setLoaded(true); input.current?.focus(); } }).catch(e => { if (mounted.current) { setError(platformErrorMessage(e)); setLoaded(true); } });
    return () => { mounted.current = false; imageEpoch.current++; if (request.current) void client.cancelChat(request.current).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!runningInTauri || !voice.enabled) return;
    let disposed = false;
    void client.voiceStatus().then(status => { if (!disposed) setVoiceStatus(status); }).catch(() => {});
    return () => { disposed = true; };
  }, [voice.enabled]);
  useEffect(() => {
    if (!recording) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); stopRef.current(true); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [recording]);
  useEffect(() => {
    if (!pendingVoice || !loaded) return;
    const { text: incoming, autoSend } = pendingVoice;
    onVoiceConsumed();
    if (autoSend) { void sendText(incoming); return; }
    setText(previous => previous ? `${previous}${previous.endsWith(" ") ? "" : " "}${incoming}` : incoming);
    input.current?.focus();
  }, [pendingVoice, loaded]);
  useEffect(() => {
    if (!runningInTauri) return;
    let disposed = false;
    const listener = getCurrentWebview().onDragDropEvent(event => {
      const payload = event.payload;
      if (payload.type === "leave") { setDropActive(false); return; }
      const bounds = root.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio, y = payload.position.y / window.devicePixelRatio;
      const inside = !!bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
      setDropActive(inside && payload.type !== "drop" && !busy && visionReady);
      if (payload.type !== "drop" || !inside || busy) return;
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
  }, [busy, visionReady, serviceId]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages, busy]);
  async function sendText(content: string) {
    if (!service || (!content.trim() && !image) || request.current || imageBusy) return;
    const sentImage = image;
    const conversation = [...messages.slice(-18), { role: "user" as const, text: content.trim() || "请看看这张图片。", ...(sentImage ? { image: sentImage.dataUrl } : {}) }];
    const id = crypto.randomUUID(); request.current = id;
    setMessages(conversation); setText(""); setImage(null); setError(""); setBusy(true);
    try {
      const reply = await client.chat(id, service, conversation, sentImage || undefined);
      if (mounted.current && request.current === id) setMessages([...conversation, { role: "assistant", text: reply }]);
    } catch (e) {
      if (mounted.current && request.current === id) { setMessages(conversation.slice(0, -1)); setText(conversation[conversation.length - 1].text); setImage(sentImage); setError(platformErrorMessage(e)); }
    } finally {
      if (mounted.current && request.current === id) { request.current = null; setBusy(false); input.current?.focus(); }
    }
  }
  async function startRecording() {
    if (session.current || busy || imageBusy) return;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined" || !AudioContext.prototype.createScriptProcessor) { setError("当前环境不支持麦克风录音。"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      const transcript = (await client.voiceTranscribe(pcmToBase64(pcm))).trim();
      if (!mounted.current) return;
      if (!transcript) { setError("未识别到语音内容，请靠近麦克风再试一次"); return; }
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
    try { await client.cancelChat(id); } catch (e) { if (mounted.current) setError(platformErrorMessage(e)); }
  }
  const voiceTitle = !voice.enabled ? "语音对话未启用，可在宠物设置中开启"
    : !voiceStatus ? "正在检查语音模型…"
    : !voiceStatus.ready ? `尚未放置语音模型，请先在宠物设置中配置（模型文件夹：${voiceStatus.modelsDir}）`
    : recording ? "停止录音并识别" : "语音输入，点击开始说话";
  return <div ref={root} className={`pet-chat${dropActive ? " is-image-drag-over" : ""}`} onDragOver={e => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDropActive(!busy && visionReady); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false); }} onDrop={e => { const files = Array.from(e.dataTransfer.files); if (!files.length) return; e.preventDefault(); setDropActive(false); if (files.length !== 1) { setError("请一次拖入一张图片。"); return; } addImage(files[0]); }}>
    <div className="pet-chat-service"><label><span className="pet-chat-service-dot" aria-hidden="true" />聊天服务<select aria-label="聊天使用的AI服务" disabled={busy || !services.length} value={serviceId} onChange={e => { imageEpoch.current++; setServiceId(e.target.value); setMessages([]); setImage(null); setEditingFile(null); setImageReading(false); setError(""); }}>
      {!services.length && <option value="">{loaded ? "尚未配置" : "读取中…"}</option>}{services.map(service => <option key={service.id} value={service.id}>{service.name} · {service.model}</option>)}
    </select></label>{visionReady && <span className="pet-chat-vision"><ImageIcon size={12} />可识图</span>}<button title="清空对话" aria-label="清空对话" disabled={busy || !messages.length || imageBusy} onClick={() => { setMessages([]); setError(""); }}><Trash2 size={14} /></button></div>
    <div className="pet-chat-log" ref={log} role="log" aria-label="与宠物的聊天记录" aria-live="polite">
      {!messages.length && <div className="pet-chat-welcome"><PetPortrait appearance={appearance} pose="happy" className="pet-chat-welcome-avatar" /><strong>今天想聊点什么？</strong><p>聊聊日常，或发张图一起看看。</p>{loaded && !services.length && <button onClick={() => void client.open("settings").catch(e => setError(platformErrorMessage(e)))}>去设置 AI 服务</button>}</div>}
      {messages.map((message, i) => <div key={i} className={`pet-chat-message ${message.role}`}><small>{message.role === "assistant" && <PetPortrait appearance={appearance} className="pet-chat-avatar" />}{message.role === "user" ? "你" : "宠物"}</small>{message.image && <img className="pet-chat-message-image" src={message.image} alt="本次消息附带的图片" />}<p>{message.text}</p></div>)}
      {busy && <p className="pet-chat-thinking" role="status">正在想…</p>}
    </div>
    {editingFile && <div className="pet-chat-image-editor"><AiImageEditor initialFile={editingFile} onCancel={() => { imageEpoch.current++; setEditingFile(null); }} onPrepared={prepared => { setImage(prepared); setEditingFile(null); input.current?.focus(); }} /></div>}
    {imageReading && <p className="pet-chat-thinking" role="status">正在读取图片…</p>}
    {recording && <p className="pet-chat-recording" role="status"><Mic size={13} aria-hidden="true" />正在聆听… {recordSeconds}s · 说完点“停止”，Esc 取消，最长 {voice.maxSeconds} 秒</p>}
    {transcribing && <p className="pet-chat-thinking" role="status">正在识别语音…</p>}
    {error && <p className="pet-chat-error" role="alert">{error}</p>}
    <form className="pet-chat-composer" onSubmit={e => { e.preventDefault(); void sendText(text); }}>
      {image && <div className="pet-chat-image-preview"><img src={image.dataUrl} alt="待发送的处理后图片" /><span>已准备图片<small>随本条消息发送</small></span><button type="button" aria-label="移除待发送图片" title="移除图片" disabled={busy} onClick={() => setImage(null)}><X size={14} /></button></div>}
      <label className="pet-chat-input-label" htmlFor="pet-chat-input">和宠物说句话</label><textarea id="pet-chat-input" ref={input} rows={2} maxLength={2000} disabled={busy || !serviceId || imageBusy || recording} value={text} onChange={e => setText(e.target.value)} placeholder={visionReady ? "说点什么，或粘贴一张图片…" : "说点什么…"} onPaste={e => { const file = Array.from(e.clipboardData.items).find(item => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile(); if (file) { e.preventDefault(); addImage(file); } }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendText(text); } }} />
      <div className="pet-chat-compose-tools">{voice.enabled && <button type="button" className={`pet-chat-voice${recording ? " is-recording" : ""}`} disabled={busy || transcribing || imageBusy || !voiceStatus} title={voiceTitle} aria-label={recording ? "停止录音" : "语音输入"} onClick={() => void (recording ? stopRecording(false) : startRecording())}>{recording ? <Square size={12} /> : <Mic size={16} />}{recording ? `停止 ${recordSeconds}s` : "语音"}</button>}<button type="button" className="pet-chat-add-image" disabled={busy || !visionReady || imageReading} title={visionReady ? "选择图片，也可粘贴或拖入 PNG / JPEG" : "请先在 AI 设置中完成图像能力测试"} onClick={() => fileInput.current?.click()}><ImagePlus size={16} />图片</button><small>Enter 发送 · Shift+Enter 换行</small>{busy ? <button type="button" className="primary pet-chat-send" onClick={e => { e.preventDefault(); void stop(); }}><Square size={12} />停止</button> : <button type="submit" className="primary pet-chat-send" disabled={(!text.trim() && !image) || !serviceId || imageBusy}><Send size={13} />发送</button>}</div>
      <input hidden ref={fileInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label="选择聊天图片" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) addImage(file); }} />
    </form>
    <div className="pet-chat-footer">仅发送本次对话和确认的图片{loaded && service && !visionReady && <button onClick={() => void client.open("settings").catch(e => setError(platformErrorMessage(e)))}>启用识图</button>}</div>
  </div>;
}
