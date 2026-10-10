import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download, Edit3, Grid2X2, KeyRound, List, LockKeyhole, Plus, Search, ShieldCheck, Star, Trash2, Upload, X } from "lucide-react";
import { authenticatorClient as client, type AuthCode, type AuthEntry, type AuthInput, type AuthPreview } from "../../platform/clients/authenticator";
import { runningInTauri } from "../../platform/api";
import "./authenticator.css";
import { ProviderIcon } from "./ProviderIcon";
import { Format, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";

const emptyDraft = (): AuthInput => ({ issuer: "", account: "", kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: "0", group: "", note: "", pinned: false, order: 0, secret: "" });
const displayCode = (code?: string) => code ? (/^\d+$/.test(code) ? code.replace(/(.{3})(?=.)/g, "$1 ") : code) : "— — —";
const issuerKey = (issuer: string) => `issuer:${issuer.trim().toLowerCase()}`;
const issuerTone = (issuer: string) => {
  let hash = 0;
  for (const character of issuerKey(issuer)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `auth-tone-${hash % 6}`;
};

function Modal({ title, children, close, busy }: { title: string; children: ReactNode; close: () => void; busy: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); opener?.focus(); };
  }, []);

  return <dialog className="auth-dialog" ref={dialog} onCancel={(event) => { event.preventDefault(); if (!busy) close(); }} aria-label={title}>
    <header><h3>{title}</h3><button type="button" aria-label="关闭对话框" disabled={busy} onClick={close}><X size={18} /></button></header>{children}
  </dialog>;
}

export function AuthenticatorPanel({ mobile = false }: { mobile?: boolean }) {
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<AuthEntry[]>([]);
  const [codes, setCodes] = useState<Record<string, AuthCode>>({});
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [category, setCategory] = useState("all");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState("custom");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<AuthInput | null>(null);
  const [modal, setModal] = useState<"import" | "export" | "delete" | null>(null);
  const [importPassword, setImportPassword] = useState("");
  const [uriText, setUriText] = useState("");
  const [preview, setPreview] = useState<AuthPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [exportFormat, setExportFormat] = useState<"cloudhub" | "ente" | "plain">("cloudhub");
  const [exportPassword, setExportPassword] = useState("");
  const [exportRepeat, setExportRepeat] = useState("");
  const [acknowledgePlain, setAcknowledgePlain] = useState(false);
  const [copied, setCopied] = useState("");
  const [copyNotice, setCopyNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const alive = useRef(true);
  const epoch = useRef(0);
  const activity = useRef(0);
  const timerBusy = useRef(false);
  const actionBusy = useRef(false);
  const scanning = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSecrets = useCallback(() => {
    ++epoch.current; setUnlocked(false); setEntries([]); setCodes({}); setDraft(null); setModal(null);
    setPreview(null); setChoices({}); setSelected(new Set()); setPassword("");
    setImportPassword(""); setUriText(""); setExportPassword(""); setExportRepeat("");
    setCopied(""); setCopyNotice(null); if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);
  useEffect(() => {
    alive.current = true;
    void openVault();
    return () => { alive.current = false; ++epoch.current; if (copyTimer.current) clearTimeout(copyTimer.current); void client.lock(); };
  }, []);

  useEffect(() => {
    if (!mobile) return;
    const visibility = () => {
      // System camera and document pickers temporarily cover the WebView.
      if (actionBusy.current || scanning.current) return;
      if (document.visibilityState === "hidden") { clearSecrets(); void client.lock(); }
      else void openVault();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [mobile, clearSecrets]);

  async function openVault() {
    try { const status = await client.status(); if (alive.current) { setPasswordRequired(status.passwordRequired); setUnlocked(status.unlocked); } }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "读取验证器状态失败"); }
    finally { if (alive.current) setLoading(false); }
  }

  async function refresh() {
    const request = epoch.current;
    const items = await client.list();
    if (alive.current && request === epoch.current) { setEntries(items); setSelected((old) => new Set([...old].filter((id) => items.some((item) => item.id === id)))); }
  }
  useEffect(() => { if (unlocked) void refresh().catch(() => clearSecrets()); }, [unlocked, clearSecrets]);
  const groups = useMemo(() => [...new Set(entries.map((entry) => entry.group).filter(Boolean))].sort(), [entries]);
  const categories = useMemo(() => {
    const counts = new Map<string, { id: string; issuer: string; label: string; count: number }>();
    for (const entry of entries) {
      const id = issuerKey(entry.issuer);
      const existing = counts.get(id);
      if (existing) existing.count++;
      else counts.set(id, { id, issuer: entry.issuer, label: entry.issuer.trim() || "未指定服务商", count: 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [entries]);
  useEffect(() => {
    if (category !== "all" && !categories.some((item) => item.id === category)) setCategory("all");
  }, [categories, category]);
  const filtered = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    return entries.filter((e) => (category === "all" || issuerKey(e.issuer) === category) && (group === "all" || e.group === group.slice(2)) && (!keyword || `${e.issuer} ${e.account} ${e.note} ${e.group}`.toLocaleLowerCase().includes(keyword)))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (sort === "name" ? a.issuer.localeCompare(b.issuer) || a.account.localeCompare(b.account) : a.order - b.order));
  }, [entries, category, group, search, sort]);
  useEffect(() => { setPage(1); }, [category, group, search, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 100));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * 100, safePage * 100);
  const visibleIds = visible.map((entry) => entry.id).join(",");
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    const request = epoch.current;
    setCodes({});
    const tick = async () => {
      if (mobile && document.visibilityState === "hidden") return;
      if (timerBusy.current) return;
      timerBusy.current = true;
      try {
        const next = await client.codes(visibleIds ? visibleIds.split(",") : []);
        if (!cancelled && request === epoch.current) setCodes(Object.fromEntries(next.map((code) => [code.id, code])));
      } catch (reason) {
        if (!cancelled && request === epoch.current) { clearSecrets(); setError(reason instanceof Error ? reason.message : "验证器已锁定"); }
      } finally { timerBusy.current = false; }
    };
    void tick(); const timer = setInterval(() => void tick(), 1000);
    const visibility = () => { if (!mobile && document.visibilityState !== "hidden") void tick(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [unlocked, visibleIds, clearSecrets, mobile]);

  function touch() {
    if (unlocked && Date.now() - activity.current > 15_000) { activity.current = Date.now(); void client.touch().catch(() => clearSecrets()); }
  }
  async function action(operation: () => Promise<void>) {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusy(true); setError(""); setMessage("");
    try { await operation(); }
    catch (reason) {
      const text = reason instanceof Error ? reason.message : "操作失败"; setError(text);
      if (text.includes("锁定")) clearSecrets();
    } finally { actionBusy.current = false; if (alive.current) setBusy(false); }
  }
  async function copyCode(entry: AuthEntry, target: "current" | "next" | "account" = "current") {
    if (actionBusy.current) return;
    actionBusy.current = true; setBusy(true);
    const request = epoch.current;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    try {
      await client.copy(entry.id, target);
      if (alive.current && request === epoch.current) {
        setCopied(`${entry.id}:${target}`);
        const label = target === "account" ? "账号" : target === "next" ? "下一个验证码" : "验证码";
        setCopyNotice({ text: `${entry.issuer || "未指定服务商"} · ${entry.account || "未指定账户"}：${label}复制成功`, failed: false });
      }
    } catch (reason) {
      if (alive.current && request === epoch.current) {
        const text = reason instanceof Error ? reason.message : "请重试";
        if (text.includes("锁定")) clearSecrets();
        setCopied(""); setCopyNotice({ text: `复制失败：${text}`, failed: true });
      }
    } finally {
      actionBusy.current = false;
      if (alive.current) {
        setBusy(false);
        copyTimer.current = setTimeout(() => { setCopied(""); setCopyNotice(null); }, 3000);
      }
    }
  }
  async function unlock(event: FormEvent) {
    event.preventDefault();
    const value = password; setPassword("");
    await action(async () => { await client.unlock(value, false); if (alive.current) { ++epoch.current; setPasswordRequired(false); setUnlocked(true); } });
  }
  function closeModal() {
    if (modal === "import") void client.cancel().catch(() => {});
    setModal(null); setPreview(null); setChoices({}); setImportPassword(""); setUriText("");
    setExportPassword(""); setExportRepeat(""); setAcknowledgePlain(false);
  }
  async function prepare(qr: boolean, text?: string, image?: number[]) {
    const value = importPassword; setImportPassword(""); setUriText("");
    await action(async () => {
      const data = await client.prepare({ password: value, qr, text, image });
      if (data) { setPreview(data); setChoices(Object.fromEntries(data.items.map((item) => [item.entry.id, item.duplicateId ? "skip" : "add"]))); }
    });
  }
  async function scanOtp() {
    if (scanning.current || actionBusy.current) return;
    scanning.current = true; setBusy(true); setError("");
    try {
      const permissions = await requestPermissions();
      if (permissions !== "granted") { setError("未获得相机权限，请在系统设置中允许后重试"); return; }
      const result = await scan({ windowed: false, formats: [Format.QRCode] });
      if (!result.content?.startsWith("otpauth://")) { setError("请扫描 OTP 验证码二维码"); return; }
      await prepare(false, result.content);
    } catch { setError("扫码已取消或相机不可用，可改为导入图片或粘贴地址"); }
    finally { scanning.current = false; if (alive.current) setBusy(false); }
  }
  async function pasteImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    if (file.size > 10 * 1024 * 1024) { setError("二维码图片不能超过 10 MiB"); return; }
    await prepare(true, undefined, [...new Uint8Array(await file.arrayBuffer())]);
  }
  const exportIds = selected.size ? [...selected] : entries.map((entry) => entry.id);
  const alerts = <>{error && !modal && !draft && <div className="auth-alert auth-error" role="alert">{error}</div>}{message && <div className="auth-alert" role="status">{message}</div>}</>;

  if (loading) return <section className="auth-panel"><p role="status">正在读取验证器状态…</p></section>;
  if (!unlocked) return <section className="auth-panel"><h2><ShieldCheck size={22} /> 验证器</h2>{alerts}{passwordRequired ? <form className="auth-unlock" onSubmit={(event) => void unlock(event)}>
    <LockKeyhole size={38} /><h3>迁移已有验证器</h3><p>已有数据由旧主密码加密。输入一次原密码后，改为打开即用，验证码保持不变。</p>
    <label>原主密码<input type="password" autoComplete="current-password" autoFocus required maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <button className="auth-primary" disabled={busy} type="submit">{busy ? "正在迁移…" : "迁移并打开"}</button>
  </form> : <div className="auth-empty"><p>暂时无法打开本地验证器。</p><button disabled={busy} onClick={() => void action(openVault)}>重试</button></div>}</section>;

  return <section className={`auth-panel${mobile ? " auth-mobile" : ""}`} onPointerDown={touch} onKeyDown={touch}>
    {copyNotice && <div className="toast-notice auth-copy-toast" role={copyNotice.failed ? "alert" : "status"} aria-atomic="true">{!copyNotice.failed && <Check size={16} aria-hidden="true" />}<span>{copyNotice.text}</span></div>}
    <header className="auth-header"><div><h2><ShieldCheck size={22} /> 验证器</h2><span>{entries.length} 个验证码 · 本地加密保存</span></div><div className="auth-actions">
      <button disabled={busy} onClick={() => { setDraft(emptyDraft()); setError(""); }}><Plus size={16} /> 新增</button>
      <button disabled={busy} onClick={() => { setModal("import"); setError(""); }}><Upload size={16} /> 导入</button>
      <button disabled={busy || !entries.length} onClick={() => { setModal("export"); setError(""); }}><Download size={16} /> {selected.size ? `导出所选（${selected.size}）` : "导出全部"}</button>
    </div></header>{alerts}
    <div className="auth-toolbar"><div className="auth-search"><Search size={16} /><input aria-label="搜索验证码" placeholder="搜索服务商、账户或备注" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <select aria-label="验证码排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="custom">自定义顺序</option><option value="name">按服务商名称</option></select>
      <div className="auth-view" role="group" aria-label="显示方式"><button aria-label="卡片视图" title="卡片视图" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}><Grid2X2 size={17} /></button><button aria-label="列表视图" title="列表视图" aria-pressed={layout === "list"} onClick={() => setLayout("list")}><List size={17} /></button></div>
    </div>
    <div className="auth-filters">
      {groups.length > 0 && <select aria-label="验证码分组" value={group} onChange={(event) => setGroup(event.target.value)}><option value="all">所有分组</option>{groups.map((name) => <option key={name} value={`g:${name}`}>{name}</option>)}</select>}
      {entries.length > 0 && <div className="auth-categories" role="group" aria-label="服务商分类统计">
        {[{ id: "all", issuer: "", label: "全部", count: entries.length }, ...categories].map((item) => <button className={`auth-category ${item.id === "all" ? "" : issuerTone(item.issuer)}`} key={item.id} aria-label={`${item.id === "all" ? "全部服务商" : item.label}，共 ${item.count} 项`} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}><span className="auth-category-dot" aria-hidden="true" /><span className="auth-category-name">{item.label}</span><strong>{item.count}</strong>{category === item.id && <Check size={14} aria-hidden="true" />}</button>)}
      </div>}
    </div>
    {entries.length > 0 && <div className="auth-selection"><label><input type="checkbox" ref={(node) => { if (node) node.indeterminate = visible.some((entry) => selected.has(entry.id)) && !visible.every((entry) => selected.has(entry.id)); }} checked={visible.length > 0 && visible.every((entry) => selected.has(entry.id))} onChange={(event) => setSelected((old) => { const next = new Set(old); visible.forEach((entry) => event.target.checked ? next.add(entry.id) : next.delete(entry.id)); return next; })} /> 选择本页</label><span>已选 {selected.size} 项</span>{selected.size > 0 ? <><button className="auth-primary" disabled={busy} onClick={() => { setModal("export"); setError(""); }}><Download size={14} /> 导出所选</button><button onClick={() => setSelected(new Set())}>取消选择</button><button disabled={busy} onClick={() => setModal("delete")}><Trash2 size={14} /> 删除所选</button></> : <span className="auth-hint">勾选验证码后可导出部分条目</span>}</div>}
    {!visible.length ? <div className="auth-empty"><KeyRound size={36} /><h3>{entries.length ? "没有匹配的验证码" : "还没有验证码"}</h3><p>{entries.length ? "调整搜索条件、服务商类别或分组。" : "导入 Ente 文件、识别二维码图片，或手动添加 OTP 密钥。"}</p></div> : <div className={`auth-cards ${layout === "list" ? "auth-list" : ""}`}>
      {visible.map((entry) => { const code = codes[entry.id]; return <article className={`auth-card ${code && code.remaining <= 5 && entry.kind !== "hotp" ? "auth-expiring" : ""}`} key={entry.id}>
        <div className="auth-card-heading"><div className="auth-card-top"><label><input aria-label={`选择 ${entry.issuer} ${entry.account}`} type="checkbox" checked={selected.has(entry.id)} onChange={(event) => setSelected((old) => { const next = new Set(old); event.target.checked ? next.add(entry.id) : next.delete(entry.id); return next; })} /></label><div className="auth-identity"><strong title={entry.issuer}>{entry.issuer || "未指定服务商"}</strong></div>
          <button className={entry.pinned ? "auth-pinned" : ""} aria-label={`${entry.pinned ? "取消置顶" : "置顶"} ${entry.account}`} disabled={busy} onClick={() => void action(async () => { await client.save({ ...entry, pinned: !entry.pinned }); await refresh(); })}><Star size={16} fill={entry.pinned ? "currentColor" : "none"} /></button>
          <button aria-label={`编辑 ${entry.account}`} onClick={() => { setDraft({ ...entry, secret: "" }); setError(""); }}><Edit3 size={15} /></button>
          <ProviderIcon issuer={entry.issuer} />
        </div><div className="auth-account"><span>{entry.account || "未指定账户"}</span><button className="auth-copy-account" aria-label={`复制账号 ${entry.account}`} title="复制账号" disabled={busy || !entry.account} onClick={() => void copyCode(entry, "account")}>{copied === `${entry.id}:account` ? <Check size={14} /> : <Copy size={14} />}</button></div></div>
        <div className="auth-code-row"><button className="auth-code" aria-label={`复制 ${entry.account} 验证码`} title="复制当前验证码" disabled={busy || !code} onClick={() => void copyCode(entry)}>{displayCode(code?.current)}{copied === `${entry.id}:current` ? <Check size={15} /> : <Copy size={15} />}</button>
          {entry.kind !== "hotp" && <div className="auth-next"><span>下一个</span><button aria-label={`复制 ${entry.account} 下一个验证码`} title="复制下一个验证码" disabled={busy || !code?.next} onClick={() => void copyCode(entry, "next")}><strong>{displayCode(code?.next ?? undefined)}</strong>{copied === `${entry.id}:next` ? <Check size={13} /> : <Copy size={13} />}</button></div>}
        </div>
        <div className="auth-card-footer"><span>{entry.group}{entry.note && <span title={entry.note}>{entry.group ? " · " : ""}{entry.note}</span>}</span>{entry.kind === "hotp" ? <button disabled={busy} onClick={() => void action(async () => { await client.advance(entry.id); await refresh(); setCodes({}); })}>下一码 · 计数 {entry.counter}</button> : <span>{code ? `${code.remaining} 秒` : "计算中…"}</span>}</div>
        {entry.kind !== "hotp" && <div className="auth-progress" role="progressbar" aria-label={`${entry.account} 剩余时间`} aria-valuemin={0} aria-valuemax={entry.period} aria-valuenow={code?.remaining ?? 0}><i style={{ transform: `scaleX(${code ? code.remaining / code.period : 0})` }} /></div>}
      </article>; })}
    </div>}
    {pageCount > 1 && <div className="auth-pagination"><button aria-label="上一页" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}><ChevronLeft size={16} /></button><span>第 {safePage} / {pageCount} 页 · {filtered.length} 项</span><button aria-label="下一页" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}><ChevronRight size={16} /></button></div>}

    {draft && <Modal title={draft.id ? "编辑验证码" : "新增验证码"} busy={busy} close={() => { setDraft(null); setError(""); }}><form onSubmit={(event) => { event.preventDefault(); const input = draft; setDraft({ ...draft, secret: "" }); void action(async () => { await client.save(input); setDraft(null); await refresh(); setMessage("验证码已保存"); }); }}>
      <div className="auth-form-grid"><label>服务商<input maxLength={256} value={draft.issuer} onChange={(event) => setDraft({ ...draft, issuer: event.target.value })} /></label><label>账户<input maxLength={512} value={draft.account} onChange={(event) => setDraft({ ...draft, account: event.target.value })} /></label></div>
      <label>OTP 密钥{draft.id && "（留空保留原密钥）"}<input type="password" autoComplete="off" required={!draft.id} maxLength={1024} value={draft.secret || ""} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} /></label>
      <div className="auth-form-grid"><label>类型<select value={draft.kind} onChange={(event) => { const kind = event.target.value as AuthInput["kind"]; setDraft({ ...draft, kind, digits: kind === "steam" ? 5 : 6, algorithm: "SHA1", period: 30 }); }}><option value="totp">TOTP（时间）</option><option value="hotp">HOTP（计数）</option><option value="steam">Steam</option></select></label><label>算法<select disabled={draft.kind === "steam"} value={draft.algorithm} onChange={(event) => setDraft({ ...draft, algorithm: event.target.value as AuthInput["algorithm"] })}>{["SHA1", "SHA256", "SHA512"].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>位数<select disabled={draft.kind === "steam"} value={draft.digits} onChange={(event) => setDraft({ ...draft, digits: Number(event.target.value) })}>{(draft.kind === "steam" ? [5] : [6, 7, 8]).map((value) => <option key={value}>{value}</option>)}</select></label><label>{draft.kind === "hotp" ? "计数" : "周期（秒）"}<input type={draft.kind === "hotp" ? "text" : "number"} inputMode="numeric" pattern={draft.kind === "hotp" ? "[0-9]{1,20}" : undefined} min={1} max={3600} disabled={draft.kind === "steam"} value={draft.kind === "hotp" ? draft.counter : draft.period} onChange={(event) => setDraft({ ...draft, [draft.kind === "hotp" ? "counter" : "period"]: draft.kind === "hotp" ? event.target.value : Number(event.target.value) })} /></label>
      <label>分组<input maxLength={128} list="auth-group-options" value={draft.group} onChange={(event) => setDraft({ ...draft, group: event.target.value })} /><datalist id="auth-group-options">{groups.map((name) => <option key={name}>{name}</option>)}</datalist></label><label>排序序号<input type="number" min={-2147483648} max={2147483647} value={draft.order} onChange={(event) => setDraft({ ...draft, order: Number(event.target.value) })} /></label></div>
      <label>备注<textarea maxLength={4096} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label><label className="auth-checkbox"><input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} />置顶</label>
      {error && <p className="auth-error" role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="auth-primary" disabled={busy} type="submit">{busy ? "保存中…" : "保存"}</button></footer>
    </form></Modal>}
    {modal === "import" && <Modal title="导入验证码" busy={busy} close={closeModal}>
      {!preview ? <><p>支持 Ente 明文 / 加密文件、CloudHub 加密备份及 OTP 二维码图片。先填写加密文件密码，再选择文件。</p><label>文件密码（明文和二维码留空）<input type="password" autoComplete="off" maxLength={1024} value={importPassword} onChange={(event) => setImportPassword(event.target.value)} /></label>
        <div className="auth-import-buttons">{mobile && runningInTauri && <button disabled={busy} onClick={() => void scanOtp()}><Grid2X2 size={16} />扫描二维码</button>}<button disabled={busy} onClick={() => void prepare(false)}><Upload size={16} />选择导入文件</button><button disabled={busy} onClick={() => void prepare(true)}><Grid2X2 size={16} />选择二维码图片</button></div>
        <label>粘贴 OTP 地址或二维码图片<textarea autoComplete="off" maxLength={1048576} placeholder="otpauth://…（支持多行），也可在此粘贴图片" value={uriText} onPaste={(event) => void pasteImage(event)} onChange={(event) => setUriText(event.target.value)} /></label><button disabled={busy || !uriText.trim()} onClick={() => void prepare(false, uriText)}>解析粘贴内容</button><small>密钥只在原生进程解析；预览不显示密钥。</small></> : <>
        <p>{preview.format} · 有效 {preview.items.length} 项 · 无效 {preview.errors.length} 项</p><div className="auth-import-preview">{preview.items.map((item) => <div className="auth-import-row" key={item.entry.id}><div><strong>{item.entry.issuer} · {item.entry.account}</strong><span>{item.entry.kind.toUpperCase()} · {item.entry.algorithm} · {item.entry.digits} 位{item.entry.kind === "hotp" ? ` · 计数 ${item.entry.counter}` : ` · ${item.entry.period} 秒`}</span><small>{item.duplicateId ? "相同密钥和参数" : item.conflict ? "同名账户，密钥不同，将作为独立条目" : "新增"}{item.conflict && item.duplicateId ? " · 计数有差异" : ""}</small></div><select aria-label={`导入操作 ${item.entry.account}`} value={choices[item.entry.id]} onChange={(event) => setChoices({ ...choices, [item.entry.id]: event.target.value })}>{!item.duplicateId && <option value="add">新增</option>}<option value="skip">跳过</option>{item.duplicateId && <option value="update">更新重复项</option>}</select></div>)}</div>
        {preview.errors.length > 0 && <details><summary>查看无效条目（不会导入）</summary>{preview.errors.map((text, index) => <p key={index}>{text}</p>)}</details>}
        <footer><button disabled={busy} onClick={() => { setPreview(null); setChoices({}); void client.cancel(); }}>重新选择</button><button className="auth-primary" disabled={busy || !preview.items.length || !Object.values(choices).some((value) => value !== "skip")} onClick={() => void action(async () => { const result = await client.confirmImport(preview.token, preview.items.map((item) => ({ id: item.entry.id, action: choices[item.entry.id] || "skip" }))); closeModal(); await refresh(); setMessage(`导入完成：新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}`); })}>{busy ? "导入中…" : "确认导入"}</button></footer>
      </>}{error && <p className="auth-error" role="alert">{error}</p>}</Modal>}
    {modal === "export" && <Modal title="导出验证码" busy={busy} close={closeModal}><form onSubmit={(event) => { event.preventDefault(); if (exportFormat !== "plain" && exportPassword !== exportRepeat) { setError("两次导出密码不一致"); return; } const input = { ids: exportIds, format: exportFormat, password: exportPassword, acknowledgePlain }; setExportPassword(""); setExportRepeat(""); void action(async () => { const path = await client.export(input); if (path) { closeModal(); setMessage(`已导出 ${input.ids.length} 项：${path}`); } }); }}>
      <p>导出{selected.size ? "所选" : "全部"} {exportIds.length} 项。建议使用新文件名保存备份。</p><label>导出格式<select value={exportFormat} onChange={(event) => { setExportFormat(event.target.value as typeof exportFormat); setAcknowledgePlain(false); }}><option value="cloudhub">CloudHub 完整加密备份（推荐）</option><option value="ente">Ente 兼容加密文件</option><option value="plain">Ente / OTP 明文文件</option></select></label>
      <p className="auth-hint">{exportFormat === "cloudhub" ? "保留验证码、分组、备注、置顶和排序，可在另一台设备导入。" : "兼容迁移保留 OTP 参数；CloudHub 分组、备注、置顶及排序不会保留。"}</p>
      {exportFormat !== "plain" ? <div className="auth-form-grid"><label>导出密码<input required type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} /></label><label>确认导出密码<input required type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={exportRepeat} onChange={(event) => setExportRepeat(event.target.value)} /></label></div> : <label className="auth-checkbox auth-error"><input type="checkbox" required checked={acknowledgePlain} onChange={(event) => setAcknowledgePlain(event.target.checked)} />我了解明文文件包含长期 OTP 密钥，持有者可以生成验证码。</label>}
      {error && <p className="auth-error" role="alert">{error}</p>}<footer><button disabled={busy} type="button" onClick={closeModal}>取消</button><button disabled={busy} className="auth-primary" type="submit">{busy ? "导出中…" : "选择位置并导出"}</button></footer>
    </form></Modal>}
    {modal === "delete" && <Modal title="删除验证码" busy={busy} close={closeModal}><p>确定删除所选 {selected.size} 个验证码？删除后需通过备份或服务商重新配置恢复。</p>{error && <p role="alert" className="auth-error">{error}</p>}<footer><button disabled={busy} onClick={closeModal}>取消</button><button disabled={busy} className="auth-danger" onClick={() => void action(async () => { await client.remove([...selected]); closeModal(); await refresh(); setMessage("所选验证码已删除"); })}>确认删除</button></footer></Modal>}
  </section>;
}
