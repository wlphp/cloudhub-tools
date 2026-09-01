import { useState } from "react";
import { Monitor, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { serversClient } from "../../platform/clients";
import type { Account } from "../../shared/types";
import { displayValue } from "../../shared/utils/display";
import { LightFirewallDialog } from "./SecurityDialogs";

function cloudStatusText(value: unknown): string {
  const status = String(value || "-");
  return ({ Running: "运行中", Normal: "运行中", Stopped: "已停止", Creating: "创建中", Deleting: "删除中", Rebooting: "重启中", running: "运行中", stopped: "已停止", pending: "处理中", active: "已启用", inactive: "未启用", suspended: "已暂停", rebuilding: "重建中" } as Record<string, string>)[status] || status;
}

export function SwasCard({
  account,
  item,
  onRefresh,
  onNotice,
  onSshLogin,
  onConfirm,
}: {
  account: Account;
  item: Record<string, unknown>;
  onRefresh: () => void;
  onNotice: (message: string) => void;
  onSshLogin: () => void;
  onConfirm: (message: string) => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = useState<"start" | "reboot" | "force-reboot" | "stop" | null>(null);
  const [firewallOpen, setFirewallOpen] = useState(false);
  const regionId = String(item._region_id || item.RegionId || "");
  const instanceId = String(item.InstanceId || "");
  const status = String(item.Status || item.InstanceStatus || "");
  const instanceName = String(item.InstanceName || instanceId);
  const canControl = ["aliyun", "tencent", "jdcloud"].includes(account.cloud_type) && regionId && instanceId;
  const canFirewall = account.cloud_type === "aliyun" || account.cloud_type === "tencent" || account.cloud_type === "jdcloud";
  const canForceReboot = account.cloud_type === "aliyun" || account.cloud_type === "tencent";
  async function submit(action: "start" | "reboot" | "stop", forceReboot = false) {
    const label = action === "start" ? "开机" : action === "reboot" ? `${canForceReboot && forceReboot ? "强制" : "正常"}重启` : "关机";
    if (!(await onConfirm(`确认${label}轻量服务器“${instanceName}”？`))) return;
    setSubmitting(action === "reboot" && forceReboot ? "force-reboot" : action);
    try {
      await serversClient.swasAction({ id: account.id, regionId, instanceId, action, forceStop: action === "reboot" && canForceReboot && forceReboot });
      onNotice(`轻量服务器${label}指令已提交`);
      onRefresh();
    } catch (error) {
      onNotice(`轻量服务器${label}失败：${String(error)}`);
    } finally {
      setSubmitting(null);
    }
  }
  function openMonitor() {
    const url = account.cloud_type === "tencent"
      ? `https://console.cloud.tencent.com/lighthouse/instance/index?rid=${encodeURIComponent(regionId)}`
      : account.cloud_type === "jdcloud"
        ? `https://console.jdcloud.com/lavm/instance/list?region=${encodeURIComponent(regionId)}`
        : `https://swas.console.aliyun.com/?regionId=${encodeURIComponent(regionId)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return (
    <>
    <article className="swas-card">
      <div className="swas-header">
        <strong>{displayValue(item.InstanceName || item.InstanceId)}</strong>
        <span className="swas-status">{cloudStatusText(status || "-")}</span>
      </div>
      <div className="swas-info">
        <div><span>实例 ID：</span>{displayValue(item.InstanceId)}</div>
        <div><span>地域：</span>{displayValue(item.RegionId || item._region_id)}</div>
        <div><span>公网 IP：</span>{displayValue(item.PublicIpAddress || item.PublicIp)}</div>
        <div><span>套餐：</span>{displayValue(item.PlanId || item.InstanceType)}</div>
        <div><span>配置：</span>{displayValue(item.Cpu) !== "-" || displayValue(item.Memory) !== "-" ? `${displayValue(item.Cpu)} 核 / ${displayValue(item.Memory)} MB${displayValue(item.Bandwidth) !== "-" ? ` / ${displayValue(item.Bandwidth)} Mbps` : ""}` : "-"}</div>
        <div><span>镜像：</span>{displayValue(item.ImageId || item.ImageName)}</div>
        <div><span>系统盘：</span>{displayValue(item.SystemDiskSize)} GB</div>
        <div><span>私网 IP：</span>{displayValue(item.PrivateIpAddress)}</div>
        <div><span>到期时间：</span>{displayValue(item.ExpiredTime || item.ExpirationTime)}</div>
        <div><span>创建时间：</span>{displayValue(item.CreateTime)}</div>
        <div><span>VPC：</span>{displayValue(item.VpcId)}</div>
      </div>
      {canControl && <div className="server-actions">
        <button className="layui-btn layui-btn-small ssh-login-button" onClick={onSshLogin}><Terminal size={13} />SSH 登录</button>
        {canFirewall && <button type="button" className="layui-btn layui-btn-small security-group-button" disabled={Boolean(submitting)} onClick={() => setFirewallOpen(true)}><ShieldCheck size={13} />防火墙</button>}
        <button className="layui-btn layui-btn-small layui-btn-danger" disabled={!canControl || Boolean(submitting)} onClick={() => void submit("reboot")}>{submitting === "reboot" ? "重启中…" : "重启"}</button>
        {canForceReboot && <button className="layui-btn layui-btn-small layui-btn-danger" disabled={Boolean(submitting)} onClick={() => void submit("reboot", true)}>{submitting === "force-reboot" ? "强制重启中…" : "强制重启"}</button>}
        <button className="layui-btn layui-btn-small" disabled={Boolean(submitting)} onClick={onRefresh}><RefreshCw size={13} />刷新状态</button>
        <button className="layui-btn layui-btn-small layui-btn-primary" disabled={!regionId} onClick={openMonitor}><Monitor size={13} />监控</button>
        {status.toLowerCase() === "stopped" ? <button className="layui-btn layui-btn-small layui-btn-normal" disabled={Boolean(submitting)} onClick={() => void submit("start")}>{submitting === "start" ? "开机中…" : "开机"}</button> : <button className="layui-btn layui-btn-small layui-btn-danger" disabled={Boolean(submitting)} onClick={() => void submit("stop")}>{submitting === "stop" ? "关机中…" : "关机"}</button>}
      </div>}
    </article>
    {firewallOpen && <LightFirewallDialog account={account} regionId={regionId} instanceId={instanceId} onClose={() => setFirewallOpen(false)} onConfirm={onConfirm} onNotice={onNotice} />}
    </>
  );
}

