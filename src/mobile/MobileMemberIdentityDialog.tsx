import { useState } from "react";
import { BadgeCheck, Crown, ShieldCheck } from "lucide-react";
import { SharedDialog } from "../shared/SharedDialog";
import type { Member } from "../platform/clients/member";
import { MemberAvatar } from "../features/member/MemberDialog";

export type MemberIdentityKind = "vip" | "experience_officer" | "super_admin";

const identityInfo: Record<MemberIdentityKind, { label: string; subtitle: string; color: string; icon: typeof Crown }> = {
  vip: { label: "VIP 会员", subtitle: "尊享会员权益，感谢一路相伴。", color: "#e8b94f", icon: Crown },
  experience_officer: { label: "产品体验官", subtitle: "感谢参与产品体验，期待你的反馈。", color: "#f0c76e", icon: BadgeCheck },
  super_admin: { label: "超级管理员", subtitle: "云枢工具箱管理身份。", color: "#a9a4ff", icon: ShieldCheck },
};

async function saveIdentityCard(member: Member, identity: MemberIdentityKind) {
  const info = identityInfo[identity];
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 600;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法生成身份卡图片");
  const gradient = context.createLinearGradient(0, 0, 960, 600);
  gradient.addColorStop(0, "#211f2b");
  gradient.addColorStop(0.68, "#302d46");
  gradient.addColorStop(1, "#64553a");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 960, 600);
  const glow = context.createRadialGradient(800, 520, 10, 800, 520, 400);
  glow.addColorStop(0, `${info.color}66`);
  glow.addColorStop(1, `${info.color}00`);
  context.fillStyle = glow;
  context.fillRect(0, 0, 960, 600);
  context.textAlign = "center";
  context.fillStyle = info.color;
  context.font = "600 30px sans-serif";
  context.fillText(info.label, 480, 150);
  context.fillStyle = "#ffffff";
  context.font = "600 52px sans-serif";
  context.fillText(member.nickname?.trim() || member.email, 480, 285, 820);
  context.fillStyle = "#c7c3d1";
  context.font = "28px sans-serif";
  context.fillText(info.subtitle, 480, 350, 820);
  context.fillText(`加入云枢工具箱 · ${member.created_at.slice(0, 10)}`, 480, 510);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("身份卡图片生成失败")), "image/png"));
  const file = new File([blob], `云枢工具箱-${info.label}.png`, { type: "image/png" });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: info.label });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function MobileMemberIdentityDialog({ member, identity, onClose, desktop = false }: { member: Member; identity: MemberIdentityKind; onClose: () => void; desktop?: boolean }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const info = identityInfo[identity];
  const Icon = info.icon;

  async function save() {
    setSaving(true);
    setError("");
    try { await saveIdentityCard(member, identity); }
    catch (reason) { if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "保存失败，请重试"); }
    finally { setSaving(false); }
  }

  return <SharedDialog title={info.label} subtitle="你的专属身份标识" size="small" showResize={false} className={`mobile-member-identity-dialog${desktop ? " member-identity-desktop" : ""}`} onClose={onClose}>
    <section className={`mobile-identity-card is-${identity}`} aria-label={`${info.label}身份卡`}>
      <span className="mobile-identity-confetti is-one" aria-hidden="true" />
      <span className="mobile-identity-confetti is-two" aria-hidden="true" />
      <span className="mobile-identity-confetti is-three" aria-hidden="true" />
      <span className="mobile-identity-avatar"><MemberAvatar member={member} size={58} /></span>
      <span className={`mobile-identity-ribbon is-${identity}`}><Icon size={13} aria-hidden="true" />{info.label}</span>
      <small className="mobile-identity-brand">CLOUDHUB · MEMBER</small>
      <h3>{member.nickname?.trim() || member.email}</h3>
      <p>{identity === "vip" && !member.is_vip ? "VIP 权益暂未开通" : info.subtitle}</p>
      <time>加入日期 · {member.created_at.slice(0, 10)}</time>
      {error && <p className="mobile-identity-card-error" role="alert">{error}</p>}
      <button type="button" className="mobile-identity-save" disabled={saving} onClick={() => void save()}>{saving ? "正在准备…" : "保存到相册"}</button>
    </section>
  </SharedDialog>;
}
