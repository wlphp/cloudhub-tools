import { lazy, Suspense } from "react";
import { HardwareInfoPlugin } from "./HardwareInfoPlugin";
import { WslDashboardPlugin } from "./WslDashboardPlugin";
import { WechatPluginSettings } from "./WechatPluginSettings";
import { ClaudeProvidersPlugin } from "./ClaudeProvidersPlugin";
import { NotesPanel } from "../notes/NotesPanel";
import { LanDevicesPlugin } from "./LanDevicesPlugin";

const BrowserEnvironments = lazy(() => import("./BrowserEnvironments").then(module => ({ default: module.BrowserEnvironments })));
const NetworkSpeedPlugin = lazy(() => import("./NetworkSpeedPlugin").then(module => ({ default: module.NetworkSpeedPlugin })));
const MailPlugin = lazy(() => import("../mail/MailPlugin").then(module => ({ default: module.MailPlugin })));
const CloudDrivePlugin = lazy(() => import("./CloudDrivePlugin").then(module => ({ default: module.CloudDrivePlugin })));

/** Page and dialog containers share the same business UI. */
export function PluginApplication({ pluginId, wslEnabled, onNotify, onError, onLanConnect }: {
  pluginId: string;
  wslEnabled: boolean;
  onNotify?: (message: string) => void;
  onError?: (message: string) => void;
  onLanConnect?: (ip: string, platform: "linux" | "windows", name: string) => void;
}) {
  switch (pluginId) {
    case "cloudhub.cloud-drive": return <Suspense fallback={<p role="status">正在加载云盘挂载…</p>}><CloudDrivePlugin /></Suspense>;
    case "cloudhub.mail": return <Suspense fallback={<p role="status">正在加载邮件管理…</p>}><MailPlugin /></Suspense>;
    case "cloudhub.wechat-multi": return <WechatPluginSettings onNotify={onNotify} onError={onError} />;
    case "cloudhub.hardware-info": return <HardwareInfoPlugin open onOpened={() => {}} />;
    case "cloudhub.wsl-dashboard": return <WslDashboardPlugin open enabled={wslEnabled} />;
    case "cloudhub.fingerprint-browser": return <Suspense fallback={<p role="status">正在加载浏览器环境…</p>}><BrowserEnvironments open /></Suspense>;
    case "cloudhub.claude-providers": return <div className="claude-providers-dialog"><ClaudeProvidersPlugin /></div>;
    case "cloudhub.notes": return <NotesPanel />;
    case "cloudhub.lan-devices": return <LanDevicesPlugin onConnect={onLanConnect} />;
    case "cloudhub.network-speed": return <Suspense fallback={<p role="status">正在加载网络测速…</p>}><NetworkSpeedPlugin /></Suspense>;
    default: return null;
  }
}
