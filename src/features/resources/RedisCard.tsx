import { useState } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { invoke, runningInTauri, webApi } from "../../platform/api";
import type { Account } from "../../shared/types";
import { displayValue } from "../../shared/utils/display";

function cloudStatusText(value: unknown): string {
  const status = String(value || "-");
  return ({ Running: "运行中", Normal: "运行中", Stopped: "已停止", Creating: "创建中", Deleting: "删除中", Rebooting: "重启中", running: "运行中", stopped: "已停止", pending: "处理中", active: "已启用", inactive: "未启用", suspended: "已暂停", rebuilding: "重建中" } as Record<string, string>)[status] || status;
}

function redisArchitecture(value: unknown): string {
  const key = String(value || "").toLowerCase();
  return ({ standard: "标准版", cluster: "集群版", rwsplit: "读写分离版", splitrw: "读写分离版" } as Record<string, string>)[key] || String(value || "-");
}

function redisNetwork(value: unknown): string {
  return ({ CLASSIC: "经典网络", VPC: "专有网络" } as Record<string, string>)[String(value || "")] || String(value || "-");
}

function redisCharge(value: unknown): string {
  return ({ PostPaid: "按量付费", PrePaid: "包年包月" } as Record<string, string>)[String(value || "")] || String(value || "-");
}

export function RedisCard({
  account,
  item,
  onRefresh,
}: {
  account: Account;
  item: Record<string, unknown>;
  onRefresh: () => void;
}) {
  const [accounts, setAccounts] = useState<Record<string, unknown>[]>([]);
  const [accountDialog, setAccountDialog] = useState(false);
  const [accountDialogMaximized, setAccountDialogMaximized] = useState(false);
  const [accountError, setAccountError] = useState("");
  const canReadDetails = account.cloud_type === "aliyun" || account.cloud_type === "tencent";
  async function loadAccounts() {
    setAccountError("");
    try {
      const regionId = String(item._region_id || item.RegionId || "");
      setAccounts(
        runningInTauri
          ? await invoke<Record<string, unknown>[]>("list_redis_accounts", {
              id: account.id,
              instanceId: String(item.InstanceId || ""),
              regionId,
            })
          : await webApi<Record<string, unknown>[]>(
              `/api/redis-accounts?id=${account.id}&region=${encodeURIComponent(regionId)}&instance=${encodeURIComponent(String(item.InstanceId || ""))}`,
            ),
      );
    } catch (error) {
      setAccounts([]);
      setAccountError(error instanceof Error ? error.message : "获取账号失败");
    }
  }
  return (
    <article className="redis-card">
      <div className="redis-header">
        <strong>
          {displayValue(item.InstanceName || item.InstanceId)}{" "}
          <span className="arch-tag">
            {redisArchitecture(item.ArchitectureType || "standard")}
          </span>
        </strong>
        <span className="redis-status">
          {cloudStatusText(item.InstanceStatus)}
        </span>
      </div>
      <div className="redis-info">
        <div>
          <span>实例 ID：</span>
          {displayValue(item.InstanceId)}
        </div>
        <div>
          <span>实例类型：</span>
          {displayValue(item.InstanceType)}
        </div>
        <div>
          <span>实例规格：</span>
          {displayValue(item.InstanceClass)}
        </div>
        <div>
          <span>内存容量：</span>
          {displayValue(item.Capacity)} MB
        </div>
        <div>
          <span>带宽：</span>
          {displayValue(item.Bandwidth)} Mbps
        </div>
        <div>
          <span>连接数：</span>
          {displayValue(item.Connections)}
        </div>
        <div>
          <span>连接地址：</span>
          {displayValue(item.ConnectionDomain)}
        </div>
        <div>
          <span>端口：</span>
          {displayValue(item.Port)}
        </div>
        <div>
          <span>引擎版本：</span>Redis {displayValue(item.EngineVersion)}
        </div>
        <div>
          <span>网络类型：</span>
          {redisNetwork(item.NetworkType)}
        </div>
        <div>
          <span>付费类型：</span>
          {redisCharge(item.ChargeType)}
        </div>
        <div>
          <span>到期时间：</span>
          {displayValue(item.EndTime)}
        </div>
      </div>
      <div className="memory-bar">
        内存容量：{displayValue(item.Capacity)} MB
      </div>
      {canReadDetails && <div className="redis-actions">
        <button className="layui-btn layui-btn-xs" onClick={onRefresh}>
          刷新状态
        </button>
        <button
          className="layui-btn layui-btn-xs layui-btn-normal"
          onClick={() => {
            setAccountDialog(true);
            void loadAccounts();
          }}
        >
          账号列表
        </button>
      </div>}
      {accountDialog && (
        <div className="resource-modal-backdrop nested-resource-modal" onClick={() => { setAccountDialog(false); setAccountDialogMaximized(false); }}>
          <section className={`detail-panel resource-modal account-dialog${accountDialogMaximized ? " is-maximized" : ""}`} onClick={(event) => event.stopPropagation()}>
            <div className="detail-toolbar">
              <div>
                <span className="eyebrow">{displayValue(item.InstanceName || item.InstanceId)}</span>
                <h2>账号列表</h2>
              </div>
              <div className="detail-toolbar-actions">
                <button
                  className="secondary"
                  title={accountDialogMaximized ? "还原窗口" : "放大到全屏"}
                  onClick={() => setAccountDialogMaximized((value) => !value)}
                >
                  {accountDialogMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  {accountDialogMaximized ? "还原" : "放大"}
                </button>
                <button className="layui-btn" onClick={() => void loadAccounts()}>刷新</button>
                <button className="close-detail" onClick={() => { setAccountDialog(false); setAccountDialogMaximized(false); }}><X size={20} /></button>
              </div>
            </div>
            {accountError && <div className="error-list">{accountError}</div>}
            <div className="resource-table-wrap account-table-wrap">
              {accounts.length ? (
                <table>
                  <thead><tr><th>账号名称</th><th>账号类型</th><th>账号状态</th><th>账号描述</th></tr></thead>
                  <tbody>{accounts.map((row, index) => <tr key={index}>
                    <td>{displayValue(row.AccountName)}</td>
                    <td>{displayValue(row.AccountType) === "Normal" ? "普通账号" : displayValue(row.AccountType)}</td>
                    <td>{displayValue(row.AccountStatus) === "Available" ? "可用" : displayValue(row.AccountStatus)}</td>
                    <td>{displayValue(row.AccountDescription)}</td>
                  </tr>)}</tbody>
                </table>
              ) : <div className="detail-empty">{accountError ? "获取账号失败" : "暂无账号信息"}</div>}
            </div>
          </section>
        </div>
      )}
    </article>
  );
}

