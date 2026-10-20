import { useEffect, useRef, useState } from "react";
import { Copy, Eye, EyeOff, ExternalLink } from "lucide-react";
import { codexClient, type CodexAccount, type CodexAccountDetailView } from "../../platform/clients/codex";
import { OverviewDialog } from "./OverviewDialogs";

export function AccountDetailsDialog({ account, onClose, onChanged }: { account: CodexAccount; onClose: () => void; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<CodexAccountDetailView | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const alive = useRef(true);
  const pending = useRef(false);
  const expiry = (value: number | null | undefined) => {
    if (!value) return "未提供";
    const difference = value - now;
    const totalMinutes = difference > 0 ? Math.ceil(difference / 60) : Math.floor(-difference / 60);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const remaining = `${difference > 0 ? "还剩" : "已过期"} ${days} 天 ${hours} 小时 ${minutes} 分钟`;
    return <>{new Date(value * 1000).toLocaleString("zh-CN")}<small className={difference <= 0 ? "codex-expiry-past" : undefined}>{remaining}</small></>;
  };
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { alive.current = true; void codexClient.accountDetails(account.id).then(value => { if (alive.current) setData(value); }).catch(() => { if (alive.current) setError("读取账号资料失败，请关闭后重试"); }); return () => { alive.current = false; }; }, [account.id]);
  async function run(action: () => Promise<void>) {
    if (pending.current) return; pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch { if (alive.current) setError("操作失败，请重新打开确认资料未被其他操作修改后重试"); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function copy(value: string) { await navigator.clipboard.writeText(value); if (alive.current) setNotice("已复制"); }
  const secretNames: Record<string, string> = { access_token: "Access Token（AT）", refresh_token: "Refresh Token（RT）", id_token: "ID Token", api_key: "API Key" };
  const field = (key: "email" | "password" | "twoFactor" | "mailUrl" | "phone", label: string, placeholder: string, sensitive = false) => {
    const value = data?.details[key] ?? "";
    return <label className="codex-detail-field">{label}<span><input aria-label={label} autoComplete="off" spellCheck={false} type={sensitive && !visible[key] ? "password" : "text"} placeholder={placeholder} value={value} maxLength={key === "email" ? 254 : key === "phone" ? 80 : key === "mailUrl" ? 2048 : 4096} disabled={busy || !data} onChange={event => setData(current => current ? { ...current, details: { ...current.details, [key]: event.target.value } } : current)} />{sensitive && <button type="button" disabled={busy} aria-label={(visible[key] ? "隐藏" : "显示") + label} onClick={() => setVisible(v => ({ ...v, [key]: !v[key] }))}>{visible[key] ? <EyeOff size={15} /> : <Eye size={15} />}</button>}{key === "mailUrl" && <button type="button" disabled={busy || !(value.startsWith("https://") || value.startsWith("http://"))} aria-label="打开邮件地址" onClick={() => void run(async () => { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); const { openUrl } = await import("@tauri-apps/plugin-opener"); await openUrl(url.href); })}><ExternalLink size={15} /></button>}<button type="button" disabled={busy || !value} aria-label={"复制" + label} onClick={() => void run(() => copy(value))}><Copy size={15} /></button></span></label>;
  };
  return <OverviewDialog title="Codex 账号信息" eyebrow="ACCOUNT" className="codex-account-detail-dialog" busy={busy} dismissWhileBusy onClose={onClose} footer={<div className="codex-detail-footer"><span>{notice}</span><button onClick={onClose}>关闭</button><button disabled={busy || !data} onClick={() => void run(async () => { if (!data) return; await codexClient.saveAccountDetails(account.id, data.version, data.details); if (!alive.current) return; await onChanged(); const next = await codexClient.accountDetails(account.id); if (alive.current) { setData(next); setNotice("账号资料已加密保存"); } })}>保存资料</button></div>}>
    <dl className="codex-account-details"><dt>账号</dt><dd>{account.label}</dd><dt>登录邮箱</dt><dd>{account.email ?? "未提供"}</dd><dt>登录方式</dt><dd>{account.authMode === "chatgpt" ? "ChatGPT 登录" : "API Key"}</dd><dt>套餐</dt><dd>{account.plan?.toUpperCase() ?? "未知"}</dd><dt>工作区</dt><dd>{account.accountId ?? "未提供"}</dd><dt>用户 ID</dt><dd>{data?.auth.userId ?? "未提供"}</dd><dt>标签</dt><dd>{account.tags.join("、") || "无"}</dd><dt>备注</dt><dd>{account.note || "无"}</dd><dt>订阅到期</dt><dd>{expiry(account.benefits?.expiresAt)}</dd><dt>重置次数</dt><dd>{account.benefits?.resetCredits ?? "未提供"}</dd><dt>AT 到期</dt><dd>{expiry(data?.auth.accessExpiresAt)}</dd><dt>RT 到期</dt><dd>{data?.auth.hasRefreshToken ? expiry(data.auth.refreshExpiresAt) : "无 Refresh Token"}</dd><dt>ID Token 到期</dt><dd>{expiry(data?.auth.idExpiresAt)}</dd><dt>认证刷新</dt><dd>{data?.lastRefresh ?? "未提供"}</dd><dt>资料更新</dt><dd>{new Date(account.updatedAt).toLocaleString("zh-CN")}</dd><dt>额度更新</dt><dd>{account.quota.fetchedAt ? new Date(account.quota.fetchedAt).toLocaleString("zh-CN") : "尚未刷新"}</dd><dt>代理</dt><dd>{account.proxyUrl ?? "系统默认"}</dd></dl>
    <section className="codex-detail-section"><h3>登录凭据</h3><p>点击显示可查看完整凭据，复制由桌面端完成。</p>{Object.entries(secretNames).map(([key, label]) => <div className="codex-detail-field" key={key}><span>{label}</span><div className="codex-detail-secret"><textarea aria-label={label} rows={revealed[key] ? 3 : 1} readOnly value={revealed[key] ?? (data?.availableSecrets.includes(key) ? "••••••••••••••••" : "未提供")} spellCheck={false} /><button disabled={busy || !data?.availableSecrets.includes(key)} aria-label={(revealed[key] ? "隐藏" : "显示") + label} onClick={() => { if (revealed[key]) setRevealed(value => { const next = { ...value }; delete next[key]; return next; }); else void run(async () => { const value = await codexClient.accountSecret(account.id, key); if (alive.current && value) setRevealed(current => ({ ...current, [key]: value })); }); }}>{revealed[key] ? <EyeOff size={15} /> : <Eye size={15} />}</button><button disabled={busy || !data?.availableSecrets.includes(key)} aria-label={"复制" + label} onClick={() => void run(async () => { await codexClient.accountSecret(account.id, key, true); if (alive.current) setNotice("已复制" + label); })}><Copy size={15} /></button></div></div>)}</section>
    <section className="codex-detail-section"><h3>账号备注</h3><p>补充密码、2FA、邮件地址、手机号与其他备注，保存到本机加密资料中。</p>{field("email", "邮箱", "账号或辅助邮箱")}{field("password", "账号密码", "登录密码或临时密码", true)}{field("twoFactor", "2FA 秘钥", "Base32 secret 或 otpauth:// 链接", true)}{field("mailUrl", "邮件地址", "邮件查询网页地址")}{field("phone", "手机号", "绑定手机号")}<label className="codex-detail-field">其他备注<textarea aria-label="其他备注" maxLength={8000} rows={4} disabled={busy || !data} value={data?.details.note ?? ""} onChange={event => setData(current => current ? { ...current, details: { ...current.details, note: event.target.value } } : current)} /></label></section>
    {!data && !error && <p role="status">正在读取资料…</p>}{error && <p role="alert" className="codex-card-error">{error}</p>}
  </OverviewDialog>;
}
