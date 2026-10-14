import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
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
  const updateRef = useRef<Update | null>(null);
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
    setUpdateState({ phase: "checking" });
    try {
      if (await developmentBuild()) {
        setUpdateState({ phase: "idle" });
        if (!quiet) onStatus("开发版使用独立数据，不安装正式版更新");
        return;
      }
      const update = await check();
      const previous = updateRef.current;
      updateRef.current = update;
      if (previous && previous !== update) void previous.close();
      if (update) {
        setUpdateState({ phase: "available", version: update.version, notes: normalizeUpdateNotes(update.body) });
        if (!quiet) onStatus(`已检查更新：当前 v${appVersion}，发现最新 v${update.version}`);
      } else {
        setUpdateState({ phase: "current" });
        if (!quiet) onStatus(`已检查更新：当前 v${appVersion}，最新版本也是 v${appVersion}`);
      }
    } catch (error) {
      updateRef.current = null;
      setUpdateState(quiet ? { phase: "idle" } : { phase: "error", message: platformErrorMessage(error, "检查更新失败") });
    }
  }

  async function installUpdate() {
    if (!runningInTauri) return;
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
    let downloaded = 0;
    let total: number | undefined;
    setUpdateState({ phase: "downloading", version: update.version, downloaded, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        else if (event.event === "Progress") downloaded += event.data.chunkLength;
        setUpdateState({ phase: "downloading", version: update.version, downloaded, total });
      });
      updateRef.current = null;
      setUpdateState({ phase: "ready", version: update.version });
      await relaunch();
    } catch (error) {
      setUpdateState({ phase: "error", message: `安装更新失败：${platformErrorMessage(error)}` });
    }
  }

  useEffect(() => {
    if (runningInTauri) {
      void getVersion().then(setAppVersion).catch(() => {});
      void developmentBuild().then(setIsDevelopment).catch(() => {});
    }
    void checkForUpdates(true);
    return () => {
      const update = updateRef.current;
      updateRef.current = null;
      if (update) void update.close();
    };
  }, []);

  return { appVersion, isDevelopment, updateState, checkForUpdates, installUpdate };
}
