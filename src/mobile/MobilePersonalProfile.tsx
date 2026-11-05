import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ChevronRight, Check, X, LogOut } from "lucide-react";
import { MemberAvatar } from "../features/member/MemberDialog";
import { memberClient, type Member } from "../platform/clients/member";

export function MobilePersonalProfile({ member, onMember, onBack, onNotice, showHeader = true }: {
  member: Member;
  onMember: (member: Member | null) => void;
  onBack: () => void;
  onNotice: (message: string) => void;
  showHeader?: boolean;
}) {
  const [intro, setIntro] = useState(member.bio ?? "");
  const [editing, setEditing] = useState<"nickname" | "intro" | null>(null);
  const [nickname, setNickname] = useState(member.nickname);
  const [introDraft, setIntroDraft] = useState(member.bio ?? "");
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setNickname(member.nickname);
    setIntro(member.bio ?? "");
    setIntroDraft(member.bio ?? "");
  }, [member.id, member.nickname, member.bio]);

  const saveNickname = async (event: FormEvent) => {
    event.preventDefault();
    const value = nickname.trim();
    if (!value || value === member.nickname || busy) return;
    setBusy(true); setError("");
    try { onMember(await memberClient.nickname(value)); setEditing(null); onNotice("昵称已更新"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "昵称保存失败"); }
    finally { setBusy(false); }
  };

  const saveIntro = async (event: FormEvent) => {
    event.preventDefault();
    const value = introDraft.trim();
    if (busy || [...value].length > 100 || value === intro) return;
    setBusy(true); setError("");
    try { const updated = await memberClient.bio(value); onMember(updated); setIntro(updated.bio); setEditing(null); onNotice("个人简介已同步到账号"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "简介保存失败"); }
    finally { setBusy(false); }
  };

  const saveAvatar = async (avatarKey: number) => {
    if (busy || avatarKey === member.avatar_key) { setAvatarPickerOpen(false); return; }
    setBusy(true); setError("");
    try { onMember(await memberClient.avatar(avatarKey)); setAvatarPickerOpen(false); onNotice("头像已更新"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "头像保存失败"); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const revoked = await memberClient.logout();
      onMember(null);
      onNotice(revoked ? "已退出登录，本机云资源数据保留。" : "已清除本机登录；远端退出失败，可在官网登录设备中撤销会话。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "退出登录失败");
    } finally { setBusy(false); }
  };

  return <div className="mobile-personal-profile">
    {showHeader && <header className="mobile-personal-profile-header"><button type="button" aria-label="返回我的页面" onClick={onBack}><ArrowLeft size={24} aria-hidden="true" /></button><h1>个人资料</h1><span aria-hidden="true" /></header>}
    <section className="mobile-personal-profile-card" aria-label="个人资料设置">
      <button type="button" className="mobile-personal-profile-row mobile-personal-avatar-row" aria-expanded={avatarPickerOpen} onClick={() => { setAvatarPickerOpen(value => !value); setEditing(null); }}>
        <span className="mobile-personal-profile-label">个人头像</span><span className="mobile-personal-avatar"><MemberAvatar member={member} size={58} /></span><ChevronRight size={22} aria-hidden="true" />
      </button>
      {avatarPickerOpen && <div className="mobile-personal-avatar-picker" role="group" aria-label="选择个人头像">{Array.from({ length: 12 }, (_, index) => index + 1).map(key => <button key={key} type="button" aria-label={`选择头像 ${key}`} aria-pressed={member.avatar_key === key} disabled={busy} onClick={() => void saveAvatar(key)}><MemberAvatar member={member} avatarKey={key} size={42} /></button>)}</div>}
      <div className="mobile-personal-profile-row mobile-personal-edit-row">
        <span className="mobile-personal-profile-label">昵称</span>
        {editing === "nickname" ? <form className="mobile-personal-inline-form" onSubmit={event => void saveNickname(event)}><input aria-label="昵称" autoFocus value={nickname} maxLength={20} disabled={busy} onChange={event => setNickname(event.target.value)} /><button type="submit" aria-label="保存昵称" disabled={busy || !nickname.trim() || nickname.trim() === member.nickname}><Check size={20} /></button><button type="button" aria-label="取消修改昵称" disabled={busy} onClick={() => { setNickname(member.nickname); setEditing(null); setError(""); }}><X size={20} /></button></form> : <button type="button" className="mobile-personal-profile-value" onClick={() => { setNickname(member.nickname); setError(""); setEditing("nickname"); }}><span>{member.nickname.trim() || "匿名用户"}</span><ChevronRight size={22} aria-hidden="true" /></button>}
      </div>
      <div className="mobile-personal-profile-row mobile-personal-edit-row mobile-personal-intro-row">
        <span className="mobile-personal-profile-label">简介</span>
        {editing === "intro" ? <form className="mobile-personal-intro-form" onSubmit={event => void saveIntro(event)}><textarea aria-label="个人简介" autoFocus rows={3} maxLength={100} value={introDraft} disabled={busy} onChange={event => setIntroDraft(event.target.value)} placeholder="介绍一下自己吧" /><div><small>{[...introDraft].length}/100 · 保存后同步到账号</small><button type="submit" aria-label="保存个人简介" disabled={busy || introDraft.trim() === intro || [...introDraft].length > 100}><Check size={20} /></button><button type="button" aria-label="取消修改简介" disabled={busy} onClick={() => { setIntroDraft(intro); setEditing(null); setError(""); }}><X size={20} /></button></div></form> : <button type="button" className="mobile-personal-profile-value" onClick={() => { setIntroDraft(intro); setError(""); setEditing("intro"); }}><span className={intro ? "" : "is-placeholder"}>{intro || "修改"}</span><ChevronRight size={22} aria-hidden="true" /></button>}
      </div>
      {error && <p className="mobile-personal-profile-error" role="alert">{error}</p>}
    </section>
    <p className="mobile-personal-profile-note">头像、昵称和个人简介会同步保存到会员账号。</p>
    <button type="button" className="mobile-member-logout" disabled={busy} onClick={() => void logout()}><LogOut size={17} />{busy ? "处理中…" : "退出登录"}</button>
  </div>;
}
