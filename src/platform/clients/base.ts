import { invoke, runningInTauri, webApi } from "../api";

export type PreviewRequest = {
  path: string;
  init?: RequestInit;
};

export function jsonRequest(method: "POST" | "PUT" | "PATCH" | "DELETE", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function queryPath(path: string, values: Record<string, string | number | boolean | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export async function invokeOrWeb<TResult>(
  command: string,
  args: Record<string, unknown> | undefined,
  preview: PreviewRequest | (() => PreviewRequest),
): Promise<TResult> {
  if (runningInTauri) return invoke<TResult>(command, args);
  const request = typeof preview === "function" ? preview() : preview;
  return webApi<TResult>(request.path, request.init);
}

export async function nativeOnly<TResult>(command: string, args?: Record<string, unknown>): Promise<TResult> {
  if (!runningInTauri) throw new Error("该功能仅在桌面端可用");
  return invoke<TResult>(command, args);
}

export async function previewOnly<TResult>(request: PreviewRequest): Promise<TResult> {
  if (runningInTauri) throw new Error("该功能仅在浏览器预览中可用");
  return webApi<TResult>(request.path, request.init);
}
