import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const invoke = tauriInvoke;

function webApiPort(value: string | undefined): number {
  const port = Number(value || "1430");
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 1430;
}

const localWebApiPort = webApiPort(
  import.meta.env.VITE_CLOUDHUB_TOOLS_WEB_API_PORT
    || import.meta.env.VITE_ALIYUN_TOOLS_WEB_API_PORT,
);
const localWebApiBaseUrl = `http://127.0.0.1:${localWebApiPort}`;

export interface UnsupportedInPreviewError extends Error {
  kind: "unsupported-in-preview";
  feature?: string;
  hint?: string;
}

function buildUnsupported(payload: { error?: string; code?: string; details?: { feature?: string; hint?: string } }): UnsupportedInPreviewError {
  const error = new Error(payload.error || "Web API 调用未实现") as UnsupportedInPreviewError;
  error.kind = "unsupported-in-preview";
  if (payload.details?.feature) error.feature = payload.details.feature;
  if (payload.details?.hint) error.hint = payload.details.hint;
  return error;
}

export async function webApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${localWebApiBaseUrl}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 501 && payload?.code === "unsupported-in-preview") {
    throw buildUnsupported(payload);
  }
  if (!response.ok) {
    throw new Error(payload.error || `Web API ${response.status}`);
  }
  return payload as T;
}
