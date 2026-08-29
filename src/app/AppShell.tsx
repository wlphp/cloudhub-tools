import type { CSSProperties, MouseEvent, PointerEvent, ReactNode, RefObject } from "react";
import {
  Cloud,
  Database,
  FileText,
  Maximize2,
  Minimize2,
  Minus,
  Monitor,
  Server,
  Settings,
  Star,
  Terminal,
  X,
} from "lucide-react";

export type AppSection =
  | "accounts"
  | "resources"
  | "panels"
  | "servers"
  | "favorites"
  | "logs"
  | "api_logs"
  | "settings";

type AppShellProps = {
  children: ReactNode;
  shellRef: RefObject<HTMLDivElement | null>;
  sidebarWidth: number;
  section: AppSection;
  appVersion: string;
  isDevelopmentBuild: boolean;
  runningInTauri: boolean;
  windowMaximized: boolean;
  onNavigate: (section: AppSection) => void;
  onSidebarResize: (event: PointerEvent<HTMLDivElement>) => void;
  onTitlebarMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  onTitlebarDoubleClick: (event: MouseEvent<HTMLDivElement>) => void;
  onWindowAction: (action: "minimize" | "toggleMaximize" | "close") => void;
};

const navigationItems: Array<{
  section: AppSection;
  desktopLabel: string;
  mobileLabel: string;
  Icon: typeof Database;
}> = [
  { section: "accounts", desktopLabel: "账号管理", mobileLabel: "账号", Icon: Database },
  { section: "resources", desktopLabel: "资产管理", mobileLabel: "资产", Icon: Server },
  { section: "favorites", desktopLabel: "我的收藏", mobileLabel: "收藏", Icon: Star },
  { section: "panels", desktopLabel: "面板管理", mobileLabel: "面板", Icon: Monitor },
  { section: "servers", desktopLabel: "终端管理", mobileLabel: "终端", Icon: Terminal },
  { section: "logs", desktopLabel: "操作日志", mobileLabel: "日志", Icon: FileText },
  { section: "api_logs", desktopLabel: "API日志", mobileLabel: "API 日志", Icon: Terminal },
  { section: "settings", desktopLabel: "系统设置", mobileLabel: "设置", Icon: Settings },
];

export function AppShell({
  children,
  shellRef,
  sidebarWidth,
  section,
  appVersion,
  isDevelopmentBuild,
  runningInTauri,
  windowMaximized,
  onNavigate,
  onSidebarResize,
  onTitlebarMouseDown,
  onTitlebarDoubleClick,
  onWindowAction,
}: AppShellProps) {
  return (
    <div className="app-shell ide-theme" ref={shellRef} style={{ "--app-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="ide-topbar" role="banner">
        <div className="ide-topbar-brand" onMouseDown={onTitlebarMouseDown} onDoubleClick={onTitlebarDoubleClick}><Cloud size={15} /><strong>云枢 Tools</strong><span>本地多云资源管理</span></div>
        <div className="ide-topbar-drag-region" aria-hidden="true" onMouseDown={onTitlebarMouseDown} onDoubleClick={onTitlebarDoubleClick} />
        <div className="ide-topbar-actions">
          <div className="ide-topbar-context"><span className="ide-topbar-dot" />LOCAL</div>
          {runningInTauri && <div className="ide-window-controls" aria-label="窗口控制">
            <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => onWindowAction("minimize")}><Minus size={14} /></button>
            <button type="button" aria-label={windowMaximized ? "还原窗口" : "最大化窗口"} title={windowMaximized ? "还原窗口" : "最大化窗口"} aria-pressed={windowMaximized} onClick={() => onWindowAction("toggleMaximize")}>{windowMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
            <button type="button" className="ide-window-close" aria-label="关闭窗口" title="关闭" onClick={() => onWindowAction("close")}><X size={15} /></button>
          </div>}
        </div>
      </div>
      <aside style={{ flexBasis: sidebarWidth, width: sidebarWidth }}>
        <div className="brand"><div className="brand-mark"><img src="/cloudhub-logo.png" alt="云枢 Tools" /></div><div><strong>云枢 Tools <span className="brand-version">v{appVersion}</span>{isDevelopmentBuild ? <span className="brand-dev-badge">本地开发版</span> : null}</strong><small>本地多云资源管家</small></div></div>
        <nav aria-label="主导航">{navigationItems.map(({ section: itemSection, desktopLabel, Icon }) => <button key={itemSection} type="button" className={section === itemSection ? "nav-active" : ""} aria-current={section === itemSection ? "page" : undefined} onClick={() => onNavigate(itemSection)}><Icon size={18} />{desktopLabel}</button>)}</nav>
      </aside>
      <div className="app-sidebar-resizer" role="separator" aria-label="调整主导航宽度" aria-orientation="vertical" onPointerDown={onSidebarResize} />
      <main id="main-content">
        <nav className="mobile-nav-bar" aria-label="移动端主导航"><div className="mobile-nav-scroll">{navigationItems.map(({ section: itemSection, mobileLabel, Icon }) => <button key={itemSection} type="button" className={section === itemSection ? "nav-active" : ""} aria-current={section === itemSection ? "page" : undefined} onClick={() => onNavigate(itemSection)}><Icon size={16} /><span>{mobileLabel}</span></button>)}</div></nav>
        {children}
      </main>
    </div>
  );
}
