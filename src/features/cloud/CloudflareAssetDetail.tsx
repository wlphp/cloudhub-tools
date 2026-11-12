import { Globe } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";

type Row = Record<string, unknown>;
const labels: Record<string, string> = {
  DomainName: "域名", Id: "资源 ID", Name: "资源名称", Status: "状态", _region_id: "区域",
  created_on: "创建时间", created_at: "创建时间", creation_date: "创建时间", modified_on: "更新时间",
  paused: "暂停服务", type: "接入方式", compatibility_date: "兼容日期", usage_model: "计费模式",
  location: "存储位置", jurisdiction: "管辖区域", storage_class: "存储类型", subdomain: "默认域名",
  production_branch: "生产分支", deleted_at: "删除时间", remote_config: "远程配置",
};
const statuses: Record<string, string> = { active: "正常", pending: "待生效", initializing: "初始化中", moved: "已迁移", deactivated: "已停用", deleted: "已删除", healthy: "健康", degraded: "异常", down: "离线", inactive: "未启用" };
const aliases: Record<string, string> = { id: "Id", name: "Name", status: "Status" };
const dateKeys = new Set(["created_on", "created_at", "creation_date", "modified_on", "deleted_at"]);

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (dateKeys.has(key) && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN", { hour12: false });
  }
  if (key === "_region_id" && value === "global") return "全球";
  if (key === "type" && value === "full") return "完整接入";
  if (key === "type" && value === "partial") return "CNAME 接入";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

export function CloudflareAssetDetail({ asset, kindLabel, onClose }: { asset: Row; kindLabel: string; onClose: () => void }) {
  const name = String(asset.Name ?? asset.name ?? asset.DomainName ?? "未命名资产");
  const status = String(asset.Status ?? asset.status ?? "");
  const entries = Object.entries(asset).filter(([key, val]) => {
    if (["Name", "name", "Status", "status"].includes(key)) return false;
    if (key === "DomainName" && val === name) return false;
    return !(aliases[key] && asset[aliases[key]] === val);
  });
  const fields = entries.filter(([key]) => labels[key]);
  const extra = entries.filter(([key]) => !labels[key]);
  const renderField = ([key, val]: [string, unknown]) => <div key={key} className={key === "Id" || typeof val === "object" ? "cloudflare-detail-wide" : ""}>
    <dt>{labels[key] ?? key}</dt><dd className={key === "Id" ? "cloudflare-detail-id" : ""}>{formatValue(key, val)}</dd>
  </div>;

  return <SharedDialog title="Cloudflare 资产详情" sizeStorageKey="cloudflare-asset-detail" className="cloudflare-asset-detail" onClose={onClose}
    footer={<button type="button" className="secondary" onClick={onClose}>关闭</button>}>
    <div className="cloudflare-detail-summary">
      <span className="cloudflare-detail-icon"><Globe size={22} aria-hidden="true" /></span>
      <div className="cloudflare-detail-identity"><span>{kindLabel}</span><h3>{name}</h3></div>
      {status && <span className="cloudflare-detail-status">{statuses[status] ?? status}</span>}
    </div>
    <dl className="cloudflare-detail-fields">{fields.map(renderField)}</dl>
    {extra.length > 0 && <details className="cloudflare-detail-extra"><summary>更多技术字段（{extra.length}）</summary><dl className="cloudflare-detail-fields">{extra.map(renderField)}</dl></details>}
  </SharedDialog>;
}
