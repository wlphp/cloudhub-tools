import { DialogField } from "../../shared/DialogForm";
import { ExportChecklist } from "../../shared/ExportSelection";
import { SharedDialog } from "../../shared/SharedDialog";
import { GroupNameInput } from "../../shared/GroupNameInput";
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { Check, Copy, Download, Edit3, Eye, EyeOff, Grid2X2, KeyRound, List, LockKeyhole, Plus, Search, ShieldCheck, Star, Trash2, Upload } from "lucide-react";
import { PaginationBar, PAGE_SIZE_OPTIONS } from "../../shared/PaginationBar";
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

type AuthKind = AuthInput["kind"];
type AuthAlgorithm = AuthInput["algorithm"];
const DEFAULT_OTP_PARAMS = { kind: "totp" as AuthKind, algorithm: "SHA1" as AuthAlgorithm, digits: 6, period: 30 };
// 主流服务商均按 RFC 6238 默认参数（SHA1 / 6 位 / 30 秒）签发 otpauth 地址；扫描或粘贴二维码时会自动带入真实参数。
const matchesIssuer = (issuer: string, names: readonly string[]) => {
  const value = issuer.trim().toLowerCase().replace(/\s+/g, " ");
  return names.some((name) => value === name || value.startsWith(`${name} `) || value.endsWith(` ${name}`));
};
function otpPreset(issuer: string): string {
  if (matchesIssuer(issuer, ["steam", "steam guard", "steamguard"])) return "Steam Guard（5 位字母数字，固定 SHA1 / 30 秒）";
  if (matchesIssuer(issuer, ["google", "google.com", "gmail", "github", "github.com", "gh", "openai", "openai.com", "chatgpt", "microsoft", "microsoft.com", "microsoft account", "azure", "azure ad", "office365", "office 365", "outlook", "live", "oracle", "oracle.com", "oracle cloud", "oci", "apple", "apple id", "icloud", "amazon", "aws", "amazon web services", "cloudflare", "facebook", "meta", "x", "twitter", "discord", "slack", "dropbox", "gitlab", "bitbucket", "digitalocean", "aliyun", "alibaba cloud", "腾讯云", "腾讯", "tencent", "华为云", "huawei cloud", "heroku", "npm"])) return "主流服务商（Google、GitHub、OpenAI、Microsoft、Oracle 等）默认 SHA1 / 6 位 / 30 秒";
  return "";
}

function Modal({ title, children, close, busy, mobileForm = false, footer, onSubmit }: { title: string; children: ReactNode; close: () => void; busy: boolean; mobileForm?: boolean; footer?: ReactNode; onSubmit?: (event: FormEvent<HTMLFormElement>) => void }) {
  return <SharedDialog title={title} size="small" className={`auth-dialog${mobileForm ? " auth-dialog-mobile-form" : ""}`} bodyClassName={mobileForm ? "auth-mobile-form-body" : ""} closeLabel="关闭对话框" closeDisabled={busy} busy={busy} onClose={close} footer={footer} onSubmit={onSubmit}>{children}</SharedDialog>;
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
  const [pageSize, setPageSize] = useState(100);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<AuthInput | null>(null);
  const [modal, setModal] = useState<"import" | "export" | "delete" | null>(null);
  const [uriText, setUriText] = useState("");
  const [preview, setPreview] = useState<AuthPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [exportFormat, setExportFormat] = useState<"cloudhub" | "plain">("cloudhub");
  const [acknowledgePlain, setAcknowledgePlain] = useState(false);
  const [copied, setCopied] = useState("");
  const [copyNotice, setCopyNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const [showDraftSecret, setShowDraftSecret] = useState(false);
  const [savedSecret, setSavedSecret] = useState("");
  const [revealingSecret, setRevealingSecret] = useState(false);
  const secretRequest = useRef(0);
  const secretRevealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideDraftSecret = useCallback(() => {
    ++secretRequest.current;
    if (secretRevealTimer.current) { clearTimeout(secretRevealTimer.current); secretRevealTimer.current = null; }
    setShowDraftSecret(false);
    setSavedSecret("");
    setRevealingSecret(false);
  }, []);
  const toggleDraftSecret = useCallback(async () => {
    if (showDraftSecret) { hideDraftSecret(); return; }
    if (!draft || revealingSecret) return;
    const request = ++secretRequest.current;
    setError("");
    try {
      if (draft.id && !draft.secret) {
        setRevealingSecret(true);
        const secret = await client.revealSecret(draft.id);
        if (request !== secretRequest.current) return;
        setSavedSecret(secret);
      }
      if (request !== secretRequest.current) return;
      setShowDraftSecret(true);
      secretRevealTimer.current = setTimeout(hideDraftSecret, 15_000);
    } catch {
      if (request === secretRequest.current) setError(runningInTauri ? "读取已保存密钥失败，请确认密码库已解锁后重试" : "查询已保存密钥仅支持 CloudHub 原生客户端");
    } finally {
      if (request === secretRequest.current) setRevealingSecret(false);
    }
  }, [draft, revealingSecret, showDraftSecret, hideDraftSecret]);
  useEffect(() => {
    hideDraftSecret();
    return () => { ++secretRequest.current; if (secretRevealTimer.current) clearTimeout(secretRevealTimer.current); };
  }, [draft?.id, hideDraftSecret]);
  useEffect(() => {
    const hideWhenBackground = () => { if (document.visibilityState === "hidden") hideDraftSecret(); };
    window.addEventListener("blur", hideDraftSecret);
    document.addEventListener("visibilitychange", hideWhenBackground);
    return () => { window.removeEventListener("blur", hideDraftSecret); document.removeEventListener("visibilitychange", hideWhenBackground); };
  }, [hideDraftSecret]);
  const otpPresetHint = useMemo(() => draft ? otpPreset(draft.issuer) : "", [draft?.issuer]);
  const otpParamsDiffer = !!draft && (draft.kind !== DEFAULT_OTP_PARAMS.kind || draft.algorithm !== DEFAULT_OTP_PARAMS.algorithm || draft.digits !== DEFAULT_OTP_PARAMS.digits || (draft.kind !== "hotp" && draft.period !== DEFAULT_OTP_PARAMS.period));
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
    setUriText("");
    setCopied(""); setCopyNotice(null); if (copyTimer.current) clearTimeout(copyTimer.current);
    hideDraftSecret();
  }, [hideDraftSecret]);
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
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
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
    setModal(null); setPreview(null); setChoices({}); setUriText("");
    setAcknowledgePlain(false);
  }
  async function prepare(qr: boolean, text?: string, image?: number[]) {
    setUriText("");
    await action(async () => {
      const data = await client.prepare({ qr, text, image });
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
  const exportIds = entries.filter(entry => selected.has(entry.id)).map(entry => entry.id);
  const alerts = <>{error && !modal && !draft && <div className="auth-alert auth-error" role="alert">{error}</div>}{message && <div className="auth-alert" role="status">{message}</div>}</>;

  const panelClassName = `auth-panel${mobile ? " auth-mobile" : ""}`;
  if (loading) return <section className={panelClassName}><p role="status">正在读取验证器状态…</p></section>;
  if (!unlocked) return <section className={panelClassName}><h2><ShieldCheck size={22} /> {mobile ? "身份验证器" : "验证器"}</h2>{passwordRequired ? <><>{alerts}</><form className="auth-unlock" onSubmit={(event) => void unlock(event)}>
    <LockKeyhole size={38} /><h3>迁移已有验证器</h3><p>已有数据由旧主密码加密。输入一次原密码后，改为打开即用，验证码保持不变。</p>
    <DialogField label="原主密码"><input type="password" autoComplete="current-password" autoFocus required maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} /></DialogField>
    <button className="auth-primary" disabled={busy} type="submit">{busy ? "正在迁移…" : "迁移并打开"}</button>
  </form></> : <div className="auth-empty auth-unavailable" role="status"><span className="auth-empty-icon" aria-hidden="true"><ShieldCheck size={30} /></span><h3>验证器暂时不可用</h3><p>{error || "本地服务未连接，请确认移动端调试服务已启动。"}</p><button disabled={busy} onClick={() => void action(openVault)}>{busy ? "连接中…" : "重新连接"}</button></div>}</section>;

  return <section className={panelClassName} onPointerDown={touch} onKeyDown={touch}>
    {copyNotice && <div className="toast-notice auth-copy-toast" role={copyNotice.failed ? "alert" : "status"} aria-atomic="true">{!copyNotice.failed && <Check size={16} aria-hidden="true" />}<span>{copyNotice.text}</span></div>}
    <div className="auth-header"><div><h2><ShieldCheck size={22} /> {mobile ? "身份验证器" : "验证器"}</h2><span>{entries.length} 个验证码 · 本地加密保存</span></div><div className="auth-actions">
      <button disabled={busy} onClick={() => { hideDraftSecret(); setDraft(emptyDraft()); setError(""); }}><Plus size={16} /> 新增</button>
      <button disabled={busy} onClick={() => { setModal("import"); setError(""); }}><Upload size={16} /> 导入</button>
      <button disabled={busy || !entries.length} onClick={() => { setModal("export"); setError(""); }}><Download size={16} /> {selected.size ? `导出所选（${selected.size}）` : "选择导出"}</button>
    </div></div>{alerts}
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
          <button aria-label={`编辑 ${entry.account}`} onClick={() => { hideDraftSecret(); setDraft({ ...entry, secret: "" }); setError(""); }}><Edit3 size={15} /></button>
          <ProviderIcon issuer={entry.issuer} />
        </div><div className="auth-account"><span>{entry.account || "未指定账户"}</span><button className="auth-copy-account" aria-label={`复制账号 ${entry.account}`} title="复制账号" disabled={busy || !entry.account} onClick={() => void copyCode(entry, "account")}>{copied === `${entry.id}:account` ? <Check size={14} /> : <Copy size={14} />}</button></div></div>
        <div className="auth-code-row"><button className="auth-code" aria-label={`复制 ${entry.account} 验证码`} title="复制当前验证码" disabled={busy || !code} onClick={() => void copyCode(entry)}>{displayCode(code?.current)}{copied === `${entry.id}:current` ? <Check size={15} /> : <Copy size={15} />}</button>
          {entry.kind !== "hotp" && <div className="auth-next"><span>下一个</span><button aria-label={`复制 ${entry.account} 下一个验证码`} title="复制下一个验证码" disabled={busy || !code?.next} onClick={() => void copyCode(entry, "next")}><strong>{displayCode(code?.next ?? undefined)}</strong>{copied === `${entry.id}:next` ? <Check size={13} /> : <Copy size={13} />}</button></div>}
        </div>
        <div className="auth-card-footer"><span>{entry.group}{entry.note && <span title={entry.note}>{entry.group ? " · " : ""}{entry.note}</span>}</span>{entry.kind === "hotp" ? <button disabled={busy} onClick={() => void action(async () => { await client.advance(entry.id); await refresh(); setCodes({}); })}>下一码 · 计数 {entry.counter}</button> : <span>{code ? `${code.remaining} 秒` : "计算中…"}</span>}</div>
        {entry.kind !== "hotp" && <div className="auth-progress" role="progressbar" aria-label={`${entry.account} 剩余时间`} aria-valuemin={0} aria-valuemax={entry.period} aria-valuenow={code?.remaining ?? 0}><i style={{ transform: `scaleX(${code ? code.remaining / code.period : 0})` }} /></div>}
      </article>; })}
    </div>}
    {filtered.length > 0 && <PaginationBar className="auth-pagination" page={safePage} pageSize={pageSize} total={filtered.length} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} pageSizeOptions={[...PAGE_SIZE_OPTIONS, 100]} />}

    {draft && <Modal title={draft.id ? "编辑验证码" : "新增验证码"} busy={busy} mobileForm={mobile} close={() => { hideDraftSecret(); setDraft(null); setError(""); }} onSubmit={(event) => { event.preventDefault(); const input = draft; hideDraftSecret(); setDraft({ ...draft, secret: "" }); void action(async () => { await client.save(input); setDraft(null); await refresh(); setMessage("验证码已保存"); }); }} footer={<><button type="button" className="secondary" disabled={busy} onClick={() => { hideDraftSecret(); setDraft(null); }}>取消</button><button className="primary" disabled={busy} type="submit">{busy ? "保存中…" : "保存"}</button></>}>
      <div className="auth-form-grid"><DialogField label="服务商"><input maxLength={256} value={draft.issuer} onChange={(event) => setDraft({ ...draft, issuer: event.target.value })} /></DialogField><DialogField label="账户"><input maxLength={512} value={draft.account} onChange={(event) => setDraft({ ...draft, account: event.target.value })} /></DialogField></div>
      <DialogField label={draft.id ? "OTP 密钥（留空保留原密钥）" : "OTP 密钥"} controlAction={<button type="button" className="auth-secret-eye" disabled={revealingSecret} aria-busy={revealingSecret} aria-label={showDraftSecret ? "隐藏 OTP 密钥" : "显示 OTP 密钥"} aria-pressed={showDraftSecret} title={showDraftSecret ? "隐藏密钥（15 秒后自动清除）" : draft.id && !draft.secret ? "查询已保存密钥" : "显示密钥"} onClick={() => void toggleDraftSecret()}>{showDraftSecret ? <EyeOff size={17} /> : <Eye size={17} />}</button>}><input type={showDraftSecret ? "text" : "password"} autoComplete="off" spellCheck={false} required={!draft.id} maxLength={1024} value={savedSecret || draft.secret || ""} readOnly={!!savedSecret || revealingSecret} onChange={(event) => { setSavedSecret(""); setDraft({ ...draft, secret: event.target.value }); }} /></DialogField>
      {draft.id && <small>{revealingSecret ? "正在读取已保存密钥…" : savedSecret ? "已保存密钥只读显示，15 秒后自动清除；隐藏后可输入新密钥。" : "点击眼睛可查询已保存密钥；输入新密钥会在保存后替换原密钥。"}</small>}
      {otpPresetHint && <p className="auth-hint auth-otp-preset">已识别：{otpPresetHint}。按默认参数保存即可；如服务商另有设置，以它给出的参数为准。</p>}
      <div className="auth-form-grid"><DialogField label="类型"><select value={draft.kind} onChange={(event) => { const kind = event.target.value as AuthInput["kind"]; setDraft({ ...draft, kind, digits: kind === "steam" ? 5 : 6, algorithm: "SHA1", period: 30 }); }}><option value="totp">TOTP（时间）</option><option value="hotp">HOTP（计数）</option><option value="steam">Steam</option></select></DialogField><DialogField label="算法"><select disabled={draft.kind === "steam"} value={draft.algorithm} onChange={(event) => setDraft({ ...draft, algorithm: event.target.value as AuthInput["algorithm"] })}>{["SHA1", "SHA256", "SHA512"].map((value) => <option key={value} value={value}>{value === "SHA1" ? "SHA1（默认）" : value}</option>)}</select></DialogField>
      <DialogField label="位数"><select disabled={draft.kind === "steam"} value={draft.digits} onChange={(event) => setDraft({ ...draft, digits: Number(event.target.value) })}>{(draft.kind === "steam" ? [5] : [6, 7, 8]).map((value) => <option key={value}>{value}</option>)}</select></DialogField><DialogField label={draft.kind === "hotp" ? "计数" : "周期（秒）"}><input type={draft.kind === "hotp" ? "text" : "number"} inputMode="numeric" pattern={draft.kind === "hotp" ? "[0-9]{1,20}" : undefined} min={1} max={3600} disabled={draft.kind === "steam"} value={draft.kind === "hotp" ? draft.counter : draft.period} onChange={(event) => setDraft({ ...draft, [draft.kind === "hotp" ? "counter" : "period"]: draft.kind === "hotp" ? event.target.value : Number(event.target.value) })} /></DialogField>
      <DialogField label="分组"><GroupNameInput groups={groups} maxLength={128} list="auth-group-options" value={draft.group} onChange={(event) => setDraft({ ...draft, group: event.target.value })} /></DialogField><DialogField label="排序序号"><input type="number" min={-2147483648} max={2147483647} value={draft.order} onChange={(event) => setDraft({ ...draft, order: Number(event.target.value) })} /></DialogField></div>
      <details className="auth-otp-tips"><summary>算法、位数和周期怎么填？</summary><div>
        <p>这三项必须与服务商给出的参数完全一致，填错会持续生成无效验证码。加密算法（SHA1 / SHA256 / SHA512）、位数和周期由服务商在签发时决定，和账户类型无关，同一服务商不同账户也可能不同。</p>
        <p>绝大多数服务商（Google、GitHub、OpenAI、Microsoft、Oracle、阿里云等）默认 <strong>SHA1 · 6 位 · 30 秒</strong>；Steam 固定为 5 位字母数字；个别企业或自建系统使用 8 位、60 秒或 SHA256 / SHA512。</p>
        <p>建议扫描或粘贴服务商提供的 otpauth 二维码，CloudHub 会自动识别这些参数，无需手动填写。</p>
        {otpParamsDiffer && <p className="auth-otp-warn">当前参数不是默认值，请确认服务商页面/二维码中的设置与之一致。</p>}
      </div></details>
      <DialogField label="备注"><textarea maxLength={4096} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></DialogField><label className="auth-checkbox"><input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} />置顶</label>
      {error && <p className="auth-error" role="alert">{error}</p>}
    </Modal>}
    {modal === "import" && <Modal title="导入验证码" busy={busy} close={closeModal} footer={preview ? <><button type="button" className="secondary" disabled={busy} onClick={() => { setPreview(null); setChoices({}); void client.cancel(); }}>重新选择</button><button type="button" className="primary" disabled={busy || !preview.items.length || !Object.values(choices).some((value) => value !== "skip")} onClick={() => void action(async () => { const result = await client.confirmImport(preview.token, preview.items.map((item) => ({ id: item.entry.id, action: choices[item.entry.id] || "skip" }))); closeModal(); await refresh(); setMessage(`导入完成：新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}`); })}>{busy ? "导入中…" : "确认导入"}</button></> : undefined}>
      {!preview ? <><p>支持无口令 CloudHub 完整备份、Ente / OTP 明文文件及 OTP 二维码。旧版加密文件请先用原口令解密后再导入。</p>
        <div className="auth-import-buttons">{mobile && runningInTauri && <button disabled={busy} onClick={() => void scanOtp()}><Grid2X2 size={16} />扫描二维码</button>}<button disabled={busy} onClick={() => void prepare(false)}><Upload size={16} />选择导入文件</button><button disabled={busy} onClick={() => void prepare(true)}><Grid2X2 size={16} />选择二维码图片</button></div>
        <DialogField label="粘贴 OTP 地址或二维码图片"><textarea autoComplete="off" maxLength={1048576} placeholder="otpauth://…（支持多行），也可在此粘贴图片" value={uriText} onPaste={(event) => void pasteImage(event)} onChange={(event) => setUriText(event.target.value)} /></DialogField><button disabled={busy || !uriText.trim()} onClick={() => void prepare(false, uriText)}>解析粘贴内容</button><small>密钥只在原生进程解析；预览不显示密钥。</small></> : <>
        <p>{preview.format} · 有效 {preview.items.length} 项 · 无效 {preview.errors.length} 项</p><div className="auth-import-preview">{preview.items.map((item) => <div className="auth-import-row" key={item.entry.id}><div><strong>{item.entry.issuer} · {item.entry.account}</strong><span>{item.entry.kind.toUpperCase()} · {item.entry.algorithm} · {item.entry.digits} 位{item.entry.kind === "hotp" ? ` · 计数 ${item.entry.counter}` : ` · ${item.entry.period} 秒`}</span><small>{item.duplicateId ? "相同密钥和参数" : item.conflict ? "同名账户，密钥不同，将作为独立条目" : "新增"}{item.conflict && item.duplicateId ? " · 计数有差异" : ""}</small></div><select aria-label={`导入操作 ${item.entry.account}`} value={choices[item.entry.id]} onChange={(event) => setChoices({ ...choices, [item.entry.id]: event.target.value })}>{!item.duplicateId && <option value="add">新增</option>}<option value="skip">跳过</option>{item.duplicateId && <option value="update">更新重复项</option>}</select></div>)}</div>
        {preview.errors.length > 0 && <details><summary>查看无效条目（不会导入）</summary>{preview.errors.map((text, index) => <p key={index}>{text}</p>)}</details>}
      </>}{error && <p className="auth-error" role="alert">{error}</p>}</Modal>}
    {modal === "export" && <Modal title="导出验证码" busy={busy} close={closeModal} onSubmit={(event) => { event.preventDefault(); const input = { ids: exportIds, format: exportFormat, acknowledgePlain }; void action(async () => { const path = await client.export(input); if (path) { closeModal(); setMessage(`已导出 ${input.ids.length} 项：${path}`); } }); }} footer={<><button type="button" className="secondary" disabled={busy} onClick={closeModal}>取消</button><button disabled={busy || !exportIds.length} className="primary" type="submit">{busy ? "导出中…" : "选择位置并导出"}</button></>}>
      <ExportChecklist items={entries.map(entry => ({ id: entry.id, label: [entry.issuer, entry.account].filter(Boolean).join(' · ') }))} selected={exportIds} disabled={busy} onChange={ids => setSelected(new Set(ids))} /><p>导出所选 {exportIds.length} 项。建议使用新文件名保存备份。</p><DialogField label="导出格式"><select value={exportFormat} onChange={(event) => { setExportFormat(event.target.value as typeof exportFormat); setAcknowledgePlain(false); }}><option value="cloudhub">CloudHub 完整备份（无口令，推荐）</option><option value="plain">Ente / OTP 明文迁移文件</option></select></DialogField>
      <p className="auth-hint">{exportFormat === "cloudhub" ? "保留验证码、分组、备注、置顶和排序，可在另一台设备导入。" : "兼容迁移保留 OTP 参数；CloudHub 分组、备注、置顶及排序不会保留。"} 文件包含长期 OTP 密钥，请妥善保管。</p>
      <label className="auth-checkbox auth-error"><input type="checkbox" required checked={acknowledgePlain} onChange={(event) => setAcknowledgePlain(event.target.checked)} />我了解备份文件未加密，持有者可以生成验证码。</label>
      {error && <p className="auth-error" role="alert">{error}</p>}
    </Modal>}
    {modal === "delete" && <Modal title="删除验证码" busy={busy} close={closeModal} footer={<><button type="button" className="secondary" disabled={busy} onClick={closeModal}>取消</button><button type="button" className="danger" disabled={busy} onClick={() => void action(async () => { await client.remove([...selected]); closeModal(); await refresh(); setMessage("所选验证码已删除"); })}>确认删除</button></>}><p>确定删除所选 {selected.size} 个验证码？删除后可在系统设置的回收站恢复。</p>{error && <p role="alert" className="auth-error">{error}</p>}</Modal>}
  </section>;
}
