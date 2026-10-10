import { PlatformError } from "../api";
import type { AuthCode, AuthEntry } from "./authenticator";

export function selectAuthenticatorFile(image: boolean): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = image ? "image/png,image/jpeg,image/gif,image/webp" : ".json,.txt,text/plain,application/json";
    input.hidden = true; document.body.append(input);
    const finish = (file: File | null) => { input.remove(); resolve(file); };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.click();
  });
}

export async function copyAuthenticatorField(id: string, target: "current" | "next" | "account", list: () => Promise<AuthEntry[]>, codes: (ids: string[]) => Promise<AuthCode[]>) {
  const text = target === "account" ? (await list()).find(entry => entry.id === id)?.account : (await codes([id]))[0]?.[target];
  if (!text) throw new PlatformError("该条目没有可复制的内容", "authenticator-error");
  try { await navigator.clipboard.writeText(text); }
  catch { throw new PlatformError("浏览器未允许复制，请允许剪贴板权限后重试", "authenticator-error"); }
  // Browsers require additional permission for reading. Never request it for cleanup.
  // Native apps retain their conditional 30-second clipboard cleanup.
}

export function downloadAuthenticatorFile(content: string, filename: string): string {
  const url = URL.createObjectURL(new Blob([content], { type: filename.endsWith(".txt") ? "text/plain;charset=utf-8" : "application/json;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}
