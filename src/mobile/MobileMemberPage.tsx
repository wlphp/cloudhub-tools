import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Clock3, ExternalLink, KeyRound, LogOut, Mail, Pencil, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { MemberAvatar } from "../features/member/MemberDialog";
import { memberClient, type Member, type MemberLoginRecord } from "../platform/clients/member";
import { runningInTauri } from "../platform/api";

function beijingTime(value: string) {
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function MobileMemberPage({ member, onMember, onBack, onOpenCenter, onNotice }: { member: Member | null; onMember: (member: Member | null) => void; onBack: () => void; onOpenCenter: () => Promise<void>; onNotice: (message: string) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [logs, setLogs] = useState<MemberLoginRecord[]>([]);
  const [logsError, setLogsError] = useState("");
  const [nickname, setNickname] = useState(member?.nickname ?? "");
  const [editingNickname, setEditingNickname] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setNickname(member?.nickname ?? ""); }, [member?.nickname]);
  useEffect(() => { if (!remaining) return; const timer = window.setTimeout(() => setRemaining(value => Math.max(0, value - 1)), 1000); return () => window.clearTimeout(timer); }, [remaining]);
  useEffect(() => {
    if (!member) { setLogs([]); return; }
    let active = true;
    void memberClient.loginLogs(1).then(items => { if (active) { setLogs(items); setLogsError(""); } }).catch(reason => { if (active) setLogsError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [member]);
  const handleLogin = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { onMember(await memberClient.login(email.trim(), code)); onNotice("登录成功"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    if (refreshing) return; setRefreshing(true);
    try { const latest = await memberClient.me(); onMember(latest); onNotice(latest ? "会员信息已刷新" : "登录状态已失效，请重新登录"); }
    catch (reason) { onNotice(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRefreshing(false); }
  };
  const saveNickname = async (event: FormEvent) => {
    event.preventDefault(); if (!nickname.trim() || busy) return; setBusy(true); setError("");
    try { onMember(await memberClient.nickname(nickname.trim())); setEditingNickname(false); onNotice("昵称已更新"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try { const revoked = await memberClient.logout(); onMember(null); onNotice(revoked ? "已退出登录，本机云资源数据保留。" : "已清除本机登录；远端退出失败，可在官网登录设备中撤销会话。"); }
    catch (reason) { onNotice(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="mobile-member-page">
    <header className="mobile-member-heading"><button type="button" className="mobile-member-back" onClick={onBack} aria-label="返回更多管理"><ArrowLeft size={19} /></button><div><p>账户与身份</p><h1>会员管理</h1></div></header>
    {member ? <>
      <section className="mobile-member-hero">
        <div className="mobile-member-hero-top"><span className="mobile-member-avatar"><MemberAvatar member={member} size={52} /></span><div className="mobile-member-identity"><div className="mobile-member-name">{member.nickname.trim() || member.email}{member.is_vip && <span className="member-vip-badge">VIP</span>}{member.is_admin && <span className="member-admin-badge">管理员</span>}</div><span>{member.email}</span></div><button type="button" className="mobile-member-refresh" aria-label="刷新会员信息" title="刷新会员信息" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={17} className={refreshing ? "mobile-spin" : ""} /></button></div>
        <div className="mobile-member-stats"><div><span>会员编号</span><strong>#{member.id}</strong></div><div><span>注册时间</span><strong>{beijingTime(member.created_at)}</strong></div></div>
        {!editingNickname ? <button type="button" className="mobile-member-edit" onClick={() => { setNickname(member.nickname); setError(""); setEditingNickname(true); }}><Pencil size={15} />修改昵称</button> : <form className="mobile-member-nickname" onSubmit={event => void saveNickname(event)}><label htmlFor="mobile-member-nickname">修改昵称</label><div><input id="mobile-member-nickname" value={nickname} maxLength={20} required disabled={busy} onChange={event => setNickname(event.target.value)} /><button type="submit" disabled={busy || !nickname.trim() || nickname.trim() === member.nickname}>{busy ? "保存中" : "保存"}</button><button type="button" disabled={busy} onClick={() => { setNickname(member.nickname); setEditingNickname(false); }}>取消</button></div>{error && <p className="mobile-member-error" role="alert">{error}</p>}</form>}
      </section>
      <section className="mobile-member-section"><div className="mobile-member-section-title"><span className="mobile-member-section-icon"><Clock3 size={17} /></span><div><h2>最近登录</h2><p>最近 20 条安全记录 · 北京时间</p></div></div>
        {logsError ? <p className="mobile-member-empty" role="alert">{logsError}</p> : logs.length ? <div className="mobile-member-logs">{logs.map((record, index) => <article key={`${record.created_at}-${index}`}><span className={`mobile-member-log-dot ${record.result === "success" ? "ok" : "failed"}`} aria-hidden="true" /><div><strong>{record.event === "login" ? "登录" : record.event === "register" ? "注册" : record.event === "logout" ? "退出登录" : "发送验证码"}</strong><small>{beijingTime(record.created_at)} · {record.client_type === "native" ? "客户端" : "网站"}</small></div><span className={record.result === "success" ? "mobile-member-result-ok" : "mobile-member-result-failed"}>{record.result === "success" ? "成功" : "失败"}</span></article>)}</div> : <p className="mobile-member-empty">暂无登录记录</p>}
      </section>
      <div className="mobile-member-actions"><button type="button" className="mobile-member-site" onClick={() => void onOpenCenter().catch(reason => onNotice(`打开会员中心失败：${reason instanceof Error ? reason.message : String(reason)}`))}><ExternalLink size={17} />官网会员中心</button><button type="button" className="mobile-member-logout" disabled={busy} onClick={() => void logout()}><LogOut size={17} />{busy ? "处理中…" : "退出登录"}</button></div>
    </> : <>
      <section className="mobile-member-login-intro"><span><UserRound size={25} /></span><h2>登录会员账号</h2><p>同步昵称、头像与会员身份。本机云资源与凭据始终保存在本机。</p></section>
      <form className="mobile-member-login" onSubmit={event => void handleLogin(event)}>
        <label htmlFor="mobile-member-email">邮箱</label><div className="mobile-member-input"><Mail size={17} aria-hidden="true" /><input id="mobile-member-email" type="email" autoComplete="email" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} placeholder="输入你的邮箱" /></div>
        <label htmlFor="mobile-member-code">邮箱验证码</label><div className="mobile-member-input"><KeyRound size={17} aria-hidden="true" /><input id="mobile-member-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={busy} onChange={event => setCode(event.target.value)} placeholder="6 位验证码" /><button type="button" disabled={busy || remaining > 0 || !runningInTauri} onClick={async () => { const field = document.getElementById("mobile-member-email") as HTMLInputElement | null; if (!field?.reportValidity()) return; setBusy(true); setError(""); try { setRemaining(await memberClient.sendCode(email.trim())); onNotice("验证码已发送，请检查收件箱和垃圾邮件。"); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }}>{remaining ? `${remaining} 秒` : "获取验证码"}</button></div>
        {error && <p className="mobile-member-error" role="alert">{error}</p>}
        {!runningInTauri && <p className="mobile-member-error">当前为浏览器预览，请使用原生客户端登录。</p>}
        <p className="mobile-member-security"><ShieldCheck size={16} />新邮箱验证后自动注册 · 无需密码</p>
        <button type="submit" className="mobile-member-submit" disabled={busy || !runningInTauri}>{busy ? "正在登录…" : "登录 / 注册"}</button>
      </form>
    </>}
  </div>;
}
