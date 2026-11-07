import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, ChevronRight, KeyRound, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { memberClient, type Member, type MemberMessage } from "../platform/clients/member";
import { readRememberedMemberEmail, rememberMemberEmail } from "../features/member/memberEmail";

function beijingTime(value: string) {
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function MobileMemberPage({ member, onMember, onBack, onNotice, openInbox = false, onInboxOpened, onUnreadCount }: { member: Member | null; onMember: (member: Member | null) => void; onBack: () => void; onNotice: (message: string) => void; openInbox?: boolean; onInboxOpened?: () => void; onUnreadCount?: (count: number) => void }) {
  const [email, setEmail] = useState(readRememberedMemberEmail);
  const [code, setCode] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [error, setError] = useState("");
  const [inboxOpen, setInboxOpen] = useState(false);
  const [messages, setMessages] = useState<MemberMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [selectedMessage, setSelectedMessage] = useState<MemberMessage | null>(null);
  const [messagesBusy, setMessagesBusy] = useState(false);
  const [messagesError, setMessagesError] = useState("");

  async function loadMessages() {
    setMessagesBusy(true);
    setMessagesError("");
    try {
      const page = await memberClient.messages(1);
      setMessages(page.items);
      setUnreadCount(page.unread_count);
      onUnreadCount?.(page.unread_count);
    } catch (reason) {
      setMessagesError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMessagesBusy(false);
    }
  }

  useEffect(() => {
    if (!remaining) return;
    const timer = window.setTimeout(() => setRemaining(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  useEffect(() => {
    if (!member) {
      setMessages([]);
      setUnreadCount(0);
      setMessagesError("");
      setInboxOpen(false);
      setSelectedMessage(null);
    }
  }, [member?.id]);

  useEffect(() => {
    if (!openInbox || !member) return;
    setInboxOpen(true);
    setSelectedMessage(null);
    onInboxOpened?.();
    void loadMessages();
  }, [openInbox, member?.id]);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    rememberMemberEmail(email);
    setBusy(true);
    setError("");
    try {
      onMember(await memberClient.login(email.trim(), code));
      onNotice("登录成功");
      onBack();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const openMessage = async (message: MemberMessage) => {
    try {
      const detail = await memberClient.message(message.id);
      setSelectedMessage(detail);
      setMessages(current => current.map(item => item.id === detail.id ? detail : item));
      setUnreadCount(current => {
        const next = Math.max(0, current - (message.read_at ? 0 : 1));
        onUnreadCount?.(next);
        return next;
      });
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <div className="mobile-member-page">
    {member ? inboxOpen ? <section className="mobile-member-section mobile-member-inbox">
      <div className="mobile-member-section-title">
        <button type="button" className="mobile-member-back" aria-label="返回" onClick={onBack}><ArrowLeft size={19} /></button>
        <div><h1>{selectedMessage ? "消息详情" : "会员消息"}</h1><p>{unreadCount} 条未读</p></div>
        {!selectedMessage && <button type="button" className="mobile-member-inbox-allread" disabled={messagesBusy || unreadCount === 0} onClick={async () => {
          try {
            await memberClient.markAllMessagesRead();
            setMessages(items => items.map(item => ({ ...item, read_at: item.read_at || new Date().toISOString() })));
            setUnreadCount(0);
            onUnreadCount?.(0);
          } catch (reason) {
            onNotice(reason instanceof Error ? reason.message : String(reason));
          }
        }}>全部已读</button>}
      </div>
      {selectedMessage ? <>
        <button type="button" className="mobile-member-back" aria-label="返回消息列表" onClick={() => setSelectedMessage(null)}><ArrowLeft size={19} />返回消息列表</button>
        <article className="mobile-member-message-detail"><h2>{selectedMessage.title}</h2><time>{beijingTime(selectedMessage.created_at)}</time><p>{selectedMessage.content}</p></article>
      </> : messagesBusy ? <p className="mobile-member-empty" role="status">正在加载消息…</p> : messagesError ? <div className="mobile-member-load-error" role="alert"><AlertCircle size={20} aria-hidden="true" /><strong>消息暂时无法加载</strong><p>{messagesError}</p><button type="button" onClick={() => void loadMessages()} disabled={messagesBusy}><RefreshCw size={15} aria-hidden="true" />重试</button></div> : messages.length ? <div className="mobile-member-message-list">{messages.map(item => <button type="button" key={item.id} className={`mobile-member-message-row${item.read_at ? " is-read" : " is-unread"}`} onClick={() => void openMessage(item)}><span><strong>{item.title}</strong><small>{beijingTime(item.created_at)}</small><span>{item.content}</span></span>{!item.read_at && <i aria-label="未读" />}<ChevronRight size={17} /></button>)}</div> : <p className="mobile-member-empty" role="status">暂无消息</p>}
    </section> : <div className="mobile-member-empty" role="status">正在返回…</div> : <>
      <header className="mobile-member-heading"><button type="button" className="mobile-member-back" onClick={onBack} aria-label="返回"><ArrowLeft size={19} /></button><div><p>账户与身份</p><h1>登录 / 注册</h1></div></header>
      <p className="mobile-member-login-hint">同步昵称、头像与会员身份。本机云资源与凭据始终保存在本机。</p>
      <form className="mobile-member-login" onSubmit={event => void handleLogin(event)}>
        <label htmlFor="mobile-member-email">邮箱</label><div className="mobile-member-input"><Mail size={17} aria-hidden="true" /><input id="mobile-member-email" type="email" autoComplete="email" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} onBlur={event => rememberMemberEmail(event.currentTarget.value)} placeholder="输入你的邮箱" /></div>
        <label htmlFor="mobile-member-code">邮箱验证码</label><div className="mobile-member-input"><KeyRound size={17} aria-hidden="true" /><input id="mobile-member-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={busy} onChange={event => setCode(event.target.value)} placeholder="6 位验证码" /><button type="button" disabled={busy || sendingCode || remaining > 0} onClick={async () => {
          const field = document.getElementById("mobile-member-email") as HTMLInputElement | null;
          if (!field?.reportValidity()) return;
          rememberMemberEmail(field.value);
          setSendingCode(true);
          setError("");
          try {
            setRemaining(await memberClient.sendCode(email.trim()));
            onNotice("验证码已发送，请检查收件箱和垃圾邮件。");
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setSendingCode(false);
          }
        }}>{sendingCode ? "发送中…" : remaining ? `${remaining} 秒` : "获取验证码"}</button></div>
        {error && <p className="mobile-member-error" role="alert">{error}</p>}
        <p className="mobile-member-security"><ShieldCheck size={16} />新邮箱验证后自动注册 · 无需密码</p>
        <button type="submit" className="mobile-member-submit" disabled={busy}>{busy ? "正在登录…" : "登录 / 注册"}</button>
      </form>
    </>}
  </div>;
}
