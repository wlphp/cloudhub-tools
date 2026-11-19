import * as aliyun from "./aliyun-rpc.mjs";
import * as tencent from "./tencent.mjs";
import * as volcengine from "./volcengine.mjs";
import * as jdcloud from "./jdcloud.mjs";
import * as baidu from "./baidu.mjs";
import * as vultr from "./vultr.mjs";
import * as cloudflare from "./cloudflare.mjs";
import * as core from "./finance-core.mjs";

const providers = { aliyun, tencent, volcengine, jdcloud, baidu, vultr, cloudflare };

export async function financeForAccount(row) {
  const cloudType = row.cloud_type;
  if (!row.enabled) {
    const payload = core.withLocalAccount(core.unavailable(cloudType, "disabled", "disabled", "账号已停用，启用后可刷新余额", "账号已停用，启用后可刷新余额"), row.id);
    payload.fetched_at = Date.now();
    return payload;
  }
  let payload;
  const provider = providers[cloudType];
  if (provider?.finance) {
    try {
      payload = await provider.finance(row.id);
    } catch (error) {
      payload = core.credentialError(cloudType, row.id, error);
    }
  } else {
    payload = staticPayload(cloudType);
  }
  payload.local_account_id = row.id;
  payload.cloud_type = cloudType;
  payload.fetched_at = Date.now();
  return payload;
}

function staticPayload(cloudType) {
  switch (cloudType) {
    case "oracle":
      return core.unavailable(cloudType, "unsupported", "pending", "OCI 未提供标准账户余额 API，控制台余额无法通过当前凭据读取", "OCI 消费需要 Usage API 及额外只读策略，当前版本尚未接入");
    case "ctyun":
      return core.unavailable(cloudType, "unsupported", "pending", "天翼云未公开账户余额接口", "天翼云 EOP 账单接口存在，但当前版本尚未接入");
    case "aws":
      return core.unavailable(cloudType, "unsupported", "pending", "AWS 没有账户余额 API；Cost Explorer 也不能读取预付余额", "AWS 消费需要启用 Cost Explorer 并授予 ce:GetCostAndUsage，当前版本尚未接入");
    case "azure":
      return core.unavailable(cloudType, "unsupported", "pending", "Azure 仅 MCA 计费账户提供余额 API，当前订阅级凭据无法查询", "Azure 消费需要 Cost Management 权限，当前版本尚未接入");
    case "gcp":
      return core.unavailable(cloudType, "unsupported", "unsupported", "GCP 没有账户余额 API", "GCP 消费仅能通过 BigQuery 账单导出或预算告警读取，暂不支持");
    case "huawei":
    case "ucloud":
    case "ksyun":
    case "qiniu":
      return core.unavailable(cloudType, "pending", "pending", "该厂商余额接口已确认，当前版本尚未接入", "该厂商消费接口已确认，当前版本尚未接入");
    case "qingcloud":
      return core.unavailable(cloudType, "pending", "unsupported", "青云 GetBalance 接口已确认，当前版本尚未接入", "青云没有账户级月账单 API，消费不支持");
    default:
      return core.unavailable(cloudType, "unsupported", "unsupported", "该云类型未接入余额查询", "该云类型未接入消费查询");
  }
}
