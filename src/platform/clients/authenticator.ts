import { invokeOrWeb, jsonRequest, nativeOnly } from "./base";
import { runningInTauri, PlatformError } from "../api";
import { selectAuthenticatorFile, copyAuthenticatorField, downloadAuthenticatorFile } from "./authenticator-browser";

export type AuthEntry = {
  id: string; issuer: string; account: string; kind: "totp" | "hotp" | "steam";
  algorithm: "SHA1" | "SHA256" | "SHA512"; digits: number; period: number; counter: string;
  group: string; note: string; pinned: boolean; order: number;
};
export type AuthInput = Omit<AuthEntry, "id"> & { id?: string; secret?: string };
export type AuthCode = { id: string; current: string; next: string | null; remaining: number; period: number; counter: string };
export type AuthStatus = { initialized: boolean; unlocked: boolean; passwordRequired: boolean };
export type AuthPreview = { token: string; format: string; errors: string[]; items: Array<{ entry: AuthEntry; duplicateId: string | null; conflict: boolean }> };
function request<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return invokeOrWeb<T>(command, args, { path: "/api/authenticator", init: jsonRequest("POST", { op: command.replace("authenticator_", ""), args }) });
}
export const authenticatorClient = {
  status: () => request<AuthStatus>("authenticator_status"),
  unlock: (password: string, create: boolean) => request<void>("authenticator_unlock", { password, create }),
  lock: () => request<void>("authenticator_lock"),
  list: () => request<AuthEntry[]>("authenticator_list"),
  touch: () => request<void>("authenticator_touch"),
  codes: (ids: string[]) => request<AuthCode[]>("authenticator_codes", { ids }),
  save: (input: AuthInput) => request<void>("authenticator_save", { input }),
  remove: (ids: string[]) => request<void>("authenticator_remove", { ids }),
  advance: (id: string) => request<void>("authenticator_advance", { id }),
  copy: (id: string, target: "current" | "next" | "account" = "current") => runningInTauri ? nativeOnly<void>("authenticator_copy", { id, target }) : copyAuthenticatorField(id, target, authenticatorClient.list, authenticatorClient.codes),
  prepare: async (input: { password: string; text?: string; image?: number[]; qr: boolean }): Promise<AuthPreview | null> => {
    if (!runningInTauri && input.text === undefined && input.image === undefined) {
      const file = await selectAuthenticatorFile(input.qr);
      if (!file) return null;
      if (file.size > 10 * 1024 * 1024) throw new PlatformError("文件不能超过 10 MiB", "authenticator-error");
      input = input.qr ? { ...input, image: [...new Uint8Array(await file.arrayBuffer())] } : { ...input, text: await file.text() };
    }
    return request<AuthPreview | null>("authenticator_prepare", { password: input.password, text: input.text ?? null, image: input.image ?? null, qr: input.qr });
  },
  confirmImport: (token: string, choices: Array<{ id: string; action: string }>) => request<{ added: number; updated: number; skipped: number }>("authenticator_import", { token, choices }),
  cancel: () => request<void>("authenticator_cancel"),
  export: async (input: { ids: string[]; format: "cloudhub" | "ente" | "plain"; password: string; acknowledgePlain: boolean }): Promise<string | null> => {
    if (runningInTauri) return nativeOnly<string | null>("authenticator_export", input);
    const result = await request<{ content: string; filename: string }>("authenticator_export", input);
    return downloadAuthenticatorFile(result.content, result.filename);
  },
};
