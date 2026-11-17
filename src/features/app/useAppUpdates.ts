import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { updatesClient, type DesktopUpdate, type UpdateProgress, type UpdateRoute } from "../../platform/clients/updates";
import { useUpdateSource } from "./useUpdateSource";
import { useEffect, useRef, useState } from "react";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { appClient } from "../../platform/clients/app";

export type UpdateState =
  | { phase: "idle" | "checking" | "current" }
  | { phase: "available"; version: string; notes?: string }
  | { phase: "downloading"; version: string; downloaded: number; total?: number }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

function normalizeUpdateNotes(notes?: string): string | undefined {
  const value = String(notes || "").trim();
  if (!value) return undefined;
  if (value.startsWith("Desktop builds for Windows, macOS, and Linux.")) {
    return "本次版本提供 Windows、macOS 和 Linux 桌面版本。\nmacOS 下载包按处理器区分：Apple Silicon（M 系列）和 Intel。";
  }
  return value.slice(0, 4000);
}

export function useAppUpdates(bundledVersion: string, onStatus: (message: string) => void) {
  const [appVersion, setAppVersion] = useState(bundledVersion);
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: "idle" });
  const updateRef = useRef<DesktopUpdate | null>(null);
  const sourceSettings = useUpdateSource();
  const [route, setRoute] = useState<UpdateRoute>();
  const [routeMessage, setRouteMessage] = useState("");
  const busy = useRef(false);
  const progress = (event: UpdateProgress) => { setRoute(event.route); setRouteMessage(event.message); };
  const [isDevelopment, setIsDevelopment] = useState(false);
  // Ask the native binary: a debug build can also load a production frontend.
  const developmentRef = useRef<Promise<boolean> | null>(null);
  function developmentBuild() {
    return developmentRef.current ??= appClient.isDevelopment();
  }

  async function checkForUpdates(quiet = false) {
    if (!runningInTauri) {
      setUpdateState({ phase: "idle" });
      return;
    }
    if (busy.current || !sourceSettings.loaded) return;
    busy.current = true;
    setRouteMessage("");
    setUpdateState({ phase: "checking" });
    try {
      if (await developmentBuild()) {
        setUpdateState({ phase: "idle" });
        if (!quiet) onStatus("开发版使用独立数据，不安装正式版更新");
        return;
      }
      const update = await updatesClient.checkDesktop(sourceSettings.source, progress);
      updateRef.current = update;
      if (update) setRoute(update.route);
      setRouteMessage("");
      if (update) {
        setUpdateState({ phase: "available", version: update.version, notes: normalizeUpdateNotes(update.notes) });
        if (!quiet) onStatus(`已检查更新：当前 v${appVersion}，发现最新 v${update.version}`);
      } else {
        setUpdateState({ phase: "current" });
        if (!quiet) onStatus(`已检查更新：当前 v${appVersion}，最新版本也是 v${appVersion}`);
      }
    } catch (error) {
      updateRef.current = null;
      setUpdateState({ phase: "error", message: platformErrorMessage(error, "检查更新失败") });
    } finally { busy.current = false; }
  }

  async function installUpdate() {
    if (!runningInTauri || busy.current || !sourceSettings.loaded) return;
    try {
      if (await developmentBuild()) return;
    } catch (error) {
      setUpdateState({ phase: "error", message: platformErrorMessage(error, "无法确认客户端更新渠道") });
      return;
    }
    const update = updateRef.current;
    if (!update) {
      await checkForUpdates();
      return;
    }
    busy.current = true;
    setUpdateState({ phase: "downloading", version: update.version, downloaded: 0 });
    try {
      await updatesClient.installDesktop(sourceSettings.source, update.version, event => {
        progress(event);
        setUpdateState({ phase: "downloading", version: update.version, downloaded: event.downloaded, total: event.total ?? undefined });
      });
      updateRef.current = null;
      setUpdateState({ phase: "ready", version: update.version });
      await relaunch();
    } catch (error) {
      setUpdateState({ phase: "error", message: `安装更新失败：${platformErrorMessage(error)}` });
    } finally { busy.current = false; }
  }

  useEffect(() => {
    if (runningInTauri) {
      void getVersion().then(setAppVersion).catch(() => {});
      void developmentBuild().then(setIsDevelopment).catch(() => {});
    }
  }, []);
  useEffect(() => { if (sourceSettings.loaded) void checkForUpdates(true); }, [sourceSettings.loaded]);

  return { appVersion, isDevelopment, updateState, checkForUpdates, installUpdate, sourceSettings, route, routeMessage };
}
