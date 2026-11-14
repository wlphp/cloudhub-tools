import { runningInTauri } from "../api";
import { jsonRequest, nativeOnly, previewOnly } from "./base";

export type Member = { id: number; email: string; nickname: string; bio: string; avatar_key: number; is_vip: boolean; is_experience_officer: boolean; is_admin: boolean; status: string; created_at: string; last_login_at: string | null };
export type MemberLoginRecord = { event: "login" | "register" | "logout" | "send_code"; result: "success" | "failed"; ip: string; client_type: "native" | "web"; created_at: string };
export type MemberMessage = { id: number; type: string; title: string; content: string; created_at: string; read_at: string | null };
export type MemberMessagePage = { items: MemberMessage[]; unread_count: number; page: number; has_more: boolean };

export function memberHasExperienceOfficerIdentity(member: Pick<Member, "id" | "is_admin" | "is_experience_officer"> | null | undefined): boolean {
  return member?.is_experience_officer === true || (member?.id === 1 && member.is_admin);
}

const browserSessionStorageKey = "cloudhub-tools-member-preview-session";
function browserSessionId() {
  try { return sessionStorage.getItem(browserSessionStorageKey) || ""; } catch { return ""; }
}
function rememberBrowserSession(value: string | null) {
  try {
    if (value) sessionStorage.setItem(browserSessionStorageKey, value);
    else sessionStorage.removeItem(browserSessionStorageKey);
  } catch { /* Browser privacy settings may disable session storage. */ }
}
function previewRequest<T>(op: string, args: Record<string, unknown> = {}) {
  return previewOnly<T>({
    path: "/api/member",
    init: jsonRequest("POST", { op, ...args, session_id: browserSessionId() }),
  }).catch((reason: unknown) => {
    if (reason instanceof Error && reason.message.includes("登录已失效")) rememberBrowserSession(null);
    throw reason;
  });
}

export const memberClient = {
  me: async () => {
    const value = await (runningInTauri ? nativeOnly<Member | null>("member_me") : previewRequest<Member | null>("me"));
    if (value !== null && (!value || typeof value.id !== "number" || typeof value.email !== "string" || typeof value.created_at !== "string")) {
      throw new Error("会员资料格式异常，请重新登录后重试。");
    }
    return value;
  },
  webHandoff: () => nativeOnly<string>("member_web_handoff"),
  sendCode: (email: string) => runningInTauri
    ? nativeOnly<number>("member_send_code", { email })
    : previewRequest<number>("send_code", { email }),
  async login(email: string, code: string) {
    if (runningInTauri) return nativeOnly<Member>("member_login", { email, code });
    const result = await previewRequest<{ member: Member; session_id: string }>("login", { email, code });
    rememberBrowserSession(result.session_id);
    return result.member;
  },
  avatar: (avatarKey: number) => runningInTauri
    ? nativeOnly<Member>("member_avatar", { avatarKey })
    : previewRequest<Member>("avatar", { avatar_key: avatarKey }),
  nickname: (nickname: string) => runningInTauri
    ? nativeOnly<Member>("member_nickname", { nickname })
    : previewRequest<Member>("nickname", { nickname }),
  bio: (bio: string) => runningInTauri
    ? nativeOnly<Member>("member_bio", { bio })
    : previewRequest<Member>("bio", { bio }),
  loginLogs: (page: number) => runningInTauri
    ? nativeOnly<MemberLoginRecord[]>("member_login_logs", { page })
    : previewRequest<MemberLoginRecord[]>("login_logs", { page }),
  messages: (page = 1) => runningInTauri ? nativeOnly<MemberMessagePage>("member_messages", { page }) : previewRequest<MemberMessagePage>("messages", { page }),
  message: (id: number) => runningInTauri ? nativeOnly<MemberMessage>("member_message", { id }) : previewRequest<MemberMessage>("message", { id }),
  markAllMessagesRead: () => runningInTauri ? nativeOnly<number>("member_messages_read_all") : previewRequest<number>("messages_read_all"),
  async logout() {
    if (runningInTauri) return nativeOnly<boolean>("member_logout");
    try { return await previewRequest<boolean>("logout"); }
    finally { rememberBrowserSession(null); }
  },
};
