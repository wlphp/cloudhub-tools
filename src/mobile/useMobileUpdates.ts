import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { runningInTauri } from "../platform/api";
import packageJson from "../../package.json";

const RELEASES = "https://github.com/wlphp/cloudhub-tools/releases/latest";
const API = "https://api.github.com/repos/wlphp/cloudhub-tools/releases/latest";
type Info = { version: string; available: boolean; notes: string; size: number; downloadable: boolean };
type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";
export function useMobileUpdates() {
  const android = runningInTauri && /Android/i.test(navigator.userAgent);
  const [info, setInfo] = useState<Info | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState({ downloaded: 0, total: 0 });
  const busy = useRef(false);
  const ready = useRef(false);
  const lastCheck = useRef(0);
  const check = useCallback(async (quiet = false) => {
    if (busy.current || ready.current) return;
    busy.current = true;
    lastCheck.current = Date.now();
    if (!quiet) { setPhase("checking"); setMessage(""); }
    try {
      let update: Info;
      if (android) update = await invoke<Info>("plugin:cloudhub-mobile-updater|check");
      else {
        const response = await fetch(API, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error();
        const release = await response.json();
        if (!/^v?\d+\.\d+\.\d+$/.test(release.tag_name) || release.draft || release.prerelease) throw new Error();
        const version = release.tag_name.replace(/^v/, "");
        const current = packageJson.version.split(".").map(Number);
        const next = version.split(".").map(Number);
        const difference = next.findIndex((value: number, i: number) => value !== current[i]);
        update = { version, available: difference >= 0 && next[difference] > current[difference], notes: typeof release.body === "string" ? release.body.slice(0, 8000) : "", size: 0, downloadable: false };
      }
      setInfo(update);
      setPhase(update.available ? "available" : "current");
      setMessage("");
    } catch {
      if (!quiet) { setPhase("error"); setMessage("检查失败，请检查网络后重试。"); }
    } finally { busy.current = false; }
  }, [android]);

  useEffect(() => {
    if (!android) return;
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
    const channel = new Channel<{ downloaded: number; total: number }>();
    channel.onmessage = setProgress;
    try {
      await invoke("plugin:cloudhub-mobile-updater|download", { expectedVersion: info.version, onProgress: channel });
      ready.current = true; setPhase("ready"); setMessage("下载已校验，点击安装更新。");
    } catch (error) {
      setPhase("available"); setMessage(typeof error === "string" ? error : "下载失败，请重试。");
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
  return { android, info, phase, message, progress, check, download, cancel, install, openReleases };
}
