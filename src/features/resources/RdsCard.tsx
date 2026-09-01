import { useState } from "react";
import { Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { resourcesClient } from "../../platform/clients";
import type { Account } from "../../shared/types";
import { displayValue } from "../../shared/utils/display";

function cloudStatusText(value: unknown): string {
  const status = String(value || "-");
  return ({ Running: "运行中", Normal: "运行中", Stopped: "已停止", Creating: "创建中", Deleting: "删除中", Rebooting: "重启中", running: "运行中", stopped: "已停止", pending: "处理中", active: "已启用", inactive: "未启用", suspended: "已暂停", rebuilding: "重建中" } as Record<string, string>)[status] || status;
}

function payType(value: unknown): string {
  return ({ Postpaid: "按量付费", Prepaid: "包年包月", PostPaid: "按量付费", PrePaid: "包年包月", Serverless: "Serverless" } as Record<string, string>)[String(value || "")] || String(value || "-");
}

export function RdsCard({
  account,
  item,
}: {
  account: Account;
  item: Record<string, unknown>;
}) {
  const [databases, setDatabases] = useState<Record<string, unknown>[]>([]);
  const [accounts, setAccounts] = useState<Record<string, unknown>[]>([]);
  const [mode, setMode] = useState<"db" | "accounts" | null>(null);
  const [busy, setBusy] = useState(false);
  const [accountDialog, setAccountDialog] = useState(false);
  const [accountDialogMaximized, setAccountDialogMaximized] = useState(false);
  const [accountError, setAccountError] = useState("");
  const regionId = String(item._region_id || item.RegionId || "");
  const canReadDetails = account.cloud_type === "aliyun" || account.cloud_type === "tencent";
  async function load(kind: "db" | "accounts") {
    setBusy(true);
    if (kind === "accounts") setAccountError("");
    try {
      const value = await resourcesClient.rdsDetails(
        kind === "db" ? "databases" : "accounts",
        account.id,
        regionId,
        String(item.DBInstanceId || ""),
      );
      kind === "db" ? setDatabases(value) : setAccounts(value);
      setMode(kind);
    } catch (error) {
      if (kind === "accounts") {
        setAccountError(error instanceof Error ? error.message : "获取账号失败");
      }
      setMode(kind);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="rds-card">
      <div className="rds-header">
        <strong>
          {displayValue(item.DBInstanceDescription || item.DBInstanceId)}{" "}
          <span className="engine-tag">
            {displayValue(item.Engine)} {displayValue(item.EngineVersion)}
          </span>
        </strong>
        <span className="rds-status">
          {cloudStatusText(item.DBInstanceStatus)}
        </span>
      </div>
      <div className="rds-info">
        <div>
          <span>实例 ID：</span>
          {displayValue(item.DBInstanceId)}
        </div>
        <div>
          <span>实例类型：</span>
          {displayValue(item.DBInstanceType)}
        </div>
        <div>
          <span>实例规格：</span>
          {displayValue(item.DBInstanceClass)}
        </div>
        <div>
          <span>存储空间：</span>
          {displayValue(item.DBInstanceStorage)} GB
        </div>
        <div>
          <span>连接地址：</span>
          {displayValue(item.ConnectionString)}
        </div>
        <div>
          <span>端口：</span>
          {displayValue(item.Port)}
        </div>
        <div>
          <span>网络类型：</span>
          {displayValue(item.DBInstanceNetType)}
        </div>
        <div>
          <span>付费类型：</span>
          {payType(item.PayType)}
        </div>
        <div>
          <span>创建时间：</span>
          {displayValue(item.CreateTime)}
        </div>
        <div>
          <span>到期时间：</span>
          {displayValue(item.ExpireTime)}
        </div>
      </div>
      <div className="db-list">
        {!canReadDetails ? "当前仅同步数据库实例清单，库与账号详情暂未接入"
          : busy
          ? "加载中…"
          : mode === "db"
            ? databases.length
              ? databases.map((db, index) => (
                  <span className="db-item" key={index}>
                    {displayValue(db.DBName)}
                  </span>
                ))
              : "暂无数据库"
            : "点击下方按钮加载数据库"}
      </div>
      {canReadDetails && <div className="rds-actions">
        <button
          className="layui-btn layui-btn-xs"
          disabled={busy}
          onClick={() => void load("db")}
        >
          <RefreshCw className={busy ? "spin" : undefined} size={13} />
          {busy ? "读取中…" : "刷新数据库"}
        </button>
        <button
          className="layui-btn layui-btn-xs layui-btn-normal"
          onClick={() => {
            setAccountDialog(true);
            void load("accounts");
          }}
        >
          账号管理
        </button>
      </div>}
      {accountDialog && (
        <div
          className="resource-modal-backdrop nested-resource-modal"
          onClick={() => { setAccountDialog(false); setAccountDialogMaximized(false); }}
        >
          <section
            className={`detail-panel resource-modal account-dialog${accountDialogMaximized ? " is-maximized" : ""}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="detail-toolbar">
              <div>
                <span className="eyebrow">
                  {displayValue(item.DBInstanceDescription || item.DBInstanceId)}
                </span>
                <h2>账号管理</h2>
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
                <button className="layui-btn" disabled={busy} onClick={() => void load("accounts")}>
                  <RefreshCw className={busy ? "spin" : undefined} size={13} />
                  {busy ? "读取中…" : "刷新"}
                </button>
                <button className="close-detail" onClick={() => { setAccountDialog(false); setAccountDialogMaximized(false); }}>
                  <X size={20} />
                </button>
              </div>
            </div>
            {accountError && <div className="error-list">{accountError}</div>}
            <div className="resource-table-wrap account-table-wrap">
              {busy ? (
                <div className="detail-empty">正在加载数据库账号…</div>
              ) : accounts.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>账号名称</th>
                      <th>账号类型</th>
                      <th>账号状态</th>
                      <th>账号描述</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((row, index) => (
                      <tr key={index}>
                        <td>{displayValue(row.AccountName)}</td>
                        <td>{displayValue(row.AccountType) === "Super" ? "高权限" : "普通"}</td>
                        <td>{displayValue(row.AccountStatus) === "Available" ? "可用" : displayValue(row.AccountStatus)}</td>
                        <td>{displayValue(row.AccountDescription)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="detail-empty">暂无数据库账号</div>
              )}
            </div>
          </section>
        </div>
      )}
    </article>
  );
}
