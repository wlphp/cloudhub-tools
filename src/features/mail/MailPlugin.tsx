import { useEffect, useRef, useState } from "react";
import { Copy, Download, Inbox, Mail, Paperclip, Pencil, Plus, RefreshCw, Reply, Search, Send, Settings, Trash2 } from "lucide-react";
import { runningInTauri } from "../../platform/api";
import { mailClient, type MailAccount, type MailDraft, type MailListing, type MailMessage, type MailSummary } from "../../platform/clients/mail";
import { SharedDialog } from "../../shared/SharedDialog";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SecretField } from "../../shared/SecretField";
import { extractVerificationCode } from "./verificationCode";
import "./mail.css";

const presets = [
  { name: "QQ / Foxmail", imap: "imap.qq.com", smtp: "smtp.qq.com", port: 465, security: "tls" },
  { name: "网易 163", imap: "imap.163.com", smtp: "smtp.163.com", port: 465, security: "tls" },
  { name: "网易 126", imap: "imap.126.com", smtp: "smtp.126.com", port: 465, security: "tls" },
  { name: "网易 yeah.net", imap: "imap.yeah.net", smtp: "smtp.yeah.net", port: 465, security: "tls" },
  { name: "腾讯企业邮箱", imap: "imap.exmail.qq.com", smtp: "smtp.exmail.qq.com", port: 465, security: "tls" },
  { name: "阿里企业邮箱", imap: "imap.qiye.aliyun.com", smtp: "smtp.qiye.aliyun.com", port: 465, security: "tls" },
  { name: "iCloud", imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", port: 587, security: "starttls" },
  { name: "自定义 IMAP / SMTP", imap: "", smtp: "", port: 465, security: "tls" },
];
const emptyAccount: MailAccount = { id: "", name: "", email: "", username: "", imapHost: "imap.qq.com", imapPort: 993, smtpHost: "smtp.qq.com", smtpPort: 465, smtpSecurity: "tls" };
const emptyDraft = (): MailDraft => ({ to: "", subject: "", body: "", attachments: [] });
const errorText = (e: unknown) => e instanceof Error ? e.message : "操作失败，请重试";
const sizeText = (size: number) => size < 1024 ? size + " B" : size < 1048576 ? (size / 1024).toFixed(1) + " KiB" : (size / 1048576).toFixed(1) + " MiB";
const folderName = (name: string) => {
 const known = { INBOX: "收件箱", Sent: "已发送", Drafts: "草稿箱", Trash: "垃圾箱", Junk: "垃圾邮件", Spam: "垃圾邮件" }[name];
 if (known) return known;
 // IMAP mailbox names use modified UTF-7; keep the original value for commands.
 return name.replace(/&([A-Za-z0-9+,]*)-/g, (original, encoded: string) => {
  if (!encoded) return "&";
  try { const bytes = atob(encoded.replace(/,/g, "/") + "=".repeat((4 - encoded.length % 4) % 4)); if (bytes.length % 2) return original; let text = ""; for (let i = 0; i < bytes.length; i += 2) text += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1)); return text; } catch { return original; }
 });
};

function AccountEditor({ account, onClose, onSaved }: { account: MailAccount; onClose: () => void; onSaved: (a: MailAccount) => void }) {
 const [value, setValue] = useState(account);
 const [password, setPassword] = useState("");
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState("");
 const locked = useRef(false);
 const field = <K extends keyof MailAccount>(key: K, next: MailAccount[K]) => setValue(v => ({ ...v, [key]: next }));
 return <SharedDialog title={account.id ? "编辑邮箱" : "添加邮箱"} icon={<Mail size={18} />} className="mail-account-dialog" busy={busy} closeDisabled={busy} onClose={onClose} onSubmit={async e => {
   e.preventDefault(); if (locked.current) return; locked.current = true; setBusy(true); setError("");
   try { const result = await mailClient.save({ ...value, name: value.name.trim() || value.email, username: value.username.trim() || value.email, password }); setPassword(""); onSaved(result); } catch (e) { setError(errorText(e)); } finally { locked.current = false; setBusy(false); }
 }} footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !runningInTauri}>{busy ? "正在保存…" : "保存邮箱"}</button></>}>
  <fieldset className="mail-form" disabled={busy}>
   <label>邮箱服务商<select defaultValue={account.id ? "custom" : "0"} onChange={e => { const p = presets[Number(e.target.value)]; if (p) setValue(v => ({ ...v, imapHost: p.imap, imapPort: 993, smtpHost: p.smtp, smtpPort: p.port, smtpSecurity: p.security as "tls" | "starttls" })); }}><option value="custom" disabled>当前配置</option>{presets.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}</select></label>
   <label>显示名称<input value={value.name} maxLength={100} placeholder="例如：工作邮箱" onChange={e => field("name", e.target.value)} /></label>
   <label>邮箱地址<input type="email" required value={value.email} maxLength={320} autoComplete="off" onChange={e => field("email", e.target.value)} /></label>
   <label>登录用户名<input value={value.username} maxLength={320} placeholder="默认使用邮箱地址" autoComplete="off" onChange={e => field("username", e.target.value)} /></label>
   <label className="mail-form-wide">授权码 / 应用专用密码<SecretField secretLabel="邮箱授权码" aria-label="授权码 / 应用专用密码" required={!account.id} value={password} disabled={busy} maxLength={4096} autoComplete="new-password" reveal={account.id ? () => mailClient.reveal(account.id) : undefined} placeholder={account.id ? "已保存，点击右侧小眼睛查看；输入新值可替换" : "在邮箱设置中开启 IMAP / SMTP 并生成授权码"} onChange={e => setPassword(e.target.value)} /></label>
   <label>IMAP 服务器<input required value={value.imapHost} placeholder="imap.example.com" onChange={e => field("imapHost", e.target.value.trim())} /></label>
   <label>IMAP TLS 端口<input type="number" min={1} max={65535} required value={value.imapPort} onChange={e => field("imapPort", Number(e.target.value))} /></label>
   <label>SMTP 服务器<input required value={value.smtpHost} placeholder="smtp.example.com" onChange={e => field("smtpHost", e.target.value.trim())} /></label>
   <label>SMTP 端口<input type="number" min={1} max={65535} required value={value.smtpPort} onChange={e => field("smtpPort", Number(e.target.value))} /></label>
   <label>SMTP 加密<select value={value.smtpSecurity} onChange={e => field("smtpSecurity", e.target.value as "tls" | "starttls")}><option value="tls">TLS（通常 465）</option><option value="starttls">STARTTLS（通常 587）</option></select></label>
  </fieldset>
  <p className="mail-hint">QQ、网易等通常需要客户端授权码。iCloud 需要应用专用密码。凭据仅在本机加密保存。</p>
  <p className="mail-hint">首版使用 IMAP TLS 收信与 SMTP 发信，共用登录用户名与凭据。Gmail / 微软 OAuth 登录、POP3 与明文连接暂未提供。</p>
  {error && <p className="mail-error" role="alert">{error}</p>}
 </SharedDialog>;
}

function Composer({ account, initial, onClose, onSent }: { account: MailAccount; initial: MailDraft; onClose: () => void; onSent: () => void }) {
 const [draft, setDraft] = useState(initial);
 const [busy, setBusy] = useState(false);
 const [reading, setReading] = useState(false);
 const [error, setError] = useState("");
 const [discard, setDiscard] = useState(false);
 const locked = useRef(false);
 const dirty = draft.to !== initial.to || draft.subject !== initial.subject || draft.body !== initial.body || draft.attachments.length > 0;
 const close = () => { if (dirty) setDiscard(true); else onClose(); };
 return <><SharedDialog title="写邮件" subtitle={"发件人：" + account.email} icon={<Pencil size={18} />} className="mail-compose-dialog" onClose={close} closeDisabled={busy || reading} busy={busy || reading} onSubmit={async e => {
  e.preventDefault(); if (locked.current) return; locked.current = true; setBusy(true); setError("");
  try { await mailClient.send(account.id, draft); onSent(); } catch (e) { setError(errorText(e)); } finally { locked.current = false; setBusy(false); }
 }} footer={<><span className="mail-hint">纯文本邮件 · 附件合计 ≤ 10 MiB</span><button type="button" className="secondary" disabled={busy || reading} onClick={close}>取消</button><button className="primary" disabled={busy || reading}><Send size={14} />{busy ? "正在发送…" : "发送邮件"}</button></>}>
  <fieldset className="mail-compose-form" disabled={busy || reading}>
   <label>收件人<input required value={draft.to} maxLength={4000} placeholder="多个地址使用逗号分隔" onChange={e => setDraft(v => ({ ...v, to: e.target.value }))} /></label>
   <label>主题<input required value={draft.subject} maxLength={300} onChange={e => setDraft(v => ({ ...v, subject: e.target.value }))} /></label>
   <label>正文<textarea required rows={12} maxLength={1000000} value={draft.body} onChange={e => setDraft(v => ({ ...v, body: e.target.value }))} /></label>
   <label className="mail-file-input"><Paperclip size={14} />添加附件<input type="file" multiple disabled={busy || reading} onChange={async e => {
    const files = Array.from(e.target.files ?? []); e.target.value = "";
    if (!files.length) return;
    const existing = draft.attachments.reduce((n, f) => n + Math.floor(f.data.length * 3 / 4), 0);
    if (draft.attachments.length + files.length > 10 || existing + files.reduce((n, f) => n + f.size, 0) > 10 * 1048576) { setError("最多 10 个附件，合计不能超过 10 MiB"); return; }
    setReading(true); setError("");
    try { const attachments = await Promise.all(files.map(file => new Promise<{ name: string; data: string }>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("读取附件失败")); reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(",")[1] }); reader.readAsDataURL(file); }))); setDraft(v => ({ ...v, attachments: [...v.attachments, ...attachments] })); } catch (e) { setError(errorText(e)); } finally { setReading(false); }
   }} /></label>
   {draft.attachments.map((f, i) => <div className="mail-file" key={i}><Paperclip size={13} /><span>{f.name}</span><button type="button" disabled={busy} aria-label={"移除附件 " + f.name} onClick={() => setDraft(v => ({ ...v, attachments: v.attachments.filter((_, n) => n !== i) }))}>移除</button></div>)}
  </fieldset>
  <p className="mail-hint">发送成功表示 SMTP 服务器已接受邮件，不保证最终投递。已发送副本由服务商保存；本版不额外上传副本。</p>
  {error && <p className="mail-error" role="alert">{error}</p>}
 </SharedDialog>{discard && <ConfirmDialog title="放弃这封邮件？" message="邮件尚未发送，关闭后本次内容将丢失。" confirmLabel="放弃邮件" onResolve={yes => { setDiscard(false); if (yes) onClose(); }} />}</>;
}

export function MailPlugin() {
 const [accounts, setAccounts] = useState<MailAccount[]>([]);
 const [id, setId] = useState("");
 const [folders, setFolders] = useState<string[]>(["INBOX"]);
 const [folder, setFolder] = useState("INBOX");
 const [listing, setListing] = useState<MailListing>({ validity: 0, total: 0, messages: [] });
 const [selected, setSelected] = useState<MailSummary | null>(null);
 const [message, setMessage] = useState<MailMessage | null>(null);
 const [editor, setEditor] = useState<MailAccount | null>(null);
 const [draft, setDraft] = useState<MailDraft | null>(null);
 const [remove, setRemove] = useState(false);
 const [keyword, setKeyword] = useState("");
 const [busy, setBusy] = useState("");
 const [error, setError] = useState("");
 const [notice, setNotice] = useState("");
 const lock = useRef(false);
 const generation = useRef(0);
 const account = accounts.find(a => a.id === id);
 const run = async (label: string, work: () => Promise<void>) => {
  if (lock.current) return; lock.current = true; setBusy(label); setError(""); setNotice("");
  try { await work(); } catch (e) { setError(errorText(e)); } finally { lock.current = false; setBusy(""); }
 };
 useEffect(() => {
  if (!runningInTauri) return;
  let active = true;
  void mailClient.accounts().then(items => { if (active) { setAccounts(items); setId(items[0]?.id ?? ""); } }).catch(e => { if (active) setError(errorText(e)); });
  return () => { active = false; generation.current++; };
 }, []);
 const reset = (next: string) => { generation.current++; setId(next); setFolder("INBOX"); setFolders(["INBOX"]); setListing({ validity: 0, total: 0, messages: [] }); setSelected(null); setMessage(null); setError(""); setNotice(""); };
 const refresh = () => run("正在收取邮件…", async () => {
  const token = generation.current;
  let folderWarning = "";
  try {
   const names = await mailClient.folders(id);
   if (token !== generation.current) return;
   setFolders(names);
  } catch (e) {
   if (token !== generation.current) return;
   folderWarning = errorText(e);
   setFolders(["INBOX"]);
   if (folder !== "INBOX") setFolder("INBOX");
  }
  const targetFolder = folderWarning ? "INBOX" : folder;
  const data = await mailClient.list(id, targetFolder);
  if (token !== generation.current) return;
  setListing(data); setSelected(null); setMessage(null);
  setNotice("已更新" + (targetFolder === "INBOX" ? "收件箱" : "当前文件夹") + "，显示最近 " + data.messages.length + " 封邮件" + (folderWarning ? "。读取其他文件夹失败，已退回收件箱：" + folderWarning : ""));
 });
 const read = (summary: MailSummary) => run("正在读取邮件…", async () => {
  setSelected(summary); setMessage(null); const token = generation.current;
  const data = await mailClient.read(id, folder, listing.validity, summary.uid);
  if (token !== generation.current) return;
  setMessage(data); setListing(v => ({ ...v, messages: v.messages.map(m => m.uid === summary.uid ? { ...m, unread: false } : m) }));
 });
 const verificationCode = message ? extractVerificationCode(message.subject, message.from, message.body) : null;
 const copyVerificationCode = async () => {
  if (!verificationCode) { setNotice("未能从当前邮件中识别到明确的验证码"); return; }
  try { await navigator.clipboard.writeText(verificationCode); setNotice("验证码已复制到剪贴板"); }
  catch { setError("复制验证码失败，请检查剪贴板权限"); }
 };
 const searchTerm = keyword.trim().normalize("NFKC").toLowerCase();
 const filtered = listing.messages.filter(m => (m.subject + " " + m.from).normalize("NFKC").toLowerCase().includes(searchTerm));
 return <div className="mail-app" aria-busy={!!busy}>
  <header className="mail-toolbar"><div className="mail-title"><Mail size={19} /><div><h2>邮件管理</h2><span>多邮箱 · 本地加密凭据</span></div></div><label className="mail-toolbar-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="搜索邮箱" disabled={!account || !!busy} value={keyword} placeholder="模糊搜索已加载邮件：主题 / 发件人（最近 50 封）" onChange={e => setKeyword(e.target.value)} /></label><div className="mail-toolbar-actions"><button type="button" className="secondary" disabled={!!busy || !runningInTauri} onClick={() => setEditor({ ...emptyAccount })}><Plus size={14} />添加邮箱</button><button type="button" className="primary" disabled={!account || !!busy} onClick={() => setDraft(emptyDraft())}><Pencil size={14} />写邮件</button></div></header>
  {!runningInTauri && <p className="mail-banner" role="status">邮件收发仅支持 CloudHub 桌面客户端。浏览器预览不连接邮箱，也不保存授权码。</p>}
  {error && <p className="mail-error" role="alert">{error}</p>}{(busy || notice) && <p className="mail-status" role="status">{busy || notice}</p>}
  <div className="mail-workspace">
   <aside className="mail-sidebar"><label>当前邮箱<select aria-label="当前邮箱" disabled={!!busy} value={id} onChange={e => reset(e.target.value)}><option value="">选择邮箱</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>{account && <><div className="mail-account-caption">{account.email}</div><div className="mail-account-tools"><button type="button" disabled={!!busy} title="编辑邮箱" aria-label="编辑邮箱" onClick={() => setEditor(account)}><Settings size={14} /></button><button type="button" disabled={!!busy} onClick={() => void run("正在分别检测收信与发信…", async () => { const r = await mailClient.test(id); const imap = r.imap ? "通过" : "失败" + (r.imapError ? "（" + r.imapError + "）" : ""); const smtp = r.smtp ? "通过" : "失败" + (r.smtpError ? "（" + r.smtpError + "）" : ""); setNotice("IMAP 收信：" + imap + "；SMTP 发信：" + smtp + ((!r.imap || !r.smtp) && !r.imapError && !r.smtpError ? "。请检查服务是否开启、授权码和服务器配置。" : "")); })}>检测连接</button><button type="button" disabled={!!busy} title="移除邮箱" aria-label="移除邮箱" onClick={() => setRemove(true)}><Trash2 size={14} /></button></div></>}
    <nav aria-label="邮件文件夹">{folders.map(name => <button type="button" key={name} disabled={!!busy || !account} className={folder === name ? "is-active" : ""} aria-current={folder === name ? "page" : undefined} onClick={() => { generation.current++; setFolder(name); setListing({ validity: 0, total: 0, messages: [] }); setMessage(null); setSelected(null); setNotice("点击收取邮件加载当前文件夹"); }}><Inbox size={14} /><span>{folderName(name)}</span></button>)}</nav>
    <p className="mail-hint">选择邮箱后点击收取邮件。正文按需读取，不在本地持久缓存。</p>
   </aside>
   <section className="mail-list-pane" aria-label="邮件列表"><div className="mail-list-tools"><h3>{folderName(folder)} <small>{listing.total}</small></h3><button type="button" className="secondary" disabled={!account || !!busy} onClick={() => void refresh()}><RefreshCw size={13} />收取邮件</button></div><div className="mail-message-list">{filtered.map(m => <button type="button" key={m.uid} disabled={!!busy} className={"mail-message-row " + (selected?.uid === m.uid ? "is-selected " : "") + (m.unread ? "is-unread" : "")} onClick={() => void read(m)}><span className="mail-row-subject">{m.unread && <span aria-label="未读" className="mail-unread-dot" />}{m.subject || "（无主题）"}</span><span className="mail-row-from">{m.from}</span><span className="mail-row-date">{m.date}</span></button>)}{!filtered.length && <div className="mail-empty"><Inbox size={30} /><h3>{!account ? "连接你的第一个邮箱" : keyword ? "没有匹配的邮件" : "等待收取邮件"}</h3><p>{!account ? "添加邮箱与客户端授权码，即可在这里收发邮件。" : "点击收取邮件，加载当前文件夹最近 50 封。"}</p>{!account && <button type="button" className="primary" disabled={!runningInTauri} onClick={() => setEditor({ ...emptyAccount })}>添加邮箱</button>}</div>}</div></section>
   <section className="mail-reader" aria-label="邮件正文">{message ? <><header><h3>{message.subject || "（无主题）"}</h3><dl><dt>发件人</dt><dd>{message.from}</dd><dt>收件人</dt><dd>{message.to}</dd><dt>时间</dt><dd>{message.date}</dd></dl><div className="mail-reader-actions"><button type="button" className="secondary" title="从当前邮件内容中识别并复制验证码" disabled={!!busy} onClick={() => void copyVerificationCode()}><Copy size={14} />复制验证码</button><button type="button" className="secondary" disabled={!!busy} onClick={() => setDraft({ ...emptyDraft(), to: message.from.match(/<([^>]+)>/)?.[1] ?? message.from, subject: /^re:/i.test(message.subject) ? message.subject : "Re: " + message.subject, body: "\n\n----- 原邮件 -----\n" + message.body })}><Reply size={14} />回复</button></div></header><pre className="mail-body">{message.body}</pre>{message.attachments.length > 0 && <div className="mail-attachments"><h4>附件</h4>{message.attachments.map(f => <button type="button" key={f.index} disabled={!!busy} onClick={() => void run("正在下载附件…", async () => { if (!selected) return; const saved = await mailClient.attachment(id, folder, listing.validity, selected.uid, f.index); setNotice(saved ? "附件已保存" : "已取消保存"); })}><Download size={14} /><span>{f.name}</span><small>{sizeText(f.size)}</small></button>)}</div>}</> : <div className="mail-empty"><Mail size={34} /><h3>选择一封邮件</h3><p>安全阅读纯文本正文，远程图片不会自动加载。</p></div>}</section>
  </div>
  {editor && <AccountEditor account={editor} onClose={() => setEditor(null)} onSaved={a => { setAccounts(items => [...items.filter(v => v.id !== a.id), a]); reset(a.id); setEditor(null); setNotice("邮箱已保存，可先检测连接，再收取邮件"); }} />}
  {draft && account && <Composer account={account} initial={draft} onClose={() => setDraft(null)} onSent={() => { setDraft(null); setNotice("邮件已提交给 SMTP 服务器"); }} />}
  {remove && account && <ConfirmDialog title="移除邮箱？" message={"将从本机移除“" + account.name + "”的配置和授权码，不会删除服务器上的邮件。"} confirmLabel="移除邮箱" busy={!!busy} onResolve={yes => { if (!yes) setRemove(false); else void run("正在移除邮箱…", async () => { await mailClient.remove(id); const next = accounts.filter(a => a.id !== id); setAccounts(next); reset(next[0]?.id ?? ""); setRemove(false); }); }} />}
 </div>;
}
