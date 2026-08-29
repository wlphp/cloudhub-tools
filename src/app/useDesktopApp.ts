import { type MouseEvent, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { runningInTauri } from "../platform/api";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string; notes?: string }
  | { phase: "downloading"; version: string; downloaded: number; total?: number }
  | { phase: "ready"; version: string }
  | { phase: "current" }
  | { phase: "error"; message: string };

type DesktopAppOptions = {
  bundledVersion: string;
  notify: (message: string) => void;
};

export function useDesktopApp({ bundledVersion, notify }: DesktopAppOptions) {
  const [appVersion, setAppVersion] = useState(bundledVersion);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: "idle" });
  const updateRef = useRef<Update | null>(null);

  async function performWindowAction(action: "minimize" | "toggleMaximize" | "close") {
    if (!runningInTauri) return;
    try {
      const appWindow = getCurrentWindow();
      if (action === "toggleMaximize") {
        await appWindow.toggleMaximize();
        setWindowMaximized(await appWindow.isMaximized());
        return;
      }
      await appWindow[action]();
    } catch (error) {
      notify("窗口操作失败：" + String(error));
    }
  }

  function handleTitlebarMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (!runningInTauri || event.button !== 0 || event.detail !== 1) return;
    void getCurrentWindow().startDragging();
  }

  function handleTitlebarDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (!runningInTauri || event.button !== 0) return;
    event.preventDefault();
    void performWindowAction("toggleMaximize");
  }

  async function checkForUpdates(quiet = false) {
    if (!runningInTauri) {
      setUpdateState({ phase: "idle" });
      return;
    }
    setUpdateState({ phase: "checking" });
    try {
      const update = await check();
      const previous = updateRef.current;
      updateRef.current = update;
      if (previous && previous !== update) void previous.close();
      if (update) {
        setUpdateState({ phase: "available", version: update.version, notes: update.body });
        if (!quiet) notify("已检查更新：当前 v" + appVersion + "，发现最新 v" + update.version);
      } else {
        setUpdateState({ phase: "current" });
        if (!quiet) notify("已检查更新：当前 v" + appVersion + "，最新版本也是 v" + appVersion);
      }
    } catch (error) {
      updateRef.current = null;
      setUpdateState(quiet ? { phase: "idle" } : { phase: "error", message: String(error) });
    }
  }

  async function installUpdate() {
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
      setUpdateState({ phase: "error", message: "安装更新失败：" + String(error) });
    }
  }

  useEffect(() => {
    if (!runningInTauri) return;
    const appWindow = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | undefined;
    const syncWindowMaximized = async () => {
      try {
        const maximized = await appWindow.isMaximized();
        if (active) setWindowMaximized(maximized);
      } catch {}
    };
    void syncWindowMaximized();
    void appWindow.onResized(() => { void syncWindowMaximized(); }).then((listener) => {
      if (active) unlisten = listener;
      else listener();
    }).catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (runningInTauri) void getVersion().then(setAppVersion).catch(() => {});
    void checkForUpdates(true);
    return () => {
      const update = updateRef.current;
      updateRef.current = null;
      if (update) void update.close();
    };
  }, []);

  return {
    appVersion,
    windowMaximized,
    updateState,
    performWindowAction,
    handleTitlebarMouseDown,
    handleTitlebarDoubleClick,
    checkForUpdates,
    installUpdate,
  };
}
