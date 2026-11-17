import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platformErrorMessage, runningInTauri } from "../platform/api";
import packageJson from "../../package.json";
import { updatesClient, type UpdateRoute, type UpdateProgress, type MobileUpdate as Info } from "../platform/clients/updates";
import { useUpdateSource } from "../features/app/useUpdateSource";

const RELEASES = "https://github.com/wlphp/cloudhub-tools/releases/latest";
type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";
export function useMobileUpdates() {
  const android = runningInTauri && /Android/i.test(navigator.userAgent);
  const sourceSettings = useUpdateSource();
  const [route, setRoute] = useState<UpdateRoute>();
  const [routeMessage, setRouteMessage] = useState("");
  const onProgress = (event: UpdateProgress) => { setRoute(event.route); setRouteMessage(event.message); };
  const [info, setInfo] = useState<Info | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState({ downloaded: 0, total: 0 });
  const busy = useRef(false);
  const ready = useRef(false);
  const lastCheck = useRef(0);
  const check = useCallback(async (_quiet = false) => {
    if (busy.current || ready.current || !sourceSettings.loaded) return;
    busy.current = true;
    lastCheck.current = Date.now();
    setPhase("checking"); setMessage("");
    try {
      let update: Info;
      if (android) update = await updatesClient.checkAndroid(sourceSettings.source, onProgress);
      else {
        const release = await updatesClient.info(sourceSettings.source);
        const version = release.version;
        const current = packageJson.version.split(".").map(Number);
        const next = version.split(".").map(Number);
        const difference = next.findIndex((value: number, i: number) => value !== current[i]);
        update = { version, available: difference >= 0 && next[difference] > current[difference], notes: release.notes, size: 0, downloadable: false, route: release.route };
      }
      setRoute(update.route); setRouteMessage("");
      setInfo(update);
      setPhase(update.available ? "available" : "current");
      setMessage("");
    } catch {
      setPhase("error"); setMessage("所选更新线路不可用，请切换线路后重试。");
    } finally { busy.current = false; }
  }, [android, sourceSettings.loaded, sourceSettings.source]);

  useEffect(() => {
    if (!android || !sourceSettings.loaded) return;
    void check(true);
    const resume = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheck.current > 6 * 60 * 60 * 1000) void check(true);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [android, check]);

  async function download() {
    if (!android || !info?.downloadable || busy.current) return;
    busy.current = true;
    setPhase("downloading"); setMessage(""); setProgress({ downloaded: 0, total: info.size });
    try {
      await updatesClient.downloadAndroid(sourceSettings.source, info.version, event => {
        onProgress(event);
        setProgress({ downloaded: event.downloaded, total: event.total ?? 0 });
      });
      ready.current = true; setPhase("ready"); setMessage("下载已校验，点击安装更新。");
    } catch (error) {
      setPhase("available"); setMessage(platformErrorMessage(error, "下载失败，请重试。"));
    } finally { busy.current = false; }
  }
  async function cancel() {
    if (phase !== "downloading") return;
    setMessage("正在取消下载…");
    try { await invoke("plugin:cloudhub-mobile-updater|cancel"); } catch { setMessage("取消失败，请重试。"); }
  }
  async function install() {
    if (!android || !ready.current || busy.current) return;
    busy.current = true; setPhase("installing"); setMessage("");
    try {
      const status = await invoke<string>("plugin:cloudhub-mobile-updater|install");
      setMessage(status === "permission_required" ? "请允许安装应用，返回后再次点击安装更新。" : status === "installer_opened" ? "请在系统安装器确认安装；取消后可再次尝试。" : "无法启动安装，请重试。");
    } catch (error) { setMessage(typeof error === "string" ? error : "安装失败，请重试。"); }
    finally { setPhase("ready"); busy.current = false; }
  }
  async function openReleases() {
    try {
      if (runningInTauri) await openUrl(RELEASES);
      else window.open(RELEASES, "_blank", "noopener,noreferrer");
    } catch { setMessage("无法打开发布页，请稍后重试。"); }
  }
  return { android, info, phase, message, progress, check, download, cancel, install, openReleases, sourceSettings, route, routeMessage };
}
