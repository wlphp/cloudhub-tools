import { Cloud, Database, RefreshCw } from "lucide-react";
import { ServerCard } from "../servers/ServerCards";
import { SwasCard } from "../servers/SwasCard";
import { BucketCard } from "../storage/BucketCard";
import type { Account, ResourceResponse } from "../../shared/types";
import { formatAssetDate } from "../../shared/utils/display";
import { RdsCard } from "./RdsCard";
import { RedisCard } from "./RedisCard";

export type ResourceRegion = [string, { name: string; items: Record<string, unknown>[] }];

type RefreshResources = (resourceType: "ecs" | "swas" | "rds" | "redis" | "oss") => void;

export function EcsResourcePanel({
  account,
  source,
  resources,
  loading,
  regions,
  displayNames,
  onDisplayNameChange,
  onRefresh,
  onNotice,
  onConfirm,
  onPrompt,
  onSshLogin,
}: {
  account: Account;
  source: "cache" | "live";
  resources: ResourceResponse | null;
  loading: boolean;
  regions: ResourceRegion[];
  displayNames: Record<string, string>;
  onDisplayNameChange: (key: string, value: string) => void;
  onRefresh: RefreshResources;
  onNotice: (message: string) => void;
  onConfirm: (message: string) => Promise<boolean>;
  onPrompt: (message: string, initialValue?: string) => Promise<string | null>;
  onSshLogin: (item: Record<string, unknown>, index: number) => void;
}) {
  const items = resources?.items || [];
  return (
    <div className="server-reference">
      <div className="server-toolbar">
        <button className="layui-btn" disabled={loading} onClick={() => onRefresh("ecs")}><RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "拉取中…" : "实时拉取"}</button>
        <span>{source === "cache" ? `当前展示本地缓存${resources?.fetched_at ? `，更新于 ${formatAssetDate(resources.fetched_at)}` : ""}` : "当前展示实时拉取结果，已同步到本地缓存"}</span>
      </div>
      <div className="server-summary">
        <span>地区数量：<strong>{regions.length}</strong></span>
        <span>服务器总数：<strong>{items.length}</strong></span>
        <span className="running">运行中：<strong>{items.filter((item) => String(item.Status || item.InstanceStatus || "").toUpperCase() === "RUNNING").length}</strong></span>
        <span className="stopped">已停止：<strong>{items.filter((item) => String(item.Status || item.InstanceStatus || "").toUpperCase() === "STOPPED").length}</strong></span>
      </div>
      {regions.length === 0 ? <div className="server-empty"><Cloud size={42} /><p>{source === "cache" ? "本地缓存中暂无 ECS 服务器，请点击“实时拉取”获取最新数据" : "该账号下没有找到 ECS 服务器"}</p></div> : regions.map(([regionId, region]) => (
        <div className="region-section" key={regionId}>
          <div className="region-title">{region.name} ({regionId}) - {region.items.length}台</div>
          {region.items.map((item, index) => {
            const instanceId = String(item.InstanceId || index);
            const displayNameKey = `${account.id}:ecs:${instanceId}`;
            return <ServerCard key={instanceId} account={account} item={item} displayName={displayNames[displayNameKey]} onDisplayNameChange={(value) => onDisplayNameChange(displayNameKey, value)} onStatus={() => onRefresh("ecs")} onNotice={onNotice} onConfirm={onConfirm} onPrompt={onPrompt} onSshLogin={() => onSshLogin(item, index)} />;
          })}
        </div>
      ))}
    </div>
  );
}

export function SwasResourcePanel({ account, resources, loading, onRefresh, onNotice, onConfirm, onSshLogin }: {
  account: Account;
  resources: ResourceResponse | null;
  loading: boolean;
  onRefresh: RefreshResources;
  onNotice: (message: string) => void;
  onConfirm: (message: string) => Promise<boolean>;
  onSshLogin: (item: Record<string, unknown>, index: number) => void;
}) {
  const items = resources?.items || [];
  return (
    <div className="swas-reference">
      <div className="server-toolbar"><button className="layui-btn layui-btn-warm" disabled={loading} onClick={() => onRefresh("swas")}><RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "拉取中…" : "实时拉取"}</button><span>轻量应用服务器按地域展示</span></div>
      <div className="server-summary"><span>实例总数：<strong>{items.length}</strong></span><span className="running">运行中：<strong>{items.filter((item) => String(item.Status || item.InstanceStatus).toLowerCase().includes("running")).length}</strong></span></div>
      {(resources?.errors?.length ?? 0) > 0 && <div className="error-list">{resources?.errors.map((error) => <div key={error}>部分地域读取失败：{error}</div>)}</div>}
      {!items.length ? <div className="detail-empty"><Cloud size={36} />暂无轻量应用服务器</div> : <div className="swas-grid">{items.map((item, index) => <SwasCard account={account} item={item} onRefresh={() => onRefresh("swas")} onNotice={onNotice} onConfirm={onConfirm} onSshLogin={() => onSshLogin(item, index)} key={String(item.InstanceId || item.InstanceName || index)} />)}</div>}
    </div>
  );
}

export function RdsResourcePanel({ account, resources, loading, regions, onRefresh }: {
  account: Account;
  resources: ResourceResponse | null;
  loading: boolean;
  regions: ResourceRegion[];
  onRefresh: RefreshResources;
}) {
  const items = resources?.items || [];
  return (
    <div className="rds-reference">
      <div className="server-toolbar"><button className="layui-btn layui-btn-warm" disabled={loading} onClick={() => onRefresh("rds")}><RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "拉取中…" : "实时拉取"}</button><span>云数据库按地域展示</span></div>
      <div className="server-summary"><span>实例总数：<strong>{items.length}</strong></span><span className="running">运行中：<strong>{items.filter((item) => String(item.DBInstanceStatus).toLowerCase() === "running").length}</strong></span><span className="stopped">已停止：<strong>{items.filter((item) => String(item.DBInstanceStatus).toLowerCase() === "stopped").length}</strong></span></div>
      {!items.length ? <div className="detail-empty"><Database size={36} />暂无云数据库实例</div> : <div>{regions.map(([regionId, region]) => <div className="region-section" key={regionId}><div className="region-title rds-region-title">{region.name} ({regionId}) - {region.items.length}个</div><div className="rds-grid">{region.items.map((item, index) => <RdsCard account={account} item={item} key={String(item.DBInstanceId || index)} />)}</div></div>)}</div>}
    </div>
  );
}

export function RedisResourcePanel({ account, resources, loading, regions, onRefresh }: {
  account: Account;
  resources: ResourceResponse | null;
  loading: boolean;
  regions: ResourceRegion[];
  onRefresh: RefreshResources;
}) {
  const items = resources?.items || [];
  return (
    <div className="redis-reference">
      <div className="server-toolbar"><button className="layui-btn layui-btn-warm" disabled={loading} onClick={() => onRefresh("redis")}><RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "拉取中…" : "实时拉取"}</button><span>Redis 实例按地域展示</span></div>
      <div className="server-summary"><span>实例总数：<strong>{items.length}</strong></span><span className="running">运行中：<strong>{items.filter((item) => String(item.InstanceStatus).toLowerCase() === "normal").length}</strong></span><span>总内存：<strong>{items.reduce((sum, item) => sum + Number(item.Capacity || 0), 0)} MB</strong></span></div>
      {!items.length ? <div className="detail-empty"><Cloud size={36} />暂无云 Redis 实例</div> : <div>{regions.map(([regionId, region]) => <div className="region-section" key={regionId}><div className="region-title redis-region-title">{region.name} ({regionId}) - {region.items.length}个</div><div className="redis-grid">{region.items.map((item, index) => <RedisCard account={account} item={item} onRefresh={() => onRefresh("redis")} key={String(item.InstanceId || index)} />)}</div></div>)}</div>}
    </div>
  );
}

export function OssResourcePanel({ account, resources, loading, quickTool, onQuickActionOpened, onRefresh, onConfirm, onPrompt }: {
  account: Account;
  resources: ResourceResponse | null;
  loading: boolean;
  quickTool: { accountId: number; bucket: string; kind: "files" | "stat" } | null;
  onQuickActionOpened: () => void;
  onRefresh: RefreshResources;
  onConfirm: (message: string) => Promise<boolean>;
  onPrompt: (message: string, initialValue?: string) => Promise<string | null>;
}) {
  const items = resources?.items || [];
  return (
    <div className="oss-reference">
      <div className="server-toolbar oss-toolbar"><button className="layui-btn layui-btn-warm" disabled={loading} onClick={() => onRefresh("oss")}><RefreshCw className={loading ? "spin" : undefined} size={14} />{loading ? "拉取中…" : "实时拉取"}</button><span className="oss-toolbar-title">对象存储桶</span></div>
      <div className="server-summary oss-summary"><span>存储桶总数</span><strong>{items.length}</strong></div>
      {!items.length ? <div className="detail-empty"><Cloud size={36} />暂无对象存储桶</div> : <div className="oss-grid">{items.map((item, index) => <BucketCard account={account} item={item} key={String(item.Name || index)} quickAction={quickTool?.accountId === account.id && quickTool.bucket === String(item.Name || "") ? quickTool.kind : null} onQuickActionOpened={onQuickActionOpened} onConfirm={onConfirm} onPrompt={onPrompt} />)}</div>}
    </div>
  );
}
