import { RefreshCw } from "lucide-react";
import type { Account } from "../../shared/types";
import {
  financeAmount,
  financeCapability,
  financeStatusDetail,
  financeStatusLabel,
  financeUpdatedAt,
  supportLabel,
  type AccountFinance,
} from "../cloud/finance";

type Props = {
  account: Account;
  finance?: AccountFinance;
  loading: boolean;
  onRefresh: () => void;
};

export function AccountBalanceCell({ account, finance, loading, onRefresh }: Props) {
  const capability = financeCapability(account.cloud_type);
  const currency = finance?.currency || capability.currency;
  const canRefresh = account.enabled && capability.balance === "supported";
  const balanceStatus = !account.enabled ? "disabled" : loading ? undefined : finance?.balance_status ?? (capability.balance === "supported" ? "unfetched" : capability.balance);
  const amount = finance?.available_amount ?? finance?.available_cash_amount ?? null;
  const balanceLabel = balanceStatus === "ok" && amount !== null
    ? financeAmount(amount, currency)
    : loading
      ? "查询中…"
      : financeStatusLabel(balanceStatus) || supportLabel(capability.balance);
  const consumeStatus = finance?.consume_status ?? (capability.consume === "supported" ? "unfetched" : capability.consume);
  const consumeAmount = finance?.month_consume ?? finance?.month_bill ?? null;
  const consumeLabel = loading
    ? "查询中…"
    : consumeStatus === "ok" && consumeAmount !== null
      ? financeAmount(consumeAmount, currency)
      : financeStatusLabel(consumeStatus) || supportLabel(capability.consume);
  const details = [
    account.enabled ? "" : "账号已停用，启用后可刷新余额",
    finance ? `更新于 ${financeUpdatedAt(finance.fetched_at)}` : "",
    finance ? financeStatusDetail(finance, "balance", capability.balance) : capability.note || financeStatusDetail(undefined, "balance", capability.balance),
    `本月：${financeStatusDetail(finance, "consume", capability.consume) || consumeLabel}`,
    canRefresh ? "点击刷新余额" : "",
  ].filter(Boolean);
  const title = details.join("\n");
  const content = <>
    <strong className={`account-balance-value${balanceStatus && balanceStatus !== "ok" ? ` is-${balanceStatus}` : ""}${typeof amount === "number" && amount < 0 ? " is-negative" : ""}`}>
      {loading && <RefreshCw size={12} className="spin" aria-hidden="true" />}
      {balanceLabel}
    </strong>
    <small className={`account-balance-consume${consumeStatus && consumeStatus !== "ok" ? ` is-${consumeStatus}` : ""}`}>
      本月 {consumeLabel}
    </small>
  </>;
  if (!canRefresh) {
    return <div className="account-balance-content" title={title}>{content}</div>;
  }
  return <div className="account-balance-content">
    <button
      type="button"
      className="account-balance-refresh"
      title={title}
      aria-label={`刷新 ${account.account_name} 的余额`}
      aria-busy={loading}
      disabled={loading}
      onClick={onRefresh}
    >
      {content}
    </button>
  </div>;
}
