import { formatMoney } from "../../shared/utils/format";

export type FinanceStatus = "ok" | "permission" | "auth" | "network" | "error" | "unsupported" | "pending" | "disabled" | "unfetched";
export type FinanceSupport = "supported" | "pending" | "unsupported";

export type AccountFinance = {
  local_account_id: number;
  cloud_account_id?: string | null;
  cloud_type: string;
  account_type?: string | null;
  balance_status: FinanceStatus;
  consume_status: FinanceStatus;
  balance_message?: string | null;
  consume_message?: string | null;
  available_amount?: number | null;
  available_cash_amount?: number | null;
  credit_amount?: number | null;
  month_consume?: number | null;
  month_bill?: number | null;
  currency?: string | null;
  notes?: string[];
  fetched_at?: number;
};

export type FinanceCapability = {
  balance: FinanceSupport;
  consume: FinanceSupport;
  currency?: string;
  note?: string;
};

const capabilityByCloudType: Record<string, FinanceCapability> = {
  aliyun: { balance: "supported", consume: "supported", currency: "CNY" },
  tencent: { balance: "supported", consume: "supported", currency: "CNY" },
  volcengine: { balance: "supported", consume: "supported", currency: "CNY" },
  jdcloud: { balance: "supported", consume: "supported", currency: "CNY" },
  baidu: { balance: "supported", consume: "supported", currency: "CNY" },
  vultr: { balance: "supported", consume: "supported", currency: "USD", note: "本月消费为待结算费用" },
  cloudflare: { balance: "supported", consume: "supported", currency: "USD", note: "本月消费按账单记录汇总" },
  oracle: { balance: "unsupported", consume: "pending", note: "OCI 未提供标准账户余额 API；消费需要 Usage API 及额外策略" },
  ctyun: { balance: "unsupported", consume: "pending", note: "天翼云未公开账户余额接口；EOP 账单接口尚未接入" },
  huawei: { balance: "pending", consume: "pending", note: "余额与消费接口已确认，当前版本尚未接入" },
  ucloud: { balance: "pending", consume: "pending", note: "余额与消费接口已确认，当前版本尚未接入" },
  qingcloud: { balance: "pending", consume: "unsupported", note: "余额接口已确认尚未接入；没有账户级月账单 API" },
  ksyun: { balance: "pending", consume: "pending", note: "余额与消费接口已确认，当前版本尚未接入" },
  qiniu: { balance: "pending", consume: "pending", note: "余额与消费接口已确认，当前版本尚未接入" },
  aws: { balance: "unsupported", consume: "pending", note: "AWS 没有账户余额 API；消费需要 Cost Explorer" },
  azure: { balance: "unsupported", consume: "pending", note: "余额仅 MCA 计费账户可用；消费需要 Cost Management" },
  gcp: { balance: "unsupported", consume: "unsupported", note: "没有账户余额 API；消费仅能通过 BigQuery 导出" },
  other: { balance: "unsupported", consume: "unsupported", note: "该云类型未接入余额查询" },
};

export function financeCapability(cloudType: string): FinanceCapability {
  return capabilityByCloudType[cloudType] || capabilityByCloudType.other;
}

export function financePlaceholder(accountId: number, cloudType: string): AccountFinance {
  const capability = financeCapability(cloudType);
  const map = (support: FinanceSupport): FinanceStatus => support === "supported" ? "unfetched" : support;
  return {
    local_account_id: accountId,
    cloud_type: cloudType,
    balance_status: map(capability.balance),
    consume_status: map(capability.consume),
    balance_message: capability.note || null,
    consume_message: capability.note || null,
    currency: capability.currency || null,
  };
}

export function supportLabel(support: FinanceSupport): string {
  return support === "supported" ? "未查询" : support === "pending" ? "待接入" : "不支持";
}

export function financeStatusLabel(status: FinanceStatus | undefined): string {
  switch (status) {
    case "ok": return "";
    case "permission": return "无权限";
    case "auth": return "凭据失效";
    case "network": return "网络失败";
    case "error": return "查询失败";
    case "unsupported": return "不支持";
    case "pending": return "待接入";
    case "disabled": return "已停用";
    default: return "未查询";
  }
}

export function currencySymbol(currency?: string | null): string {
  if (currency === "USD") return "$";
  if (currency === "CNY" || !currency) return "¥";
  return `${currency} `;
}

export function currencyUnit(currency?: string | null): string {
  if (currency === "USD") return "美元";
  if (currency === "CNY" || !currency) return "元";
  return currency || "-";
}

export function financeAmount(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined) return "-";
  return `${currencySymbol(currency)}${formatMoney(value)}`;
}

export function financeStatusDetail(finance: AccountFinance | undefined, kind: "balance" | "consume", support: FinanceSupport): string {
  if (!finance) {
    const capability = support === "supported" ? "尚未查询，点击刷新" : support === "pending" ? "该厂商接口已确认，当前版本尚未接入" : "该厂商未提供对应接口";
    return capability;
  }
  const message = kind === "balance" ? finance.balance_message : finance.consume_message;
  const notes = finance.notes?.length ? finance.notes.join("；") : "";
  if (message && notes) return `${message}；${notes}`;
  return message || notes || "";
}

export function financeUpdatedAt(fetchedAt?: number): string {
  if (!fetchedAt) return "";
  return new Date(fetchedAt).toLocaleString("zh-CN");
}
