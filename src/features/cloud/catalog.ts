import type { Account, Draft, ManagedHostDraft, PanelConnectionDraft, View } from "../../shared/types";

export const emptyAccountDraft: Draft = {
  account_name: "",
  cloud_type: "aliyun",
  group_name: "",
  access_key_id: "",
  access_key_secret: "",
  tenancy_ocid: "",
  key_fingerprint: "",
  tenant_id: "",
  subscription_id: "",
  project_id: "",
  region_id: "",
  sort_order: 0,
  enabled: true,
  remark: "",
};

export const emptyManagedHostDraft: ManagedHostDraft = {
  name: "",
  host: "",
  port: 22,
  username: "root",
  password: "",
  platform: "linux",
  auth_method: "password",
  private_key: "",
  key_passphrase: "",
  group_name: "",
  tags: "",
  remark: "",
};

export const emptyPanelConnectionDraft: PanelConnectionDraft = {
  name: "",
  panel_url: "",
  sort_order: 0,
  api_key: "",
  allow_insecure_tls: true,
  group_name: "",
  remark: "",
  ssh_port: 22,
  ssh_username: "root",
  ssh_password: "",
  ssh_password_saved: false,
};

export const resourceLabels: Record<Exclude<View, "summary">, string> = {
  ecs: "服务器",
  domain: "域名",
  oss: "对象存储",
  rds: "云数据库",
  redis: "Redis",
  swas: "轻量应用服务器",
  esa: "边缘安全加速",
};

export const cloudProviders = [
  { value: "aliyun", label: "阿里云", idLabel: "AccessKey ID", secretLabel: "AccessKey Secret", regionPlaceholder: "cn-hangzhou", avatar: "阿" },
  { value: "tencent", label: "腾讯云", idLabel: "SecretId", secretLabel: "SecretKey", regionPlaceholder: "ap-guangzhou", avatar: "腾" },
  { value: "volcengine", label: "火山引擎", idLabel: "AccessKey ID", secretLabel: "Secret Access Key", regionPlaceholder: "cn-beijing", avatar: "火" },
  { value: "ctyun", label: "天翼云", idLabel: "AccessKey", secretLabel: "SecretKey", regionPlaceholder: "cn-huabei-9", avatar: "翼" },
  { value: "oracle", label: "Oracle Cloud", idLabel: "User OCID", secretLabel: "API 私钥 PEM", regionPlaceholder: "ap-tokyo-1", avatar: "甲" },
  { value: "huawei", label: "华为云", idLabel: "Access Key", secretLabel: "Secret Key", regionPlaceholder: "cn-north-4", avatar: "华" },
  { value: "baidu", label: "百度智能云", idLabel: "Access Key", secretLabel: "Secret Key", regionPlaceholder: "bj", avatar: "百" },
  { value: "jdcloud", label: "京东云", idLabel: "Access Key", secretLabel: "Secret Key", regionPlaceholder: "cn-north-1", avatar: "京" },
  { value: "ucloud", label: "UCloud", idLabel: "PublicKey", secretLabel: "PrivateKey", regionPlaceholder: "cn-bj2", avatar: "U" },
  { value: "qingcloud", label: "青云 QingCloud", idLabel: "Access Key ID", secretLabel: "Secret Access Key", regionPlaceholder: "pek3a", avatar: "青" },
  { value: "ksyun", label: "金山云", idLabel: "AccessKey ID", secretLabel: "AccessKey Secret", regionPlaceholder: "cn_beijing_6", avatar: "金" },
  { value: "qiniu", label: "七牛云", idLabel: "AccessKey", secretLabel: "SecretKey", regionPlaceholder: "z0", avatar: "七" },
  { value: "aws", label: "AWS", idLabel: "Access Key ID", secretLabel: "Secret Access Key", regionPlaceholder: "ap-northeast-1", avatar: "A" },
  { value: "azure", label: "Microsoft Azure", idLabel: "Client ID", secretLabel: "Client Secret", regionPlaceholder: "eastasia", avatar: "Az" },
  { value: "gcp", label: "Google Cloud", idLabel: "Service Account Email", secretLabel: "Private Key PEM", regionPlaceholder: "asia-east1", avatar: "G" },
  { value: "vultr", label: "Vultr", idLabel: "API Key 标识（可选）", secretLabel: "Vultr API Key", regionPlaceholder: "ewr", avatar: "V" },
] as const;

const legacyOtherCloudProvider = { value: "other", label: "未接入云", idLabel: "凭证 ID", secretLabel: "凭证 Secret", regionPlaceholder: "可选", avatar: "云" } as const;

export function cloudProvider(value: string) {
  return cloudProviders.find((provider) => provider.value === value) || legacyOtherCloudProvider;
}

export const assetTypes = [
  ["ecs", "服务器"], ["domain", "域名"], ["oss", "对象存储"], ["rds", "云数据库"], ["redis", "Redis"], ["swas", "轻量应用服务器"], ["esa", "边缘安全加速"], ["block", "块存储"], ["network", "私有网络"], ["firewall", "防火墙"], ["ip", "保留 IP"], ["loadbalancer", "负载均衡"], ["snapshot", "快照"], ["kubernetes", "Kubernetes"],
] as const;

export function supportsResourceSync(account: Account) {
  return ["aliyun", "vultr", "tencent", "volcengine", "ctyun", "oracle", "huawei", "baidu", "jdcloud", "ucloud", "qingcloud", "ksyun", "qiniu", "aws", "azure", "gcp"].includes(account.cloud_type);
}

export function providerSyncDescription(cloudType: string) {
  const descriptions: Record<string, string> = {
    aliyun: "ECS、域名、轻量应用服务器、RDS、Redis、OSS 和 ESA 资产同步",
    vultr: "云计算、DNS、对象存储、托管数据库、块存储、VPC、防火墙、保留 IP、负载均衡、快照和 Kubernetes 资产同步",
    tencent: "CVM、域名、轻量应用服务器、云数据库、Redis、对象存储和边缘安全加速资产同步",
    volcengine: "ECS、轻量应用服务器、MySQL RDS、Redis、TOS、火山 DNS 和 CDN 域名只读同步",
    ctyun: "云主机、私有 DNS、MySQL RDS、Redis 和 ZOS 存储桶只读同步",
    oracle: "Compute、DNS Zone、Database DB System 及 Object Storage 存储桶只读同步",
    huawei: "按 IAM 项目和区域同步 ECS、DNS、RDS、Redis 与 OBS 存储桶",
    baidu: "BCC、云 DNS、RDS、Redis 与 BOS 存储桶只读同步",
    jdcloud: "云主机、轻量云主机、云解析、RDS、Redis 与 OSS 存储桶只读同步",
    ucloud: "UHost、UDNS、UDB、URedis 与 UFile 存储桶只读同步",
    qingcloud: "实例、DNS Alias、RDB、Cache 与 QingStor 存储桶只读同步",
    ksyun: "KEC、KRDS、KCS 与 KS3 存储桶只读同步",
    qiniu: "Kodo 存储桶清单只读同步",
    aws: "EC2、Route 53、RDS、ElastiCache 与 S3 存储桶只读同步",
    azure: "虚拟机、DNS Zone、SQL Server、Azure Cache for Redis 与 Storage Account 只读同步",
    gcp: "Compute Engine、Cloud DNS、Cloud SQL、Memorystore 与 Cloud Storage 只读同步",
  };
  return descriptions[cloudType] || "账号可保存和筛选，资源同步尚未接入";
}

export function syncAssetTypes(account: Account): ReadonlyArray<(typeof assetTypes)[number]> {
  if (!supportsResourceSync(account)) return [];
  const resourcesByProvider: Record<string, string[]> = {
    qiniu: ["oss"],
    vultr: ["ecs", "domain", "oss", "rds", "block", "network", "firewall", "ip", "loadbalancer", "snapshot", "kubernetes"],
    jdcloud: ["ecs", "domain", "swas", "rds", "redis", "oss"],
    qingcloud: ["ecs", "domain", "rds", "redis", "oss"],
    ksyun: ["ecs", "rds", "redis", "oss"],
    huawei: ["ecs", "domain", "rds", "redis", "oss"],
    baidu: ["ecs", "domain", "rds", "redis", "oss"],
    ucloud: ["ecs", "domain", "rds", "redis", "oss"],
    aws: ["ecs", "domain", "rds", "redis", "oss"],
    azure: ["ecs", "domain", "rds", "redis", "oss"],
    gcp: ["ecs", "domain", "rds", "redis", "oss"],
    oracle: ["ecs", "domain", "rds", "oss"],
    ctyun: ["ecs", "domain", "rds", "redis", "oss"],
    volcengine: ["ecs", "domain", "swas", "rds", "redis", "oss", "esa"],
    default: ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"],
  };
  return assetTypes.filter(([value]) => (resourcesByProvider[account.cloud_type] || resourcesByProvider.default).includes(value));
}
