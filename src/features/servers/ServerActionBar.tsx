import type { ReactNode } from "react";
import { History, Power, RefreshCw, RotateCw, ShieldCheck, Terminal, Zap } from "lucide-react";

/**
 * 服务器卡片操作栏（ECS / 轻量 / 各家云共用）。
 *
 * 顺序固定为：
 * SSH 登录 → 安全组 → 重启 → 强制重启 → 开机/关机 → 更多操作 → 刷新状态 → API 操作记录。
 * 新增按钮请插在「刷新状态」之前，保证「刷新状态」「API 操作记录」永远是最后两个，各云看起来才一致。
 */
export type ServerActionBarProps = {
  onSshLogin: () => void;
  sshDisabled?: boolean;
  /** 不传表示该实例没有安全组入口。 */
  onSecurityGroup?: () => void;
  securityGroupDisabled?: boolean;
  /** 不传表示该云不支持重启。 */
  onReboot?: () => void;
  rebootPending?: boolean;
  /** 不传表示该云不支持强制重启。 */
  onForceReboot?: () => void;
  forceRebootPending?: boolean;
  onRefresh: () => void;
  refreshDisabled?: boolean;
  /** 不传表示当前状态未知，不展示开/关机。 */
  power?: { state: "running" | "stopped"; onClick: () => void; pending?: boolean };
  /** 各云自己的附加入口（如 Vultr「更多操作」），排在开/关机之后、API 操作记录之前。 */
  extra?: ReactNode;
  /** 不传表示该实例无法按实例 ID 查询操作记录。 */
  onOperationLogs?: () => void;
  operationLogsDisabled?: boolean;
  className?: string;
};

export function ServerActionBar({
  onSshLogin, sshDisabled, onSecurityGroup, securityGroupDisabled,
  onReboot, rebootPending, onForceReboot, forceRebootPending,
  onRefresh, refreshDisabled, power, extra, onOperationLogs, operationLogsDisabled, className,
}: ServerActionBarProps) {
  const busy = Boolean(rebootPending || forceRebootPending || power?.pending);
  return <div className={`server-actions${className ? ` ${className}` : ""}`}>
    <button type="button" className="layui-btn layui-btn-small ssh-login-button server-control" data-tone="blue" disabled={sshDisabled} onClick={onSshLogin}><Terminal size={13} aria-hidden="true" />SSH 登录</button>
    {onSecurityGroup && <button type="button" className="layui-btn layui-btn-small security-group-button" disabled={securityGroupDisabled} onClick={onSecurityGroup}><ShieldCheck size={13} aria-hidden="true" />安全组</button>}
    {onReboot && <button type="button" className="layui-btn layui-btn-small server-control" data-tone="warning" disabled={busy} onClick={onReboot}><RotateCw size={13} aria-hidden="true" />{rebootPending ? "重启中…" : "重启"}</button>}
    {onForceReboot && <button type="button" className="layui-btn layui-btn-small server-control" data-tone="danger" disabled={busy} onClick={onForceReboot}><Zap size={13} aria-hidden="true" />{forceRebootPending ? "强制重启中…" : "强制重启"}</button>}
    {power?.state === "running" && <button type="button" className="layui-btn layui-btn-small server-control" data-tone="danger" disabled={busy} onClick={power.onClick}><Power size={13} aria-hidden="true" />{power.pending ? "关机中…" : "关机"}</button>}
    {power?.state === "stopped" && <button type="button" className="layui-btn layui-btn-small server-control" data-tone="green" disabled={busy} onClick={power.onClick}><Power size={13} aria-hidden="true" />{power.pending ? "开机中…" : "开机"}</button>}
    {extra}
    <button type="button" className="layui-btn layui-btn-small server-control" data-tone="green" disabled={refreshDisabled || busy} onClick={onRefresh}><RefreshCw size={13} aria-hidden="true" />刷新状态</button>
    {onOperationLogs && <button type="button" className="layui-btn layui-btn-small server-control" data-tone="accent" disabled={operationLogsDisabled} onClick={onOperationLogs}><History size={13} aria-hidden="true" />API 操作记录</button>}
  </div>;
}
