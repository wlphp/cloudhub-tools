import { useEffect, useState, type CSSProperties } from "react";
import { History, KeyRound, LogIn, Mail, Pencil, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import { memberClient, type Member, type MemberLoginRecord } from "../../platform/clients/member";
import { runningInTauri } from "../../platform/api";
import "./member.css";

function formatBeijingTime(value: string) {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function MemberAvatar({ member, avatarKey, size = 20 }: { member?: Member | null; avatarKey?: number; size?: number }) {
  const key = avatarKey ?? member?.avatar_key;
  const animal = key && key >= 1 && key <= 12 ? avatarAnimal(key, size) : null;
  return <span className={`app-sidebar-avatar${animal ? " member-avatar member-animal-avatar" : " app-sidebar-avatar-anon"}${animal && member?.is_vip ? " member-avatar-vip" : ""}`} style={animal ? { "--member-avatar-bg": animal.background } as CSSProperties : undefined} aria-hidden="true">{animal ? animal.svg : <UserRound size={size} />}</span>;
}

function avatarAnimal(key: number, size: number) {
  const styles = [
    ["#f4e3d4", "#d98b53", "point"], ["#f5ead2", "#e5b66c", "point"], ["#ebe0d4", "#a78065", "round"],
    ["#f2e1e5", "#fff8f1", "long"], ["#e2e9dd", "#fffaf1", "panda"], ["#dee9ec", "#526772", "penguin"],
    ["#e9e3d6", "#b09a77", "owl"], ["#f1e6d9", "#c49b77", "floppy"], ["#e3e6ed", "#a7adb9", "koala"],
    ["#e5ebd8", "#92b278", "frog"], ["#f5e4d4", "#dfaa61", "tiger"], ["#e8e3ee", "#a59eac", "raccoon"],
  ] as const;
  const [background, fur, type] = styles[key - 1];
  const ink = "#403b38";
  const shapes: React.ReactNode[] = [];
  const circle = (cx: number, cy: number, r: number, fill: string) => shapes.push(<circle key={`c${shapes.length}`} cx={cx} cy={cy} r={r} fill={fill} />);
  const ellipse = (cx: number, cy: number, rx: number, ry: number, fill: string) => shapes.push(<ellipse key={`e${shapes.length}`} cx={cx} cy={cy} rx={rx} ry={ry} fill={fill} />);
  const path = (d: string, fill: string) => shapes.push(<path key={`p${shapes.length}`} d={d} fill={fill} />);
  if (["point", "owl", "raccoon"].includes(type)) {
    path("M13 30 12 10 29 22M35 22 52 10 51 32", fur); path("M17 23 16 16 24 23M40 23 48 16 47 25", "#dca59c");
  } else if (type === "long") {
    ellipse(23,20,7,18,fur); ellipse(41,20,7,18,fur); ellipse(23,17,3,11,"#e6b4b5"); ellipse(41,17,3,11,"#e6b4b5");
  } else if (type === "floppy") {
    ellipse(14,31,8,17,"#9b7558"); ellipse(50,31,8,17,"#9b7558");
  } else if (type !== "penguin") {
    const r = type === "koala" ? 12 : 8, color = type === "panda" ? ink : fur;
    circle(16,21,r,color); circle(48,21,r,color);
    if (type !== "frog") { circle(16,21,r*.55,"#d7b4ab"); circle(48,21,r*.55,"#d7b4ab"); }
  }
  ellipse(32,37,23,21,fur);
  if (type === "penguin") ellipse(32,40,17,18,"#fff8e9");
  if (type === "point" && key === 1) { path("M10 33 30 43 24 55Q12 53 10 33M54 33 34 43 40 55Q52 53 54 33", "#fff4de"); }
  if (["panda","raccoon","owl"].includes(type)) {
    ellipse(23,35,8,type === "raccoon" ? 6 : 9,type === "owl" ? "#f7edda" : "#625c61");
    ellipse(41,35,8,type === "raccoon" ? 6 : 9,type === "owl" ? "#f7edda" : "#625c61");
  }
  if (type === "floppy" || type === "round") ellipse(32,45,12,9,"#ead2b4");
  if (type === "tiger" || key === 2) path("M28 17 31 27 33 27 36 17M10 35 20 38 10 41M54 35 44 38 54 41",type === "tiger" ? "#81613d" : "#bd8a48");
  const eyes = type === "panda" || type === "raccoon" ? "#fffaf1" : ink;
  circle(23,35,2.5,eyes); circle(41,35,2.5,eyes);
  if (type === "koala") ellipse(32,41,5,7,ink);
  else if (type === "penguin" || type === "owl") path("m28 41 8 0-4 6Z","#d49b4b");
  else if (type !== "frog") path("M28 42Q32 39 36 42L32 46Z",ink);
  if (!["penguin","owl","koala"].includes(type)) shapes.push(<path key={`p${shapes.length}`} d={type === "frog" ? "M23 43Q32 51 41 43" : "M27 48Q32 52 37 48"} fill="none" stroke={ink} strokeWidth="1.5" strokeLinecap="round" />);
  circle(17,43,3,"#e7a69b"); circle(47,43,3,"#e7a69b");
  return { background, svg: <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">{shapes}</svg> };
}

export function MemberDialog({ member, onMember, onClose, onOpenCenter, onNotice }: { member: Member | null; onMember: (member: Member | null) => void; onClose: () => void; onOpenCenter: () => Promise<void>; onNotice: (message: string) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [centerError, setCenterError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [logs, setLogs] = useState<MemberLoginRecord[]>([]);
  const [logsPage, setLogsPage] = useState(1);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState("");
  const [logsHasNext, setLogsHasNext] = useState(false);
  const [nickname, setNickname] = useState(member?.nickname ?? "");
  const [nicknameDialogOpen, setNicknameDialogOpen] = useState(false);
  const [nicknameError, setNicknameError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { setNickname(member?.nickname ?? ""); }, [member?.nickname]);
  useEffect(() => { if (!remaining) return; const timer = window.setTimeout(() => setRemaining(v => Math.max(0, v - 1)), 1000); return () => clearTimeout(timer); }, [remaining]);
  useEffect(() => {
    if (!member) return;
    let active = true;
    setLogsLoading(true); setLogsError("");
    void memberClient.loginLogs(logsPage).then(items => {
      if (active) { setLogs(items); setLogsHasNext(items.length === 20); }
    }).catch(reason => { if (active) setLogsError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLogsLoading(false); });
    return () => { active = false; };
  }, [member, logsPage]);
  async function run(task: () => Promise<void>) {
    if (busy) return; setBusy(true);
    try { await task(); } catch (reason) { onNotice(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function refreshMember() {
    if (refreshing || busy) return;
    setRefreshing(true);
    try {
      const latest = await memberClient.me();
      onMember(latest);
      if (latest) onNotice("会员信息已刷新");
      else onNotice("当前会员会话已失效，请重新登录");
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : String(reason));
    } finally { setRefreshing(false); }
  }
  return <SharedDialog
    title={member ? "会员资料" : "登录"}
    subtitle={member ? member.email : "使用邮箱验证码，无需密码"}
    icon={<LogIn size={20} aria-hidden="true" />}
    size="small"
    className={`member-login-dialog${member ? " member-profile-dialog" : " member-auth-dialog"}`}
    footerClassName={member ? undefined : "member-auth-footer"}
    onClose={onClose}
    closeDisabled={busy}
    busy={busy}
    initialFocus={member ? undefined : 'input[type="email"]'}
    onSubmit={member ? undefined : event => {
      event.preventDefault();
      void run(async () => { onMember(await memberClient.login(email.trim(), code)); onClose(); });
    }}
    footer={member ? <>
      {centerError && <span className="member-center-error" role="alert">{centerError}</span>}
      <button type="button" className="secondary" onClick={() => { setCenterError(""); void onOpenCenter().catch(reason => setCenterError(`打开会员中心失败：${reason instanceof Error ? reason.message : String(reason)}`)); }}>官网会员中心</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
        const revoked = await memberClient.logout();
        onMember(null);
        onNotice(revoked ? "已退出登录，本机云资源数据保留。" : "已清除本机登录；远端退出失败，可在官网登录设备中撤销会话。");
      })}>退出登录</button>
    </> : <>
      <span className="member-registration-hint">新邮箱验证后自动注册</span>
      <button type="submit" className="primary" disabled={busy || !runningInTauri}>{busy ? "处理中…" : "登录"}</button>
    </>}
  >
    {member ? <div className="member-profile">
      <section className="member-summary-card" aria-label="会员信息">
        <MemberAvatar member={member} size={42} />
        <div className="member-summary-copy">
          <div className="member-summary-title"><strong>{member.nickname.trim() || member.email}</strong>{member.is_vip && <span className="member-vip-badge">VIP</span>}{member.is_admin && <span className="member-admin-badge">超级管理员</span>}
            <div className="member-profile-actions">
              <button type="button" className="secondary" disabled={busy || refreshing} onClick={() => { setNickname(member.nickname); setNicknameError(""); setNicknameDialogOpen(true); }}><Pencil size={13} aria-hidden="true" />修改昵称</button>
              <button type="button" className="secondary" aria-label="刷新会员信息" title="刷新会员信息" disabled={busy || refreshing} onClick={() => void refreshMember()}><RefreshCw size={14} aria-hidden="true" className={refreshing ? "spin" : undefined} />{refreshing ? "刷新中…" : "刷新"}</button>
            </div>
          </div>
          {member.nickname.trim() && <p className="member-summary-email">{member.email}</p>}
          <p>会员 ID：{member.id} · 注册于 {formatBeijingTime(member.created_at)} 北京时间</p>
        </div>
      </section>
      <section className="member-login-history" aria-labelledby="member-login-history-title">
        <div className="member-history-heading"><History size={16} aria-hidden="true" /><h3 id="member-login-history-title">最近登录记录</h3><span>北京时间</span></div>
        <div className="member-history-scroll"><table><thead><tr><th scope="col">时间（北京时间）</th><th scope="col">事件</th><th scope="col">结果</th><th scope="col">来源</th><th scope="col">IP</th></tr></thead>
          <tbody>{logs.map((record, index) => <tr key={`${record.created_at}-${record.event}-${index}`}><td>{formatBeijingTime(record.created_at)}</td><td>{record.event === "login" ? "登录" : record.event === "register" ? "注册" : record.event === "logout" ? "退出" : "发送验证码"}</td><td><span className={`member-log-result${record.result === "success" ? " is-success" : " is-failed"}`}>{record.result === "success" ? "成功" : "失败"}</span></td><td>{record.client_type === "native" ? "客户端" : "网站"}</td><td>{record.ip}</td></tr>)}</tbody>
        </table></div>
        {logsLoading && <p className="member-history-state" role="status">正在读取登录记录…</p>}
        {!logsLoading && logsError && <p className="member-history-state is-error" role="alert">{logsError}</p>}
        {!logsLoading && !logsError && logs.length === 0 && <p className="member-history-state">暂无登录记录</p>}
        <PaginationBar className="member-history-pagination" page={logsPage} pageSize={20} hasNext={logsHasNext} disabled={logsLoading} onPageChange={setLogsPage} />
      </section>
    </div> : <div className="member-login-fields">
      <div className="member-login-field">
        <label htmlFor="member-email">邮箱</label>
        <div className="member-input-shell">
          <Mail size={16} aria-hidden="true" />
          <input id="member-email" type="email" value={email} required autoComplete="email" maxLength={254} disabled={busy}
            onChange={e => setEmail(e.target.value)} placeholder="输入你的邮箱" />
        </div>
      </div>
      <div className="member-login-field">
        <label htmlFor="member-code">邮箱验证码</label>
        <div className="member-input-shell member-code-fields">
          <KeyRound size={16} aria-hidden="true" />
          <input id="member-code" value={code} required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
            maxLength={6} disabled={busy} onChange={e => setCode(e.target.value)} placeholder="6位验证码" />
          <button type="button" disabled={busy || remaining > 0 || !runningInTauri} onClick={e => {
            const field = e.currentTarget.closest("form")?.querySelector<HTMLInputElement>('input[type="email"]');
            if (!field?.reportValidity()) return;
            void run(async () => { setRemaining(await memberClient.sendCode(email.trim())); onNotice("验证码已发送，请检查收件箱和垃圾邮件。"); });
          }}>{remaining > 0 ? `${remaining}秒后重发` : "获取验证码"}</button>
        </div>
      </div>
      <p className="member-privacy-note"><ShieldCheck size={15} aria-hidden="true" /><span>本机云资源与凭据不会随登录上传</span></p>
      {!runningInTauri && <p>当前为浏览器预览，请使用原生客户端登录。</p>}
    </div>}
    {member && nicknameDialogOpen && <SharedDialog
      title="修改昵称"
      subtitle="昵称会同步显示在会员资料和侧栏中"
      icon={<Pencil size={18} aria-hidden="true" />}
      size="small"
      className="member-nickname-dialog"
      onClose={() => setNicknameDialogOpen(false)}
      busy={busy}
      closeDisabled={busy}
      initialFocus="#member-nickname-input"
      onSubmit={async event => {
        event.preventDefault();
        if (busy) return;
        setBusy(true); setNicknameError("");
        try {
          const updated = await memberClient.nickname(nickname.trim());
          onMember(updated);
          setNicknameDialogOpen(false);
          onNotice("昵称已更新");
        } catch (reason) {
          setNicknameError(reason instanceof Error ? reason.message : String(reason));
        } finally { setBusy(false); }
      }}
      footer={<><button type="button" className="secondary" disabled={busy} onClick={() => setNicknameDialogOpen(false)}>取消</button><button type="submit" className="primary" disabled={busy || !nickname.trim() || nickname.trim() === member.nickname}>{busy ? "保存中…" : "保存"}</button></>}
    >
      <div className="member-nickname-fields">
        <label htmlFor="member-nickname-input">昵称</label>
        <input id="member-nickname-input" value={nickname} maxLength={20} required disabled={busy} onChange={event => setNickname(event.target.value)} />
        <p>支持 1–20 个字符，不能包含控制字符。</p>
        {nicknameError && <p className="member-dialog-feedback is-error" role="alert">{nicknameError}</p>}
      </div>
    </SharedDialog>}
  </SharedDialog>;
}
