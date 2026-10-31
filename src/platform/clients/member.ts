import { nativeOnly } from "./base";
export type Member = { id: number; email: string; nickname: string; avatar_key: number; is_vip: boolean; is_admin: boolean; status: string; created_at: string; last_login_at: string | null };
export type MemberLoginRecord = { event: "login" | "register" | "logout" | "send_code"; result: "success" | "failed"; ip: string; client_type: "native" | "web"; created_at: string };
export const memberClient = {
  me: () => nativeOnly<Member | null>("member_me"),
  webHandoff: () => nativeOnly<string>("member_web_handoff"),
  sendCode: (email: string) => nativeOnly<number>("member_send_code", { email }),
  login: (email: string, code: string) => nativeOnly<Member>("member_login", { email, code }),
  avatar: (avatarKey: number) => nativeOnly<Member>("member_avatar", { avatarKey }),
  nickname: (nickname: string) => nativeOnly<Member>("member_nickname", { nickname }),
  loginLogs: (page: number) => nativeOnly<MemberLoginRecord[]>("member_login_logs", { page }),
  logout: () => nativeOnly<boolean>("member_logout"),
};
