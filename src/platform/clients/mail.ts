import { nativeOnly } from "./base";
export type MailAccount = { id: string; name: string; email: string; username: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; smtpSecurity: "tls" | "starttls" };
export type MailSummary = { uid: number; subject: string; from: string; date: string; unread: boolean; size: number };
export type MailListing = { validity: number; total: number; messages: MailSummary[] };
export type MailMessage = { subject: string; from: string; to: string; date: string; body: string; attachments: { index: number; name: string; size: number }[] };
export type MailDraft = { to: string; subject: string; body: string; attachments: { name: string; data: string }[] };
export type MailTransferPreview = { token: string; accounts: Array<{ index: number; name: string; email: string; username: string }> };
export const mailClient = {
 accounts: () => nativeOnly<MailAccount[]>("mail_accounts"),
 reveal: (id: string) => nativeOnly<string>("mail_reveal_secret", { id }),
 save: (input: MailAccount & { password: string }) => nativeOnly<MailAccount>("mail_save", { input }),
 remove: (id: string) => nativeOnly<void>("mail_remove", { id }),
 test: (id: string) => nativeOnly<{ imap: boolean; smtp: boolean; imapError?: string | null; smtpError?: string | null }>("mail_test", { id }),
 folders: (id: string) => nativeOnly<string[]>("mail_folders", { id }),
 list: (id: string, folder: string) => nativeOnly<MailListing>("mail_list", { id, folder }),
 read: (id: string, folder: string, validity: number, uid: number) => nativeOnly<MailMessage>("mail_read", { id, folder, validity, uid }),
 attachment: (id: string, folder: string, validity: number, uid: number, index: number) => nativeOnly<boolean>("mail_attachment", { id, folder, validity, uid, index }),
 send: (id: string, draft: MailDraft) => nativeOnly<void>("mail_send", { id, draft }),
  prepareImport: () => nativeOnly<MailTransferPreview | null>("mail_prepare_import"),
  importSelected: (token: string, indices: number[]) => nativeOnly<{ imported: number; skipped: number }>("mail_import_selected", { token, indices }),
  exportSelected: (ids: string[], acknowledgePlain: boolean) => nativeOnly<boolean>("mail_export_selected", { ids, acknowledgePlain }),
};
