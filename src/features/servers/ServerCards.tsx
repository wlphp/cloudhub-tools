import { useEffect, useState } from "react";
import { Copy, MoreHorizontal, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { invoke, runningInTauri, webApi } from "../../platform/api";
import type { Account, LocalAsset } from "../../shared/types";
import { displayValue } from "../../shared/utils/display";
import { cloudProvider } from "../cloud/catalog";
import { SecurityGroupDialog, VultrFirewallDialog } from "./SecurityDialogs";

function firstAddress(value: unknown): string {
  if (Array.isArray(value)) return firstAddress(value[0]);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return firstAddress(record.IpAddress || record.Address || Object.values(record)[0]);
  }
  return String(value || "").trim();
}

function formatCloudDate(value: unknown): string {
  if (!value) return "-";
  const text = String(value).trim();
  if (!text || text === "-") return "-";
  const date = new Date(text.includes("T") ? text : text.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ServerCard({
  account,
  item,
  displayName,
  onDisplayNameChange,
  onStatus,
  onNotice,
  onSshLogin,
  onConfirm,
  onPrompt,
}: {
  account: Account;
  item: Record<string, unknown>;
  displayName?: string;
  onDisplayNameChange?: (value: string) => void;
  onStatus: () => void;
  onNotice: (message: string) => void;
  onSshLogin: () => void;
  onConfirm: (message: string) => Promise<boolean>;
  onPrompt: (message: string, initialValue?: string) => Promise<string | null>;
}) {
  const [disks, setDisks] = useState<Record<string, unknown>[]>([]);
  const [diskLoading, setDiskLoading] = useState(true);
  const [rebooting, setRebooting] = useState(false);
  const [vultrMenuOpen, setVultrMenuOpen] = useState(false);
  const [vultrManaging, setVultrManaging] = useState(false);
  const [securityGroupOpen, setSecurityGroupOpen] = useState(false);
  const [vultrFirewallOpen, setVultrFirewallOpen] = useState(false);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName || "");
  const regionId = String(item._region_id || item.RegionId || "");
  const rawStatus = String(item.Status || item.InstanceStatus || "");
  const normalizedStatus = rawStatus.trim().toUpperCase();
  const status = ["RUNNING", "ACTIVE", "ON"].includes(normalizedStatus) ? "Running" : ["STOPPED", "OFF", "INACTIVE"].includes(normalizedStatus) ? "Stopped" : rawStatus;
  const networkError = String(item._network_error || "");
  const networkAccessDenied = /Authorization failed|NotAuthorized|not authorized/i.test(networkError);
  const supportsPowerControls = account.cloud_type === "aliyun" || account.cloud_type === "baidu" || account.cloud_type === "oracle" || account.cloud_type === "vultr";
  const supportsForceReboot = account.cloud_type === "aliyun" || account.cloud_type === "baidu" || account.cloud_type === "oracle";
  const canReadDisks = account.cloud_type === "aliyun" || account.cloud_type === "tencent" || account.cloud_type === "oracle";
  const fallbackDisks: Record<string, unknown>[] = account.cloud_type === "vultr" && item.Disk != null && item.Disk !== ""
    ? [{ DiskId: item.InstanceId, DiskName: "本地系统盘", Category: "local", Size: item.Disk, Status: item.PowerStatus || item.Status }]
    : [];
  const defaultDisplayName = String(item.InstanceName || item.InstanceId || "未命名实例");
  const resolvedDisplayName = displayName || defaultDisplayName;
  function saveDisplayName() {
    setEditingDisplayName(false);
    onDisplayNameChange?.(displayNameDraft.trim());
  }
  useEffect(() => {
    let alive = true;
    const instanceId = String(item.InstanceId || "");
    if (!canReadDisks || !regionId || !instanceId) {
      setDisks([]);
      setDiskLoading(false);
      return;
    }
    const loader = runningInTauri
      ? () => invoke<Record<string, unknown>[]>("list_instance_disks", { id: account.id, regionId, instanceId, compartmentOcid: String(item._compartment_ocid || "") })
      : () => webApi<Record<string, unknown>[]>(`/api/instance-disks?id=${account.id}&region=${encodeURIComponent(regionId)}&instance=${encodeURIComponent(instanceId)}&compartment=${encodeURIComponent(String(item._compartment_ocid || ""))}`);
    loader()
      .then((value) => {
        if (alive) setDisks(value || []);
      })
      .catch(() => {
        if (alive) setDisks([]);
      })
      .finally(() => {
        if (alive) setDiskLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [account.id, canReadDisks, regionId, item.InstanceId]);
  async function refreshStatus() {
    if (account.cloud_type !== "aliyun" && account.cloud_type !== "baidu") {
      onStatus();
      return;
    }
    try {
      if (account.cloud_type === "baidu") {
        const payload = { id: account.id, regionId, instanceId: String(item.InstanceId || ""), action: "status", forceStop: false };
        if (runningInTauri) await invoke("baidu_instance_action", payload);
        else await webApi("/api/bcc-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        await invoke("instance_status", {
          id: account.id,
          regionId,
          instanceId: String(item.InstanceId || ""),
        });
      }
      onStatus();
    } catch {
      onStatus();
    }
  }
  async function changeStatus(action: "start" | "stop") {
    const label = action === "start" ? "开机" : "关机";
    if (!(await onConfirm(`确认${label}服务器“${String(item.InstanceName || item.InstanceId)}”？`))) return;
    try {
      if (account.cloud_type === "oracle") {
        const payload = { id: account.id, regionId, instanceId: String(item.InstanceId || ""), action };
        if (runningInTauri) await invoke("oracle_instance_action", payload);
        else await webApi("/api/oracle-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "baidu") {
        const payload = { id: account.id, regionId, instanceId: String(item.InstanceId || ""), action, forceStop: false };
        if (runningInTauri) await invoke("baidu_instance_action", payload);
        else await webApi("/api/bcc-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "vultr") {
        const payload = { id: account.id, instanceId: String(item.InstanceId || ""), action };
        if (runningInTauri) await invoke("vultr_instance_action", payload);
        else await webApi("/api/vultr-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        if (!runningInTauri) throw new Error(`网页端暂不支持${label}，请使用客户端操作`);
        await invoke(action === "start" ? "start_instance" : "stop_instance", { id: account.id, regionId, instanceId: String(item.InstanceId || "") });
      }
      onNotice(`服务器${label}指令已提交`);
      onStatus();
    } catch (error) { onNotice(`服务器${label}失败：${String(error)}`); }
  }
  async function reboot(forceReboot: boolean) {
    if (!(await onConfirm(`确认${forceReboot ? "强制" : "正常"}重启服务器“${String(item.InstanceName || item.InstanceId || "")}”？`))) return;
    setRebooting(true);
    try {
      if (account.cloud_type === "oracle") {
        const payload = { id: account.id, regionId, instanceId: String(item.InstanceId || ""), action: forceReboot ? "forceReboot" : "reboot" };
        if (runningInTauri) await invoke("oracle_instance_action", payload);
        else await webApi("/api/oracle-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "baidu") {
        const payload = { id: account.id, regionId, instanceId: String(item.InstanceId || ""), action: "reboot", forceStop: forceReboot };
        if (runningInTauri) await invoke("baidu_instance_action", payload);
        else await webApi("/api/bcc-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "vultr") {
        const payload = { id: account.id, instanceId: String(item.InstanceId || ""), action: "reboot" };
        if (runningInTauri) await invoke("vultr_instance_action", payload);
        else await webApi("/api/vultr-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        if (!runningInTauri) throw new Error("网页端暂不支持服务器重启，请使用客户端操作");
        await invoke("reboot_instance", { id: account.id, regionId, instanceId: String(item.InstanceId || ""), forceStop: forceReboot });
      }
      onNotice("服务器重启指令已提交");
      onStatus();
    } catch (error) { onNotice(`服务器重启失败：${String(error)}`); }
    finally { setRebooting(false); }
  }
  async function manageVultr(action: "snapshot" | "label" | "tags" | "enable_backups" | "disable_backups" | "enable_ddos" | "disable_ddos" | "enable_ipv6" | "firewall") {
    const labels = {
      snapshot: "创建快照", label: "修改实例名称", tags: "修改标签", enable_backups: "开启自动备份", disable_backups: "关闭自动备份",
      enable_ddos: "开启 DDoS 防护", disable_ddos: "关闭 DDoS 防护", enable_ipv6: "启用 IPv6", firewall: "绑定防火墙组",
    };
    let value = "";
    if (action === "snapshot") {
      const input = await onPrompt(`为实例“${String(item.InstanceName || item.InstanceId)}”创建快照，请输入快照说明（可留空）`, String(item.InstanceName || ""));
      if (input === null) return;
      value = input;
    } else if (action === "label") {
      const input = await onPrompt("请输入新的 Vultr 实例名称", String(item.InstanceName || ""));
      if (!input?.trim()) return;
      value = input;
    } else if (action === "tags") {
      const input = await onPrompt("请输入标签，以英文逗号分隔；留空将清空全部标签", Array.isArray(item.Tags) ? item.Tags.join(", ") : String(item.Tags || ""));
      if (input === null) return;
      value = input;
    } else if (action === "firewall") {
      const input = await onPrompt("请输入要绑定的 Vultr 防火墙组 ID", String(item.FirewallGroupId || ""));
      if (!input?.trim()) return;
      value = input;
    }
    const warning = action === "snapshot" ? "快照会占用存储并可能产生费用，确认创建？"
      : action === "enable_backups" ? "自动备份可能产生额外费用，确认开启？"
      : action === "enable_ddos" ? "DDoS 防护可能产生额外费用，确认开启？"
      : action === "enable_ipv6" ? "启用 IPv6 后将变更实例网络配置，确认继续？"
      : `确认${labels[action]}？`;
    if (!(await onConfirm(warning))) return;
    setVultrManaging(true);
    setVultrMenuOpen(false);
    try {
      const payload = { id: account.id, instanceId: String(item.InstanceId || ""), action, value };
      if (runningInTauri) await invoke("vultr_instance_manage", payload);
      else await webApi("/api/vultr-instance-manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      onNotice(`${labels[action]}指令已提交`);
      onStatus();
    } catch (error) { onNotice(`${labels[action]}失败：${String(error)}`); }
    finally { setVultrManaging(false); }
  }
  return (
    <>
    <article className="server-card">
      <div className="server-account-label"><span className={`avatar cloud-avatar ${account.cloud_type}`}>{cloudProvider(account.cloud_type).avatar}</span><span>{account.account_name}</span></div>
      <div className="server-header">
        {editingDisplayName ? <input className="server-display-name-editor" value={displayNameDraft} autoFocus onChange={(event) => setDisplayNameDraft(event.target.value)} onBlur={saveDisplayName} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDisplayNameDraft(displayName || ""); setEditingDisplayName(false); } }} placeholder={defaultDisplayName} aria-label="实例显示名称" /> : <button type="button" className="server-display-name" title="点击修改本地显示名称" onClick={() => { setDisplayNameDraft(displayName || ""); setEditingDisplayName(true); }}>{resolvedDisplayName}</button>}
        <span
          className={`server-status ${status === "Running" ? "status-running" : status === "Stopped" ? "status-stopped" : "status-other"}`}
        >
          {status === "Running"
            ? "运行中"
            : status === "Stopped"
              ? "已停止"
              : status || "未知"}
        </span>
      </div>
      <div className="server-info">
        <div>
          <span>实例ID：</span>
          {displayValue(item.InstanceId)}
        </div>
        <div title={networkError || undefined}>
          <span>公网IP：</span>
          {displayValue(item.PublicIpAddress)}
          {!item.PublicIpAddress && networkError && <small>（{networkAccessDenied ? "OCI IAM 未授权读取 VNIC" : "网络接口读取失败"}）</small>}
        </div>
        <div title={networkError || undefined}>
          <span>内网IP：</span>
          {displayValue(item.PrivateIpAddress)}
          {!item.PrivateIpAddress && networkError && <small>（{networkAccessDenied ? "OCI IAM 未授权读取 VNIC" : "网络接口读取失败"}）</small>}
        </div>
        <div>
          <span>配置：</span>
          {item.Cpu == null || item.Memory == null
            ? displayValue(item.InstanceType || item.shape)
            : <>{displayValue(item.Cpu)}核 / {(Number(item.Memory) / 1024).toFixed(1)}GB{item.InstanceType ? ` · ${displayValue(item.InstanceType)}` : ""}</>}
        </div>
        {account.cloud_type === "vultr" ? <div>
          <span>月流量：</span>
          {item.AllowedBandwidth == null || item.AllowedBandwidth === "" ? "-" : `${displayValue(item.AllowedBandwidth)} GB`}
        </div> : account.cloud_type !== "oracle" && <div>
          <span>带宽：</span>
          {displayValue(item.InternetMaxBandwidthIn || 0)}M入 /{" "}
          {displayValue(item.InternetMaxBandwidthOut || 0)}M出
        </div>}
        <div>
          <span>操作系统：</span>
          {displayValue(item.OSName || item.OSType || item.ImageId || item.imageId)}
        </div>
        <div>
          <span>{account.cloud_type === "oracle" || account.cloud_type === "vultr" ? "创建时间：" : "时间："}</span>
          {account.cloud_type === "oracle" || account.cloud_type === "vultr" ? formatCloudDate(item.CreationTime) : <>{formatCloudDate(item.CreationTime)} ~ {formatCloudDate(item.ExpiredTime)}</>}
        </div>
        {account.cloud_type === "vultr" && <>
          <div><span>地域：</span>{displayValue(item.Region || regionId)}</div>
          <div><span>主机名：</span>{displayValue(item.Hostname)}</div>
          <div><span>IPv4 网关：</span>{displayValue(item.GatewayV4)}</div>
          <div><span>IPv4 掩码：</span>{displayValue(item.NetmaskV4)}</div>
          <div><span>IPv6：</span>{displayValue(item.V6MainIp)}</div>
          <div><span>VPC：</span>{displayValue(item.VpcIds)}</div>
          <div><span>防火墙组：</span>{displayValue(item.FirewallGroupId)}</div>
          <div><span>标签：</span>{displayValue(item.Tags)}</div>
          <div><span>自动备份：</span>{displayValue(item.Backups)}</div>
          <div><span>DDoS 防护：</span>{item.DdosProtection === true ? "已开启" : item.DdosProtection === false ? "未开启" : displayValue(item.DdosProtection)}</div>
        </>}
      </div>
      <div className="disk-info">
        {fallbackDisks.length ? (
          fallbackDisks.map((disk) => (
            <div className="disk-item" key={String(disk.DiskId)}>
              <span className="disk-name">{displayValue(disk.DiskName)} ({displayValue(disk.Category)})</span>
              <span className="disk-size">{displayValue(disk.Size)} GB · {displayValue(disk.Status)}</span>
            </div>
          ))
        ) : !canReadDisks ? <span>当前仅同步实例清单，磁盘详情暂未接入</span> : diskLoading ? (
          <span>磁盘信息加载中...</span>
        ) : disks.length ? (
          disks.map((disk) => (
            <div className="disk-item" key={String(disk.DiskId)}>
              <span className="disk-name">
                {displayValue(disk.DiskName || disk.DiskId)} (
                {displayValue(disk.Category)})
              </span>
              <span className="disk-size">
                {displayValue(disk.Size)} GB · {displayValue(disk.Status)}
              </span>
            </div>
          ))
        ) : (
          <span>暂无磁盘信息</span>
        )}
      </div>
      <div className="server-actions">
        <button className="layui-btn layui-btn-small ssh-login-button" onClick={onSshLogin}>
          <Terminal size={13} />
          SSH 登录
        </button>
        {["aliyun", "tencent", "baidu"].includes(account.cloud_type) && Boolean(regionId && item.InstanceId) && <button type="button" className="layui-btn layui-btn-small security-group-button" onClick={() => setSecurityGroupOpen(true)}><ShieldCheck size={13} />安全组</button>}
        {account.cloud_type === "vultr" && Boolean(item.FirewallGroupId) && <button type="button" className="layui-btn layui-btn-small security-group-button" onClick={() => setVultrFirewallOpen(true)}><ShieldCheck size={13} />防火墙</button>}
        {supportsPowerControls && <>
          <button className="layui-btn layui-btn-small layui-btn-danger" disabled={rebooting} onClick={() => void reboot(false)}>{rebooting ? "重启中…" : "重启"}</button>
          {supportsForceReboot && <button className="layui-btn layui-btn-small layui-btn-danger" disabled={rebooting} onClick={() => void reboot(true)}>{rebooting ? "强制重启中…" : "强制重启"}</button>}
        </>}
        <button
          className="layui-btn layui-btn-small"
          onClick={() => void refreshStatus()}
        >
          <RefreshCw size={13} />
          刷新状态
        </button>
        <button
          className="layui-btn layui-btn-small layui-btn-primary"
          onClick={() => onStatus()}
        >
          监控
        </button>
        {supportsPowerControls && status === "Running" && (
          <button
            className="layui-btn layui-btn-small layui-btn-danger"
            onClick={() => void changeStatus("stop")}
          >
            关机
          </button>
        )}
        {supportsPowerControls && status === "Stopped" && (
          <button
            className="layui-btn layui-btn-small layui-btn-normal"
            onClick={() => void changeStatus("start")}
          >
            开机
          </button>
        )}
        {account.cloud_type === "vultr" && <div className={`vultr-manage-wrap${vultrMenuOpen ? " is-open" : ""}`}>
          <button type="button" className="layui-btn layui-btn-small layui-btn-primary vultr-manage-button" disabled={vultrManaging} onClick={() => setVultrMenuOpen((open) => !open)}><MoreHorizontal size={15} />更多操作</button>
          {vultrMenuOpen && <div className="vultr-manage-menu">
            <button type="button" onClick={() => void manageVultr("label")}>修改实例名称</button>
            <button type="button" onClick={() => void manageVultr("tags")}>修改标签</button>
            <button type="button" onClick={() => void manageVultr("snapshot")}>创建快照</button>
            <button type="button" onClick={() => void manageVultr(String(item.Backups).toLowerCase() === "enabled" ? "disable_backups" : "enable_backups")}>{String(item.Backups).toLowerCase() === "enabled" ? "关闭自动备份" : "开启自动备份"}</button>
            <button type="button" onClick={() => void manageVultr(item.DdosProtection === true || String(item.DdosProtection).toLowerCase() === "true" ? "disable_ddos" : "enable_ddos")}>{item.DdosProtection === true || String(item.DdosProtection).toLowerCase() === "true" ? "关闭 DDoS 防护" : "开启 DDoS 防护"}</button>
            {!item.V6MainIp && <button type="button" onClick={() => void manageVultr("enable_ipv6")}>启用 IPv6</button>}
            <button type="button" onClick={() => void manageVultr("firewall")}>绑定防火墙组</button>
          </div>}
        </div>}
      </div>
    </article>
    {securityGroupOpen && <SecurityGroupDialog account={account} regionId={regionId} instanceId={String(item.InstanceId)} onClose={() => setSecurityGroupOpen(false)} onConfirm={onConfirm} onNotice={onNotice} />}
    {vultrFirewallOpen && <VultrFirewallDialog account={account} firewallGroupId={String(item.FirewallGroupId)} onClose={() => setVultrFirewallOpen(false)} onConfirm={onConfirm} onNotice={onNotice} />}
    </>
  );
}

export function FavoriteServerDetails({ asset, account, onCopyIp }: { asset: LocalAsset; account: Account; onCopyIp: (address: string) => void }) {
  const [disks, setDisks] = useState<Record<string, unknown>[]>([]);
  const [diskLoading, setDiskLoading] = useState(false);
  const payload = asset.payload || {};
  const instanceId = String(payload.InstanceId || asset.asset_key);
  const regionId = String(asset.region_id || payload._region_id || payload.RegionId || account.region_id || "");
  const canReadDisks = ["aliyun", "tencent", "oracle"].includes(account.cloud_type) && Boolean(instanceId && regionId);
  const ip = firstAddress(payload.PublicIpAddress || payload.PublicAddresses || payload.InternetIp || payload.PublicIp || payload.PrivateIpAddress);
  const cpu = Number(payload.Cpu ?? payload.CPU ?? payload.cpuCount ?? 0);
  const memoryInGb = Number(payload.MemoryInGB ?? payload.memoryInGB ?? payload.memoryCapacityInGB ?? 0);
  const memoryInMb = Number(payload.Memory ?? payload.memory ?? 0);
  const memory = memoryInGb > 0 ? `${memoryInGb} GB` : memoryInMb > 0 ? `${memoryInMb >= 1024 ? Number((memoryInMb / 1024).toFixed(1)) : memoryInMb} ${memoryInMb >= 1024 ? "GB" : "MB"}` : "";
  const bandwidth = Number(payload.InternetMaxBandwidthOut ?? payload.Bandwidth ?? payload.InternetMaxBandwidthIn ?? 0);
  const specification = [cpu > 0 ? `${cpu} 核` : "", memory].filter(Boolean).join(" / ") || displayValue(payload.InstanceType || payload.PlanId);
  useEffect(() => {
    let alive = true;
    if (!canReadDisks) return;
    setDiskLoading(true);
    const loader = runningInTauri
      ? () => invoke<Record<string, unknown>[]>("list_instance_disks", { id: account.id, regionId, instanceId, compartmentOcid: String(payload._compartment_ocid || "") })
      : () => webApi<Record<string, unknown>[]>(`/api/instance-disks?id=${account.id}&region=${encodeURIComponent(regionId)}&instance=${encodeURIComponent(instanceId)}&compartment=${encodeURIComponent(String(payload._compartment_ocid || ""))}`);
    loader().then((value) => { if (alive) setDisks(value || []); }).catch(() => { if (alive) setDisks([]); }).finally(() => { if (alive) setDiskLoading(false); });
    return () => { alive = false; };
  }, [account.id, canReadDisks, instanceId, regionId, payload._compartment_ocid]);
  const fallbackDisks: Record<string, unknown>[] = [
    payload.SystemDisk || payload.SystemDiskSize ? { Type: "system", DiskName: "系统盘", Size: payload.SystemDiskSize || payload.SystemDisk } : null,
    ...(Array.isArray(payload.DataDisks) ? payload.DataDisks : []),
  ].filter((disk): disk is Record<string, unknown> => Boolean(disk));
  const allDisks = disks.length ? disks : fallbackDisks;
  return <div className="favorite-card-details favorite-server-details">
    <div><span>IP 地址：</span><div className="favorite-detail-value"><strong title={ip || "-"}>{ip || "-"}</strong>{ip && <button type="button" className="favorite-ip-copy" title="复制 IP 地址" aria-label="复制 IP 地址" onClick={() => onCopyIp(ip)}><Copy size={14} /></button>}</div></div>
    <div><span>规格：</span><strong title={bandwidth > 0 ? `${specification} · ${bandwidth}M 带宽` : specification}>{specification}{bandwidth > 0 ? ` · ${bandwidth}M 带宽` : ""}</strong></div>
    <div className="favorite-disk-row"><span>磁盘：</span><div className="favorite-disk-list">{diskLoading ? <em>磁盘信息加载中…</em> : allDisks.length ? allDisks.map((disk, index) => {
      const kind = String(disk.Type || disk.DiskUsage || disk.Usage || disk.Category || "").toLowerCase();
      const label = /system|boot|startup|启动|系统/.test(kind) ? "系统盘" : "数据盘";
      const name = displayValue(disk.DiskName || disk.DiskId || label);
      const size = Number(disk.Size || disk.DiskSize || 0);
      return <span className={`favorite-disk-chip ${label === "系统盘" ? "system" : "data"}`} key={`${name}-${index}`} title={`${label} · ${name}${size > 0 ? ` · ${size} GB` : ""}`}><b>{label}</b><i>{name}{size > 0 ? ` ${size} GB` : ""}</i></span>;
    }) : <em>暂无磁盘信息</em>}</div></div>
  </div>;
}

