import { lazy, Suspense } from "react";
import { HardwareInfoPlugin } from "./HardwareInfoPlugin";
import { WslDashboardPlugin } from "./WslDashboardPlugin";
import { WechatPluginSettings } from "./WechatPluginSettings";
import { ClaudeProvidersPlugin } from "./ClaudeProvidersPlugin";
import { NotesPanel } from "../notes/NotesPanel";
import { LanDevicesPlugin } from "./LanDevicesPlugin";
import { EnvironmentVariablesPlugin } from "./EnvironmentVariablesPlugin";
import { StartupManagerPlugin } from "./StartupManagerPlugin";
import { WindowsToolboxPlugin } from "./WindowsToolboxPlugin";
import { HttpDebugProxyPlugin } from "./HttpDebugProxyPlugin";
import type { Account, LocalAsset } from "../../shared/types";

const BrowserEnvironments = lazy(() => import("./BrowserEnvironments").then(module => ({ default: module.BrowserEnvironments })));
const NetworkSpeedPlugin = lazy(() => import("./NetworkSpeedPlugin").then(module => ({ default: module.NetworkSpeedPlugin })));
const MailPlugin = lazy(() => import("../mail/MailPlugin").then(module => ({ default: module.MailPlugin })));
const CloudDrivePlugin = lazy(() => import("./CloudDrivePlugin").then(module => ({ default: module.CloudDrivePlugin })));
const FlowPanel = lazy(() => import("../flow/FlowPanel").then(module => ({ default: module.FlowPanel })));
const AuthenticatorPanel = lazy(() => import("../authenticator/AuthenticatorPanel").then(module => ({ default: module.AuthenticatorPanel })));
const CertificatePanel = lazy(() => import("../certificates/CertificatePanel").then(module => ({ default: module.CertificatePanel })));
const CodexPanel = lazy(() => import("../codex/CodexPanel").then(module => ({ default: module.CodexPanel })));
const FrpPanel = lazy(() => import("../frp/FrpPanel").then(module => ({ default: module.FrpPanel })));
const AiSettings = lazy(() => import("../ai/AiSettings").then(module => ({ default: module.AiSettings })));

/** Page and dialog containers share the same business UI. */
export function PluginApplication({ pluginId, wslEnabled, mobile = false, accounts = [], localAssets = [], onStatus = () => {}, onConfirm = async () => false, onNotify, onError, onLanConnect }: {
  pluginId: string;
  wslEnabled: boolean;
  mobile?: boolean;
  accounts?: Account[];
  localAssets?: LocalAsset[];
  onStatus?: (message: string) => void;
  onConfirm?: (message: string) => Promise<boolean>;
  onNotify?: (message: string) => void;
  onError?: (message: string) => void;
  onLanConnect?: (ip: string, platform: "linux" | "windows", name: string) => void;
}) {
  switch (pluginId) {
    case "cloudhub.model-suppliers": return <Suspense fallback={<p role="status">正在加载模型供应商…</p>}><AiSettings embedded /></Suspense>;
    case "cloudhub.cloud-drive": return <Suspense fallback={<p role="status">正在加载云盘挂载…</p>}><CloudDrivePlugin /></Suspense>;
    case "cloudhub.mail": return <Suspense fallback={<p role="status">正在加载邮件管理…</p>}><MailPlugin /></Suspense>;
    case "cloudhub.flow": return <Suspense fallback={<p role="status">正在加载流水线…</p>}><FlowPanel mobile={mobile} /></Suspense>;
    case "cloudhub.authenticator": return <Suspense fallback={<p role="status">正在加载身份验证器…</p>}><AuthenticatorPanel mobile={mobile} /></Suspense>;
    case "cloudhub.certificates": return <Suspense fallback={<p role="status">正在加载 HTTPS 证书…</p>}><CertificatePanel accounts={accounts} localAssets={localAssets} onStatus={onStatus} onConfirm={onConfirm} /></Suspense>;
    case "cloudhub.codex": return <Suspense fallback={<p role="status">正在加载 Codex 管理…</p>}><CodexPanel /></Suspense>;
    case "cloudhub.frp": return <Suspense fallback={<p role="status">正在加载内网穿透…</p>}><FrpPanel /></Suspense>;
    case "cloudhub.wechat-multi": return <WechatPluginSettings onNotify={onNotify} onError={onError} />;
    case "cloudhub.hardware-info": return <HardwareInfoPlugin open onOpened={() => {}} />;
    case "cloudhub.wsl-dashboard": return <WslDashboardPlugin open enabled={wslEnabled} />;
    case "cloudhub.fingerprint-browser": return <Suspense fallback={<p role="status">正在加载浏览器环境…</p>}><BrowserEnvironments open /></Suspense>;
    case "cloudhub.claude-providers": return <div className="claude-providers-dialog"><ClaudeProvidersPlugin mobile={mobile} /></div>;
    case "cloudhub.notes": return <NotesPanel mobile={mobile} />;
    case "cloudhub.lan-devices": return <LanDevicesPlugin onConnect={onLanConnect} />;
    case "cloudhub.network-speed": return <Suspense fallback={<p role="status">正在加载网络测速…</p>}><NetworkSpeedPlugin /></Suspense>;
    case "cloudhub.http-debug-proxy": return <HttpDebugProxyPlugin />;
    case "cloudhub.environment-variables": return <EnvironmentVariablesPlugin />;
    case "cloudhub.startup-manager": return <StartupManagerPlugin />;
    case "cloudhub.windows-toolbox": return <WindowsToolboxPlugin />;
    default: return null;
  }
}
