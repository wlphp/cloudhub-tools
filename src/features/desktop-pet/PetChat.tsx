import { useEffect, useRef, useState } from "react";
import { ImagePlus, Send, Square, Trash2, X, Image as ImageIcon } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { desktopPetClient as client, type PetChatMessage, type PetChatService } from "../../platform/clients/desktopPet";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import type { AiImage } from "../../platform/clients/ai";
import { AiImageEditor } from "../ai/AiImageEditor";

export function PetChat() {
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
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const imageEpoch = useRef(0);
  const request = useRef<string | null>(null);
  const mounted = useRef(true);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
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
  async function send() {
    if (!service || (!text.trim() && !image) || request.current || imageBusy) return;
    const sentImage = image;
    const conversation = [...messages.slice(-18), { role: "user" as const, text: text.trim() || "请看看这张图片。", ...(sentImage ? { image: sentImage.dataUrl } : {}) }];
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
  async function stop() {
    const id = request.current;
    if (!id) return;
    try { await client.cancelChat(id); } catch (e) { if (mounted.current) setError(platformErrorMessage(e)); }
  }
  return <div ref={root} className={`pet-chat${dropActive ? " is-image-drag-over" : ""}`} onDragOver={e => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDropActive(!busy && visionReady); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false); }} onDrop={e => { const files = Array.from(e.dataTransfer.files); if (!files.length) return; e.preventDefault(); setDropActive(false); if (files.length !== 1) { setError("请一次拖入一张图片。"); return; } addImage(files[0]); }}>
    <div className="pet-chat-service"><label><span className="pet-chat-service-dot" aria-hidden="true" />聊天服务<select aria-label="聊天使用的AI服务" disabled={busy || !services.length} value={serviceId} onChange={e => { imageEpoch.current++; setServiceId(e.target.value); setMessages([]); setImage(null); setEditingFile(null); setImageReading(false); setError(""); }}>
      {!services.length && <option value="">{loaded ? "尚未配置" : "读取中…"}</option>}{services.map(service => <option key={service.id} value={service.id}>{service.name} · {service.model}</option>)}
    </select></label>{visionReady && <span className="pet-chat-vision"><ImageIcon size={12} />可识图</span>}<button title="清空对话" aria-label="清空对话" disabled={busy || !messages.length || imageBusy} onClick={() => { setMessages([]); setError(""); }}><Trash2 size={14} /></button></div>
    <div className="pet-chat-log" ref={log} role="log" aria-label="与宠物的聊天记录" aria-live="polite">
      {!messages.length && <div className="pet-chat-welcome"><span className="pet-chat-welcome-avatar" aria-hidden="true" /><strong>今天想聊点什么？</strong><p>聊聊日常，或发张图一起看看。</p>{loaded && !services.length && <button onClick={() => void client.open("settings").catch(e => setError(platformErrorMessage(e)))}>去设置 AI 服务</button>}</div>}
      {messages.map((message, i) => <div key={i} className={`pet-chat-message ${message.role}`}><small>{message.role === "assistant" && <span className="pet-chat-avatar" aria-hidden="true" />}{message.role === "user" ? "你" : "宠物"}</small>{message.image && <img className="pet-chat-message-image" src={message.image} alt="本次消息附带的图片" />}<p>{message.text}</p></div>)}
      {busy && <p className="pet-chat-thinking" role="status">正在想…</p>}
    </div>
    {editingFile && <div className="pet-chat-image-editor"><AiImageEditor initialFile={editingFile} onCancel={() => { imageEpoch.current++; setEditingFile(null); }} onPrepared={prepared => { setImage(prepared); setEditingFile(null); input.current?.focus(); }} /></div>}
    {imageReading && <p className="pet-chat-thinking" role="status">正在读取图片…</p>}
    {error && <p className="pet-chat-error" role="alert">{error}</p>}
    <form className="pet-chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      {image && <div className="pet-chat-image-preview"><img src={image.dataUrl} alt="待发送的处理后图片" /><span>已准备图片<small>随本条消息发送</small></span><button type="button" aria-label="移除待发送图片" title="移除图片" disabled={busy} onClick={() => setImage(null)}><X size={14} /></button></div>}
      <label className="pet-chat-input-label" htmlFor="pet-chat-input">和宠物说句话</label><textarea id="pet-chat-input" ref={input} rows={2} maxLength={2000} disabled={busy || !serviceId || imageBusy} value={text} onChange={e => setText(e.target.value)} placeholder={visionReady ? "说点什么，或粘贴一张图片…" : "说点什么…"} onPaste={e => { const file = Array.from(e.clipboardData.items).find(item => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile(); if (file) { e.preventDefault(); addImage(file); } }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div className="pet-chat-compose-tools"><button type="button" className="pet-chat-add-image" disabled={busy || !visionReady || imageReading} title={visionReady ? "选择图片，也可粘贴或拖入 PNG / JPEG" : "请先在 AI 设置中完成图像能力测试"} onClick={() => fileInput.current?.click()}><ImagePlus size={16} />图片</button><small>Enter 发送 · Shift+Enter 换行</small>{busy ? <button type="button" className="pet-chat-send" onClick={e => { e.preventDefault(); void stop(); }}><Square size={12} />停止</button> : <button type="submit" className="pet-chat-send" disabled={(!text.trim() && !image) || !serviceId || imageBusy}><Send size={13} />发送</button>}</div>
      <input hidden ref={fileInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label="选择聊天图片" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) addImage(file); }} />
    </form>
    <div className="pet-chat-footer">仅发送本次对话和确认的图片{loaded && service && !visionReady && <button onClick={() => void client.open("settings").catch(e => setError(platformErrorMessage(e)))}>启用识图</button>}</div>
  </div>;
}
