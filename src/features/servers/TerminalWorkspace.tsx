import type { PointerEvent, RefObject } from "react";
import { Keyboard, Palette, PanelRightClose, PanelRightOpen, Plus, Terminal, X } from "lucide-react";
import { RemoteFileManager } from "./RemoteFileManager";
import type { ManagedHost, SshFileEntry, TerminalWorkspaceTab } from "../../shared/types";

type FileEditor = { path: string; content: string } | null;
type TerminalTheme = { label: string };

type TerminalWorkspaceProps = {
  tabs: TerminalWorkspaceTab[];
  activeTabId: string | null;
  managedHosts: ManagedHost[];
  sessionId: string;
  host: string;
  port: number;
  username: string;
  themes: Record<string, TerminalTheme>;
  themeName: string;
  themeMenuOpen: boolean;
  filePaneCollapsed: boolean;
  filePaneWidth: number;
  fileDragActive: boolean;
  files: SshFileEntry[];
  filePath: string;
  filesLoading: boolean;
  fileError: string;
  fileEditor: FileEditor;
  fileSaving: boolean;
  workspaceRef: RefObject<HTMLDivElement | null>;
  terminalHostRef: RefObject<HTMLDivElement | null>;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  onActivateTab: (tab: TerminalWorkspaceTab) => void;
  onCloseTab: (id: string) => void;
  onFilePaneCollapsedChange: (value: boolean) => void;
  onCompleteCommand: () => void;
  onThemeMenuOpenChange: (value: boolean) => void;
  onThemeNameChange: (name: string) => void;
  onClearTerminal: () => void;
  onDisconnect: () => void;
  onFileResize: (event: PointerEvent<HTMLDivElement>) => void;
  onFileDragActiveChange: (value: boolean) => void;
  onLoadFiles: (path?: string) => void;
  onFilePathChange: (value: string) => void;
  onUploadFiles: (files: FileList) => void;
  onMakeDirectory: () => void;
  onOpenFile: (entry: SshFileEntry) => void;
  onDownloadFile: (entry: SshFileEntry) => void;
  onDeleteEntry: (entry: SshFileEntry) => void;
  onCloseFileEditor: () => void;
  onFileContentChange: (value: string) => void;
  onSaveFile: () => void;
  fileSize: (size: number) => string;
  parentPath: (path: string) => string;
  onAddHost: () => void;
};

export function TerminalWorkspace({
  tabs,
  activeTabId,
  managedHosts,
  sessionId,
  host,
  port,
  username,
  themes,
  themeName,
  themeMenuOpen,
  filePaneCollapsed,
  filePaneWidth,
  fileDragActive,
  files,
  filePath,
  filesLoading,
  fileError,
  fileEditor,
  fileSaving,
  workspaceRef,
  terminalHostRef,
  uploadInputRef,
  onActivateTab,
  onCloseTab,
  onFilePaneCollapsedChange,
  onCompleteCommand,
  onThemeMenuOpenChange,
  onThemeNameChange,
  onClearTerminal,
  onDisconnect,
  onFileResize,
  onFileDragActiveChange,
  onLoadFiles,
  onFilePathChange,
  onUploadFiles,
  onMakeDirectory,
  onOpenFile,
  onDownloadFile,
  onDeleteEntry,
  onCloseFileEditor,
  onFileContentChange,
  onSaveFile,
  fileSize,
  parentPath,
  onAddHost,
}: TerminalWorkspaceProps) {
  return <section className="terminal-stage">
    <div className="terminal-tabs" role="tablist" aria-label="SSH 终端标签">
      {tabs.map((tab) => {
        const label = tab.target.managedHostId
          ? managedHosts.find((item) => item.id === tab.target.managedHostId)?.name || "SSH 终端"
          : String(tab.target.asset.payload.InstanceName || tab.target.asset.asset_key);
        const activeTab = tab.id === activeTabId;
        return <div className={`terminal-tab${activeTab ? " active" : ""}`} key={tab.id} role="presentation">
          <button type="button" className="terminal-tab-select" role="tab" aria-selected={activeTab} title={`${label} · ${tab.username}@${tab.host}`} onClick={() => onActivateTab(tab)}><Terminal size={15} /><span>{label}</span><i /></button>
          <button type="button" className="terminal-tab-close" title={`关闭 ${label}`} aria-label={`关闭 ${label}`} onClick={() => onCloseTab(tab.id)}><X size={14} /></button>
        </div>;
      })}
      {sessionId && <button type="button" title={filePaneCollapsed ? "展开文件管理" : "收起文件管理"} aria-label={filePaneCollapsed ? "展开文件管理" : "收起文件管理"} onClick={() => onFilePaneCollapsedChange(!filePaneCollapsed)}>{filePaneCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}</button>}
    </div>
    {sessionId ? <div className="terminal-session-shell">
      <div className="ssh-terminal-meta">
        <span>{username}@{host}:{port}</span><span className="ssh-connected">已连接</span>
        <button type="button" className="ssh-terminal-command" title="命令补全 (Tab)" aria-label="命令补全 (Tab)" onClick={onCompleteCommand}><Keyboard size={16} /></button>
        <span className="ssh-terminal-theme">
          <button type="button" className="ssh-terminal-command" title="终端配色" aria-label="终端配色" aria-expanded={themeMenuOpen} onClick={() => onThemeMenuOpenChange(!themeMenuOpen)}><Palette size={16} /></button>
          {themeMenuOpen && <span className="ssh-terminal-theme-menu">{Object.entries(themes).map(([name, theme]) => <button type="button" className={themeName === name ? "active" : ""} key={name} onClick={() => { onThemeNameChange(name); onThemeMenuOpenChange(false); }}>{theme.label}</button>)}</span>}
        </span>
        <button type="button" className="ssh-clear-button" onClick={onClearTerminal}>清屏</button>
        <button type="button" className="ssh-disconnect-button" onClick={onDisconnect}>断开</button>
      </div>
      <div ref={workspaceRef} className="ssh-terminal-workspace" style={{ gridTemplateColumns: `minmax(360px, 1fr) 8px minmax(330px, ${filePaneWidth}px)` }}>
        <div className="ssh-terminal-viewport" ref={terminalHostRef} aria-label="SSH 终端" />
        <RemoteFileManager
          dragActive={fileDragActive}
          files={files}
          path={filePath}
          loading={filesLoading}
          error={fileError}
          editor={fileEditor}
          saving={fileSaving}
          uploadInputRef={uploadInputRef}
          onResize={onFileResize}
          onDragActiveChange={onFileDragActiveChange}
          onLoad={onLoadFiles}
          onPathChange={onFilePathChange}
          onUpload={onUploadFiles}
          onMakeDirectory={onMakeDirectory}
          onOpen={onOpenFile}
          onDownload={onDownloadFile}
          onDelete={onDeleteEntry}
          onCloseEditor={onCloseFileEditor}
          onContentChange={onFileContentChange}
          onSave={onSaveFile}
          fileSize={fileSize}
          parentPath={parentPath}
        />
      </div>
      {fileError && <div className="error-list ssh-error">{fileError}</div>}
    </div> : <div className="terminal-stage-empty"><Terminal size={54} /><h1>选择一台服务器开始连接</h1><p>从左侧服务器列表打开 SSH 终端，连接后可在右侧直接浏览和管理远程文件。</p><button type="button" className="layui-btn layui-btn-normal" onClick={onAddHost}><Plus size={16} />添加服务器</button></div>}
  </section>;
}
