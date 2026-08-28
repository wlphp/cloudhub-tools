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

export async function webApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${localWebApiBaseUrl}${path}`, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Web API ${response.status}`);
  }
  return payload as T;
}
