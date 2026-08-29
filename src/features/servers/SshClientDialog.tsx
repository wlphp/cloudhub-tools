import type { FormEvent, PointerEvent, RefObject } from "react";
import { Eye, EyeOff, Keyboard, Maximize2, Minimize2, PanelRightOpen, RefreshCw, Terminal, X } from "lucide-react";
import { RemoteFileManager } from "./RemoteFileManager";
import type { SshAuthMethod, SshFileEntry, SshTarget } from "../../shared/types";

type FileEditor = { path: string; content: string } | null;

type SshClientDialogProps = {
  target: SshTarget;
  maximized: boolean;
  sessionId: string;
  platform: "linux" | "windows";
  authMethod: SshAuthMethod;
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  keyPassphrase: string;
  showPassword: boolean;
  savePassword: boolean;
  passwordSaved: boolean;
  passwordRevealing: boolean;
  testing: boolean;
  connecting: boolean;
  error: string;
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
  displayValue: (value: unknown) => string;
  onClose: () => void;
  onMaximizedChange: (value: boolean) => void;
  onPlatformChange: (value: "linux" | "windows") => void;
  onAuthMethodChange: (value: SshAuthMethod) => void;
  onHostChange: (value: string) => void;
  onPortChange: (value: number) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onPrivateKeyChange: (value: string) => void;
  onKeyPassphraseChange: (value: string) => void;
  onShowPasswordChange: (value: boolean) => void;
  onSavePasswordChange: (value: boolean) => void;
  onTogglePassword: () => void;
  onClearSavedConnection: () => void;
  onTest: () => void;
  onConnect: () => void;
  onCompleteCommand: () => void;
  onClearTerminal: () => void;
  onDisconnect: () => void;
  onFilePaneCollapsedChange: (value: boolean) => void;
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
};

export function SshClientDialog({
  target,
  maximized,
  sessionId,
  platform,
  authMethod,
  host,
  port,
  username,
  password,
  privateKey,
  keyPassphrase,
  showPassword,
  savePassword,
  passwordSaved,
  passwordRevealing,
  testing,
  connecting,
  error,
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
  displayValue,
  onClose,
  onMaximizedChange,
  onPlatformChange,
  onAuthMethodChange,
  onHostChange,
  onPortChange,
  onUsernameChange,
  onPasswordChange,
  onPrivateKeyChange,
  onKeyPassphraseChange,
  onShowPasswordChange,
  onSavePasswordChange,
  onTogglePassword,
  onClearSavedConnection,
  onTest,
  onConnect,
  onCompleteCommand,
  onClearTerminal,
  onDisconnect,
  onFilePaneCollapsedChange,
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
}: SshClientDialogProps) {
  const isWindows = platform === "windows";
  const title = target.direct ? "快速连接" : `${isWindows ? "RDP 登录" : "SSH 登录"} · ${displayValue(target.asset.payload.InstanceName || target.asset.asset_key)}`;
  return <div className="resource-modal-backdrop ssh-modal-backdrop">
    <section className={`detail-panel resource-modal ssh-modal${maximized ? " is-maximized" : ""}${!sessionId ? " is-connect" : ""}`} onClick={(event) => event.stopPropagation()}>
      <div className="detail-toolbar">
        <div><span className="eyebrow">{target.direct ? "QUICK CONNECT" : target.asset.resource_type === "swas" ? "LIGHTHOUSE" : "SERVER"}</span><h2><Terminal size={18} /> {title}</h2></div>
        <div className="detail-toolbar-actions">{sessionId && <button className="close-detail" type="button" title={maximized ? "退出全屏" : "全屏"} aria-label={maximized ? "退出全屏" : "全屏"} onClick={() => onMaximizedChange(!maximized)}>{maximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>}<button className="close-detail" type="button" title="关闭 SSH" onClick={onClose}><X size={20} /></button></div>
      </div>
      {!sessionId ? <form className="ssh-connect-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onConnect(); }}>
        <div className="ssh-form-grid">
          <div className="ssh-choice-row ssh-platform-row"><span>操作系统</span><div className="ssh-segmented"><button type="button" className={platform === "linux" ? "active" : ""} onClick={() => onPlatformChange("linux")}>Linux</button><button type="button" className={isWindows ? "active" : ""} onClick={() => onPlatformChange("windows")}>Windows</button></div></div>
          <label className="ssh-form-host">主机<input value={host} onChange={(event) => onHostChange(event.target.value)} placeholder="公网 IP 或域名" autoFocus /></label>
          <label>端口<input type="number" min={1} max={65535} value={port} onChange={(event) => onPortChange(Number(event.target.value) || (isWindows ? 3389 : 22))} /></label>
          <label>用户名<input value={username} onChange={(event) => onUsernameChange(event.target.value)} placeholder={isWindows ? "administrator" : "root"} /></label>
          {platform === "linux" && <div className="ssh-choice-row ssh-auth-row"><span>验证方式</span><div className="ssh-segmented"><button type="button" className={authMethod === "password" ? "active" : ""} onClick={() => onAuthMethodChange("password")}>密码验证</button><button type="button" className={authMethod === "private_key" ? "active" : ""} onClick={() => { onAuthMethodChange("private_key"); onShowPasswordChange(false); }}>私钥验证</button></div></div>}
          {isWindows || authMethod === "password" ? <label className="ssh-form-password">{isWindows ? "密码（可选）" : "密码"}<span className="ssh-password-wrap"><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => onPasswordChange(event.target.value)} placeholder={isWindows ? (passwordSaved ? "已保存本地记录" : "由 Windows 远程桌面验证") : (passwordSaved ? "已保存密码，可直接连接" : "请输入 SSH 密码")} autoComplete="current-password" /><button type="button" className="ssh-password-toggle" disabled={passwordRevealing} title={passwordRevealing ? "正在读取密码" : showPassword ? "隐藏密码" : passwordSaved ? "读取当前保存密码" : "显示密码"} aria-label={passwordRevealing ? "正在读取密码" : showPassword ? "隐藏密码" : passwordSaved ? "读取当前保存密码" : "显示密码"} onClick={onTogglePassword}>{passwordRevealing ? <RefreshCw size={16} className="spin" /> : showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label> : <><label className="ssh-form-password">私钥<textarea value={privateKey} onChange={(event) => onPrivateKeyChange(event.target.value)} placeholder={passwordSaved ? "已保存私钥，可直接连接或粘贴替换" : "粘贴 OpenSSH、PKCS#8 或 PEM 格式私钥"} spellCheck={false} /></label><label className="ssh-form-passphrase">私钥口令<input type="password" value={keyPassphrase} onChange={(event) => onKeyPassphraseChange(event.target.value)} placeholder="未加密私钥可留空" autoComplete="off" /></label></>}
          {platform === "linux" && <label className="ssh-proxy-field">代理<select value=""><option value="">不使用代理</option></select></label>}
        </div>
        {(isWindows || authMethod === "password") && !target.direct && <div className="ssh-save-row"><label className="toggle"><input type="checkbox" checked={savePassword} onChange={(event) => onSavePasswordChange(event.target.checked)} /><span>{isWindows ? "保存连接资料到本机" : "保存密码到本机"}</span></label>{passwordSaved && <button type="button" className="ssh-clear-button" onClick={onClearSavedConnection}>清除已保存配置</button>}</div>}
        {error && <div className="error-list ssh-error">{error}</div>}
        <div className="modal-actions ssh-connect-actions">{platform === "linux" ? <button type="button" className="secondary" disabled={testing || connecting} onClick={onTest}>{testing ? "测试中…" : "测试连接"}</button> : <span />}<span /><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="layui-btn layui-btn-normal" disabled={testing || connecting}>{connecting ? "启动中…" : isWindows ? "打开远程桌面" : "连接"}</button></div>
      </form> : <div className="ssh-terminal-shell">
        <div className="ssh-terminal-meta"><span>{username}@{host}:{port}</span><span className="ssh-connected">已连接</span><button type="button" className="ssh-terminal-command" title="命令补全 (Tab)" aria-label="命令补全 (Tab)" onClick={onCompleteCommand}><Keyboard size={16} /></button><button type="button" className="ssh-clear-button" onClick={onClearTerminal}>清屏</button><button type="button" className="ssh-disconnect-button" onClick={onDisconnect}>断开</button></div>
        <div ref={workspaceRef} className={`ssh-terminal-workspace${filePaneCollapsed ? " is-file-pane-collapsed" : ""}`} style={{ gridTemplateColumns: filePaneCollapsed ? "minmax(0, 1fr) 0 0" : `minmax(360px, 1fr) 8px minmax(360px, ${filePaneWidth}px)` }}>
          <div className="ssh-terminal-viewport" ref={terminalHostRef} aria-label="SSH 终端" />
          {!filePaneCollapsed && <RemoteFileManager dragActive={fileDragActive} files={files} path={filePath} loading={filesLoading} error={fileError} editor={fileEditor} saving={fileSaving} uploadInputRef={uploadInputRef} onResize={onFileResize} onDragActiveChange={onFileDragActiveChange} onLoad={onLoadFiles} onPathChange={onFilePathChange} onUpload={onUploadFiles} onMakeDirectory={onMakeDirectory} onOpen={onOpenFile} onDownload={onDownloadFile} onDelete={onDeleteEntry} onCloseEditor={onCloseFileEditor} onContentChange={onFileContentChange} onSave={onSaveFile} fileSize={fileSize} parentPath={parentPath} onCollapse={() => onFilePaneCollapsedChange(true)} />}
          {filePaneCollapsed && <button type="button" className="ssh-file-reveal-tab" title="展开文件管理" aria-label="展开文件管理" onClick={() => onFilePaneCollapsedChange(false)}><PanelRightOpen size={18} /></button>}
        </div>
        {error && <div className="error-list ssh-error">{error}</div>}
      </div>}
    </section>
  </div>;
}
