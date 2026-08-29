import { Globe2, List, Server, UserRound } from "lucide-react";
import type { Account } from "../../shared/types";
import { displayValue, formatAssetDate } from "../../shared/utils/display";
import { formatMoney, summaryMetricClass } from "./presentation";

export function AccountSummaryPanel({
  account,
  source,
  summary,
}: {
  account: Account;
  source: "cache" | "live";
  summary: Record<string, unknown> | null;
}) {
  return (
    <div className="summary-reference summary-workbench">
      <div className="server-toolbar summary-source-toolbar">
        <span>{source === "cache" ? `当前展示本地缓存${summary?.cached_at ? `，更新于 ${formatAssetDate(summary.cached_at)}` : ""}` : "当前展示实时拉取结果，资源缓存已更新"}</span>
      </div>
      <section className="summary-block-section summary-account-block">
        <h3><UserRound size={15} aria-hidden="true" />账号信息</h3>
        <div className="summary-info-grid">
          <div><span>{account.cloud_type === "tencent" ? "腾讯云 AppId：" : "账号ID："}</span><strong>{displayValue(summary?.account_id)}</strong></div>
          <div><span>账号类型：</span><strong>{displayValue(summary?.account_type)}</strong></div>
        </div>
      </section>
      <section className="summary-block-section summary-finance-block">
        <h3><Globe2 size={15} aria-hidden="true" />账户余额</h3>
        <div className="summary-balance-grid">
          <div className="summary-balance-item"><strong className={summaryMetricClass("orange", summary?.available_amount)}>{formatMoney(summary?.available_amount)}</strong><span>可用余额(元)</span></div>
          <div className="summary-balance-item"><strong className={summaryMetricClass("green", summary?.available_cash_amount)}>{formatMoney(summary?.available_cash_amount)}</strong><span>现金余额(元)</span></div>
          <div className="summary-balance-item"><strong className={summaryMetricClass("blue", summary?.credit_amount)}>{formatMoney(summary?.credit_amount)}</strong><span>{account.cloud_type === "tencent" ? "赠送金/代金券余额(元)" : "信用额度(元)"}</span></div>
        </div>
      </section>
      <section className="summary-block-section summary-consumption-block">
        <h3><List size={15} aria-hidden="true" />消费统计</h3>
        <div className="summary-consume-grid">
          <div className="summary-consume-item"><strong className={summaryMetricClass("pink", summary?.month_consume)}>{formatMoney(summary?.month_consume)}</strong><span>本月消费(元)</span></div>
          <div className="summary-consume-item"><strong className={summaryMetricClass("purple", summary?.month_bill)}>{formatMoney(summary?.month_bill)}</strong><span>本月账单(元)</span></div>
        </div>
      </section>
      <section className="summary-block-section summary-resources-block">
        <h3><Server size={15} aria-hidden="true" />资源统计</h3>
        <div className="summary-resource-grid">
          <div className="summary-resource-item"><strong className="summary-resource-value value-blue">{displayValue(summary?.ecs_count) || 0}</strong><span>{account.cloud_type === "tencent" ? "CVM服务器" : "ECS服务器"}</span></div>
          <div className="summary-resource-item"><strong className="summary-resource-value value-gray">{displayValue(summary?.swas_count) || 0}</strong><span>轻量服务器</span></div>
          <div className="summary-resource-item"><strong className="summary-resource-value value-green">{displayValue(summary?.rds_count) || 0}</strong><span>云数据库</span></div>
          <div className="summary-resource-item"><strong className="summary-resource-value value-pink">{displayValue(summary?.redis_count) || 0}</strong><span>云Redis</span></div>
          <div className="summary-resource-item"><strong className="summary-resource-value value-green">{displayValue(summary?.oss_count) || 0}</strong><span>对象存储桶</span></div>
          <div className="summary-resource-item"><strong className="summary-resource-value value-purple">{displayValue(summary?.domain_count) || 0}</strong><span>域名</span></div>
          <div className="summary-resource-item"><strong className="summary-resource-value value-orange">{displayValue(summary?.dns_record_count) || 0}</strong><span>DNS记录</span></div>
        </div>
      </section>
    </div>
  );
}
