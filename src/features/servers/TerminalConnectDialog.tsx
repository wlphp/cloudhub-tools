import type { FormEvent } from "react";
import { Eye, EyeOff, RefreshCw, Terminal, X } from "lucide-react";
import type { SshTarget } from "../../shared/types";

type TerminalConnectDialogProps = {
  target: SshTarget | null;
  platform: "linux" | "windows";
  host: string;
  port: number;
  username: string;
  password: string;
  showPassword: boolean;
  passwordSaved: boolean;
  passwordRevealing: boolean;
  testing: boolean;
  connecting: boolean;
  error: string;
  displayValue: (value: unknown) => string;
  onClose: () => void;
  onPlatformChange: (platform: "linux" | "windows") => void;
  onHostChange: (value: string) => void;
  onPortChange: (value: number) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onTogglePassword: () => void;
  onTest: () => void;
  onConnect: () => void;
};

export function TerminalConnectDialog({ target, platform, host, port, username, password, showPassword, passwordSaved, passwordRevealing, testing, connecting, error, displayValue, onClose, onPlatformChange, onHostChange, onPortChange, onUsernameChange, onPasswordChange, onTogglePassword, onTest, onConnect }: TerminalConnectDialogProps) {
  if (!target) return null;
  const isWindows = platform === "windows";
  const title = displayValue(target.asset.payload.InstanceName || target.asset.asset_key);
  return <div className="terminal-connect-backdrop"><form className="terminal-connect-card" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onConnect(); }}><div className="terminal-connect-card-head"><div><span className="eyebrow">{isWindows ? "REMOTE DESKTOP" : "SSH CONNECTION"}</span><h2><Terminal size={18} />连接 {title}</h2></div><button type="button" className="close" title="关闭连接" onClick={onClose}><X size={19} /></button></div><div className="terminal-connect-fields"><div className="ssh-choice-row ssh-platform-row"><span>操作系统</span><div className="ssh-segmented"><button type="button" className={platform === "linux" ? "active" : ""} onClick={() => onPlatformChange("linux")}>Linux</button><button type="button" className={isWindows ? "active" : ""} onClick={() => onPlatformChange("windows")}>Windows</button></div></div><label>主机<input value={host} onChange={(event) => onHostChange(event.target.value)} placeholder="公网 IP 或域名" autoFocus /></label><label>{isWindows ? "RDP 端口" : "SSH 端口"}<input type="number" min={1} max={65535} value={port} onChange={(event) => onPortChange(Number(event.target.value) || (isWindows ? 3389 : 22))} /></label><label className="terminal-connect-user">{isWindows ? "RDP 用户名" : "SSH 用户名"}<input value={username} onChange={(event) => onUsernameChange(event.target.value)} placeholder={isWindows ? "administrator" : "root"} /></label><label className="terminal-connect-password">{isWindows ? "密码（可选）" : "密码"}<span className="ssh-password-wrap"><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => onPasswordChange(event.target.value)} placeholder={isWindows ? (passwordSaved ? "已保存本地记录" : "由 Windows 远程桌面验证") : (passwordSaved ? "已保存密码，可直接连接" : "请输入 SSH 密码")} autoComplete="current-password" /><button type="button" className="ssh-password-toggle" disabled={passwordRevealing} title={passwordRevealing ? "正在读取密码" : showPassword ? "隐藏密码" : passwordSaved ? "读取当前保存密码" : "显示密码"} aria-label={passwordRevealing ? "正在读取密码" : showPassword ? "隐藏密码" : passwordSaved ? "读取当前保存密码" : "显示密码"} onClick={onTogglePassword}>{passwordRevealing ? <RefreshCw size={16} className="spin" /> : showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label></div>{error && <div className="error-list ssh-error">{error}</div>}<div className="terminal-connect-actions">{platform === "linux" ? <button type="button" className="secondary" disabled={testing || connecting} onClick={onTest}>{testing ? "测试中…" : "测试连接"}</button> : <span />}<button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="layui-btn layui-btn-normal" disabled={testing || connecting}>{connecting ? (isWindows ? "启动中…" : "连接中…") : isWindows ? "打开远程桌面" : "连接"}</button></div></form></div>;
}
