import { safeProviderError } from "../core/resources.mjs";

export const BALANCE_SUPPORTED = ["aliyun", "tencent", "volcengine", "jdcloud", "baidu", "vultr", "cloudflare"];

export function supportsBalance(cloudType) {
  return BALANCE_SUPPORTED.includes(cloudType);
}

export function defaultCurrency(cloudType) {
  if (["vultr", "cloudflare", "aws", "gcp"].includes(cloudType)) return "USD";
  if (["aliyun", "tencent", "volcengine", "jdcloud", "baidu", "ctyun", "huawei", "ucloud", "qingcloud", "ksyun", "qiniu"].includes(cloudType)) return "CNY";
  return null;
}

export function base(cloudType) {
  return {
    local_account_id: null,
    cloud_account_id: null,
    cloud_type: cloudType,
    account_type: null,
    balance_status: "unfetched",
    consume_status: "unfetched",
    balance_message: null,
    consume_message: null,
    available_amount: null,
    available_cash_amount: null,
    credit_amount: null,
    month_consume: null,
    month_bill: null,
    currency: defaultCurrency(cloudType),
    notes: [],
    fetched_at: Date.now(),
  };
}

export function withLocalAccount(payload, id) {
  payload.local_account_id = id;
  return payload;
}

export function unavailable(cloudType, balanceStatus, consumeStatus, balanceMessage, consumeMessage) {
  const payload = base(cloudType);
  payload.balance_status = balanceStatus;
  payload.consume_status = consumeStatus;
  if (balanceMessage) payload.balance_message = balanceMessage;
  if (consumeMessage) payload.consume_message = consumeMessage;
  return payload;
}

export function safeMessage(message) {
  const text = String(message?.message || message || "");
  if (/Unauthorized IP address/i.test(text)) {
    return "Vultr API Key 未授权当前出口 IP，请在 Vultr 控制台允许该 IP 后重试";
  }
  return safeProviderError(message);
}

export function statusFromError(message) {
  const text = String(message?.message || message || "");
  if (/Unauthorized IP address/i.test(text)) return "permission";
  const safe = safeMessage(message);
  if (safe.includes("权限不足")) return "permission";
  if (safe.includes("认证失败")) return "auth";
  if (safe.includes("频繁") || safe.includes("网络暂时不可用")) return "network";
  return "error";
}

export function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(String(value).trim().replace(/[,，\s]/g, ""));
  return Number.isFinite(result) ? result : null;
}

export function numberField(value, keys) {
  for (const key of keys) {
    const result = number(value?.[key]);
    if (result !== null) return result;
  }
  return null;
}

export function setBalanceOk(payload, available, cash, credit) {
  payload.balance_status = "ok";
  payload.balance_message = null;
  if (available !== null) payload.available_amount = available;
  if (cash !== null) payload.available_cash_amount = cash;
  if (credit !== null) payload.credit_amount = credit;
}

export function setBalanceError(payload, error) {
  payload.balance_status = statusFromError(error);
  payload.balance_message = safeMessage(error);
}

/** 厂商明确不提供该账号类型的余额（例如免费计划没有计费资料）。 */
export function setBalanceUnsupported(payload, message) {
  payload.balance_status = "unsupported";
  payload.balance_message = message;
}

export function setConsumeOk(payload, consume, bill) {
  payload.consume_status = "ok";
  payload.consume_message = null;
  if (consume !== null) payload.month_consume = consume;
  if (bill !== null) payload.month_bill = bill;
}

export function setConsumeError(payload, error) {
  payload.consume_status = statusFromError(error);
  payload.consume_message = safeMessage(error);
}

export function setConsumePending(payload, message) {
  payload.consume_status = "pending";
  payload.consume_message = message;
}

export function setConsumeUnsupported(payload, message) {
  payload.consume_status = "unsupported";
  payload.consume_message = message;
}

export function addNote(payload, note) {
  payload.notes.push(note);
}

export function setCloudIdentity(payload, cloudAccountId, accountType) {
  if (cloudAccountId) payload.cloud_account_id = String(cloudAccountId);
  if (accountType) payload.account_type = accountType;
}

export function credentialError(cloudType, id, error) {
  const payload = withLocalAccount(base(cloudType), id);
  const text = String(error?.message || error || "");
  let message = "读取账号信息失败，请重新保存账号后重试";
  let status = "error";
  if (text.includes("已停用")) {
    message = "账号已停用，启用后可刷新余额";
    status = "disabled";
  } else if (/凭据|Secret|解密/i.test(text)) {
    message = "读取账号凭据失败，请检查账号 Secret 是否完整";
    status = "auth";
  } else if (/地域/.test(text)) {
    message = "账号地域配置无效，请检查账号设置中的默认地域";
    status = "error";
  }
  payload.balance_status = status;
  payload.consume_status = status;
  payload.balance_message = message;
  payload.consume_message = message;
  return payload;
}
