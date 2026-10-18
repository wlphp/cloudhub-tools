import { lazy, Suspense } from "react";
import { HardwareInfoPlugin } from "./HardwareInfoPlugin";
import { WslDashboardPlugin } from "./WslDashboardPlugin";
import { WechatPluginSettings } from "./WechatPluginSettings";
import { ClaudeProvidersPlugin } from "./ClaudeProvidersPlugin";
import { NotesPanel } from "../notes/NotesPanel";

const BrowserEnvironments = lazy(() => import("./BrowserEnvironments").then(module => ({ default: module.BrowserEnvironments })));

/** Page and dialog containers share the same business UI. */
export function PluginApplication({ pluginId, wslEnabled, onNotify, onError }: {
  pluginId: string;
  wslEnabled: boolean;
  onNotify?: (message: string) => void;
  onError?: (message: string) => void;
}) {
  switch (pluginId) {
    case "cloudhub.wechat-multi": return <WechatPluginSettings onNotify={onNotify} onError={onError} />;
    case "cloudhub.hardware-info": return <HardwareInfoPlugin open onOpened={() => {}} />;
    case "cloudhub.wsl-dashboard": return <WslDashboardPlugin open enabled={wslEnabled} />;
    case "cloudhub.fingerprint-browser": return <Suspense fallback={<p role="status">正在加载浏览器环境…</p>}><BrowserEnvironments open /></Suspense>;
    case "cloudhub.claude-providers": return <div className="claude-providers-dialog"><ClaudeProvidersPlugin /></div>;
    case "cloudhub.notes": return <NotesPanel />;
    default: return null;
  }
}
