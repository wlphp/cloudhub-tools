import { useEffect, useState } from "react";
import { invoke, runningInTauri } from "../platform/api";

// localStorage keys used by the client-side preference cache. The Tauri
// `save_client_preference` command persists the same keys into the encrypted
// SQLite store so a fresh launch on the same machine picks up where we left
// off.
const autoRefreshStorageKey = "aliyun-auto-refresh";
const compactModeStorageKey = "aliyun-compact-mode";
const pageSizeStorageKey = "aliyun-page-size";
const appSidebarWidthStorageKey = "cloudhub-app-sidebar-width";
const terminalHostSidebarWidthStorageKey = "cloudhub-terminal-host-sidebar-width";

const allowedPageSizes: readonly number[] = [10, 20, 50, 100];

function readAutoRefresh(): boolean {
  return localStorage.getItem(autoRefreshStorageKey) !== "0";
}

function readCompactMode(): boolean {
  return localStorage.getItem(compactModeStorageKey) === "1";
}

function readPageSize(): number {
  const value = Number(localStorage.getItem(pageSizeStorageKey) || "10");
  return allowedPageSizes.includes(value) ? value : 10;
}

function readSidebarWidth(key: string, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(localStorage.getItem(key) || String(fallback))));
}

export interface ClientPreferences {
  autoRefresh: boolean;
  setAutoRefresh: (value: boolean | ((current: boolean) => boolean)) => void;
  compactMode: boolean;
  setCompactMode: (value: boolean | ((current: boolean) => boolean)) => void;
  pageSize: number;
  setPageSize: (value: number | ((current: number) => number)) => void;
  appSidebarWidth: number;
  setAppSidebarWidth: (value: number | ((current: number) => number)) => void;
  terminalHostSidebarWidth: number;
  setTerminalHostSidebarWidth: (value: number | ((current: number) => number)) => void;
  clientPreferencesReady: boolean;
  setClientPreferencesReady: (value: boolean | ((current: boolean) => boolean)) => void;
  saveClientPreference: (key: string, value: string) => void;
}

export function useClientPreferences(): ClientPreferences {
  const [clientPreferencesReady, setClientPreferencesReady] = useState(!runningInTauri);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(readAutoRefresh);
  const [compactMode, setCompactMode] = useState<boolean>(readCompactMode);
  const [pageSize, setPageSize] = useState<number>(readPageSize);
  const [appSidebarWidth, setAppSidebarWidth] = useState<number>(() => readSidebarWidth(appSidebarWidthStorageKey, 235, 190, 340));
  const [terminalHostSidebarWidth, setTerminalHostSidebarWidth] = useState<number>(() => readSidebarWidth(terminalHostSidebarWidthStorageKey, 250, 190, 420));

  function saveClientPreference(key: string, value: string) {
    if (runningInTauri && clientPreferencesReady) {
      void invoke("save_client_preference", { key, value }).catch(() => {});
    }
  }

  useEffect(() => {
    const value = autoRefresh ? "1" : "0";
    localStorage.setItem(autoRefreshStorageKey, value);
    saveClientPreference(autoRefreshStorageKey, value);
  }, [autoRefresh, clientPreferencesReady]);

  useEffect(() => {
    const value = compactMode ? "1" : "0";
    localStorage.setItem(compactModeStorageKey, value);
    document.documentElement.classList.toggle("compact-mode", compactMode);
    saveClientPreference(compactModeStorageKey, value);
  }, [compactMode, clientPreferencesReady]);

  useEffect(() => {
    localStorage.setItem(appSidebarWidthStorageKey, String(appSidebarWidth));
    saveClientPreference(appSidebarWidthStorageKey, String(appSidebarWidth));
  }, [appSidebarWidth, clientPreferencesReady]);

  useEffect(() => {
    localStorage.setItem(terminalHostSidebarWidthStorageKey, String(terminalHostSidebarWidth));
    saveClientPreference(terminalHostSidebarWidthStorageKey, String(terminalHostSidebarWidth));
  }, [terminalHostSidebarWidth, clientPreferencesReady]);

  return {
    autoRefresh,
    setAutoRefresh,
    compactMode,
    setCompactMode,
    pageSize,
    setPageSize,
    appSidebarWidth,
    setAppSidebarWidth,
    terminalHostSidebarWidth,
    setTerminalHostSidebarWidth,
    clientPreferencesReady,
    setClientPreferencesReady,
    saveClientPreference,
  };
}