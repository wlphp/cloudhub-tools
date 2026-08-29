import http from "node:http";
import crypto from "node:crypto";
import { database, decryptSecret, encryptSecret, writeApiLog } from "./web-api/core/storage.mjs";
import { send } from "./web-api/core/http.mjs";
import { firstAddress } from "./web-api/core/values.mjs";
import { handleAccountRoutes } from "./web-api/routes/accounts.mjs";
import { handleAssetRoutes } from "./web-api/routes/assets.mjs";
import { handleLogRoutes } from "./web-api/routes/logs.mjs";
import { handleDomainRoutes } from "./web-api/routes/domains.mjs";
import { handleOssRoutes } from "./web-api/routes/oss.mjs";
import { handleResourceRoutes } from "./web-api/routes/resources.mjs";
import { handleResourceDetailRoutes } from "./web-api/routes/resource-details.mjs";
import { handleInstanceActionRoutes } from "./web-api/routes/instance-actions.mjs";
import { handleCloudSummaryRoute } from "./web-api/routes/cloud-summary.mjs";
import { createCtyunProvider } from "./web-api/providers/ctyun.mjs";
import { createBaiduProvider } from "./web-api/providers/baidu.mjs";
import { createAwsProvider } from "./web-api/providers/aws.mjs";
import { createAzureProvider } from "./web-api/providers/azure.mjs";
import { createGcpProvider } from "./web-api/providers/gcp.mjs";
import { createJdcloudProvider } from "./web-api/providers/jdcloud.mjs";
import { createQiniuProvider } from "./web-api/providers/qiniu.mjs";
import { createHuaweiProvider } from "./web-api/providers/huawei.mjs";
import { createOracleProvider } from "./web-api/providers/oracle.mjs";
import { createUcloudProvider } from "./web-api/providers/ucloud.mjs";
import { createQingcloudProvider } from "./web-api/providers/qingcloud.mjs";
import { createKsyunProvider } from "./web-api/providers/ksyun.mjs";
import { createVolcengineProvider } from "./web-api/providers/volcengine.mjs";
import { createTencentProvider } from "./web-api/providers/tencent.mjs";
import { createOssProvider } from "./web-api/providers/oss.mjs";
import { createVultrProvider } from "./web-api/providers/vultr.mjs";
import { createAliyunProvider } from "./web-api/providers/aliyun.mjs";
import { createAccountService } from "./web-api/services/accounts.mjs";
import { createAssetService } from "./web-api/services/assets.mjs";
import { createInstanceActionService } from "./web-api/services/instance-actions.mjs";

function webApiPort(value) {
  const port = Number(value || 1430);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 1430;
}

const port = webApiPort(process.env.CLOUDHUB_TOOLS_WEB_API_PORT || process.env.ALIYUN_TOOLS_WEB_API_PORT);

function rpcEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function configuredRegions(accountId, fallback) {
  const account = database().prepare("SELECT region_id FROM cloud_accounts WHERE id=?").get(accountId);
  const values = String(account?.region_id || fallback).split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean);
  return [...new Set(values.length ? values : [fallback])];
}
function awsSign(key, value) { return crypto.createHmac("sha256", key).update(value).digest(); }
function awsQuery(query = {}) { return Object.entries(query).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [rpcEncode(key), rpcEncode(value)]).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)).map(([key, value]) => `${key}=${value}`).join("&"); }
function azureMeta(row) { let meta = {}; try { meta = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ } const tenantId = String(meta.tenant_id || "").trim(); const subscriptionId = String(meta.subscription_id || "").trim(); if (!tenantId || !subscriptionId) throw new Error("Azure 账号缺少 Tenant ID 或 Subscription ID"); return { tenantId, subscriptionId }; }
function gcpMeta(row) { let meta = {}; try { meta = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ } const projectId = String(meta.project_id || "").trim(); if (!projectId) throw new Error("GCP 账号缺少 Project ID"); return { projectId }; }
function arr(data, path) {
  let value = data;
  for (const key of path) value = value?.[key];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
function xmlDecode(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function xmlText(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match ? xmlDecode(match[1]).trim() : "";
}
function xmlBlocks(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"))].map((match) => match[1]);
}
let oss;
const aliyun = createAliyunProvider({
  crypto,
  database,
  decryptSecret,
  writeApiLog,
  arr,
  xmlText,
  xmlBlocks,
  getOss: () => oss,
  edgeResources: (cloudType, id) => cloudType === "tencent" ? tencent.resources(id, "esa") : volcengine.resources(id, "esa"),
});
const rpc = aliyun.rpc;
oss = createOssProvider({ crypto, database, decryptSecret, rpc, xmlDecode, xmlText, xmlBlocks });
const ossObjects = oss.objects;
const ossAcl = oss.acl;
const ossDetail = oss.detail;
const ossSetPublicRead = oss.setPublicRead;
const ossSetCors = oss.setCors;
const ossCnameMutation = oss.cnameMutation;
const vultr = createVultrProvider({ database, decryptSecret, writeApiLog });
const vultrResources = vultr.resources;
const verifyVultrAccount = vultr.verifyAccount;
const volcengine = createVolcengineProvider({ crypto, database, decryptSecret, writeApiLog, arr, xmlText, xmlBlocks });
const tencent = createTencentProvider({ crypto, database, decryptSecret, writeApiLog, arr, cosBuckets: oss.listBuckets });
const volcResources = volcengine.resources;
const ctyun = createCtyunProvider({ crypto, database, decryptSecret, writeApiLog, arr });
const ctyunRequest = ctyun.request;
const ctyunResources = ctyun.resources;
const verifyCtyunAccount = ctyun.verifyAccount;
const huawei = createHuaweiProvider({ crypto, database, decryptSecret, writeApiLog, arr, xmlText, xmlBlocks });
const huaweiResources = huawei.resources;
const verifyHuaweiAccount = huawei.verifyAccount;
const baidu = createBaiduProvider({ crypto, database, decryptSecret, writeApiLog, xmlText, xmlBlocks });
const baiduBccAction = baidu.bccAction;
const baiduResources = baidu.resources;
const verifyBaiduAccount = baidu.verifyAccount;
const oracle = createOracleProvider({ crypto, database, decryptSecret, writeApiLog });
const oracleMeta = oracle.metadata;
const serializeOciPrivateKey = oracle.serializePrivateKey;
const oracleResources = oracle.resources;
const oracleInstanceAction = oracle.instanceAction;
const oracleInstanceDisks = oracle.instanceDisks;
const ucloud = createUcloudProvider({ crypto, database, decryptSecret, writeApiLog, configuredRegions, firstAddress });
const ucloudResources = ucloud.resources;
const verifyUcloudAccount = ucloud.verifyAccount;
const aws = createAwsProvider({ crypto, database, decryptSecret, writeApiLog, configuredRegions, queryString: awsQuery, sign: awsSign, xmlText, xmlBlocks });
const awsResources = aws.resources;
const verifyAwsAccount = aws.verifyAccount;
const azure = createAzureProvider({ database, decryptSecret, configuredRegions, metadata: azureMeta });
const azureResources = azure.resources;
const verifyAzureAccount = azure.verifyAccount;
const gcp = createGcpProvider({ crypto, database, decryptSecret, configuredRegions, metadata: gcpMeta });
const gcpResources = gcp.resources;
const verifyGcpAccount = gcp.verifyAccount;
const qiniu = createQiniuProvider({ crypto, database, decryptSecret, writeApiLog, configuredRegions });
const qiniuResources = qiniu.resources;
const verifyQiniuAccount = qiniu.verifyAccount;
const jdcloud = createJdcloudProvider({ crypto, database, decryptSecret, writeApiLog, configuredRegions, firstAddress, queryString: awsQuery, sign: awsSign });
const jdcloudRequest = jdcloud.request;
const jdcloudInstanceAction = jdcloud.instanceAction;
const jdcloudFirewallMutation = jdcloud.firewallMutation;
const jdcloudResources = jdcloud.resources;
const verifyJdcloudAccount = jdcloud.verifyAccount;
const instanceActionService = createInstanceActionService({ database, rpc, arr, tencent, baidu, jdcloudRequest });
const {
  securityGroupRuleParams,
  aliyunSecurityGroupDetails,
  baiduSecurityGroupDetails,
  baiduSecurityGroupRuleInput,
  lightFirewallDetails,
  lightFirewallRuleInput,
} = instanceActionService;
const qingcloud = createQingcloudProvider({ crypto, database, decryptSecret, writeApiLog, configuredRegions, firstAddress, queryString: awsQuery });
const qingcloudResources = qingcloud.resources;
const verifyQingcloudAccount = qingcloud.verifyAccount;
const ksyun = createKsyunProvider({ crypto, database, decryptSecret, writeApiLog, configuredRegions, firstAddress, queryString: awsQuery, xmlText, xmlBlocks });
const ksyunResources = ksyun.resources;
const verifyKsyunAccount = ksyun.verifyAccount;
const esaOverview = aliyun.esaOverview;

async function cloudResources(id, type) {
  const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
  if (!account) throw new Error("云账号不存在");
  const providers = {
    aliyun: aliyun.resources,
    vultr: vultr.resources,
    tencent: tencent.resources,
    volcengine: volcengine.resources,
    ctyun: ctyun.resources,
    huawei: huawei.resources,
    baidu: baidu.resources,
    ucloud: ucloud.resources,
    qiniu: qiniu.resources,
    aws: aws.resources,
    azure: azure.resources,
    gcp: gcp.resources,
    jdcloud: jdcloud.resources,
    qingcloud: qingcloud.resources,
    ksyun: ksyun.resources,
    oracle: oracle.resources,
  };
  const provider = providers[account.cloud_type];
  if (!provider) throw new Error("当前云类型资源 API 尚未接入");
  return provider(id, type);
}

const accountService = createAccountService({
  database,
  decryptSecret,
  encryptSecret,
  oracleMeta,
  azureMeta,
  gcpMeta,
  serializeOciPrivateKey,
});
const assetService = createAssetService({ database, cloudResources });
const accounts = accountService.list;
const saveAccount = accountService.save;
const localAssets = assetService.list;
const syncCloudAssets = assetService.sync;
const updateCachedServerName = assetService.updateCachedServerName;

const accountVerifiers = {
  vultr: verifyVultrAccount,
  ctyun: verifyCtyunAccount,
  huawei: verifyHuaweiAccount,
  baidu: verifyBaiduAccount,
  ucloud: verifyUcloudAccount,
  qiniu: verifyQiniuAccount,
  aws: verifyAwsAccount,
  azure: verifyAzureAccount,
  gcp: verifyGcpAccount,
  jdcloud: verifyJdcloudAccount,
  qingcloud: verifyQingcloudAccount,
  ksyun: verifyKsyunAccount,
};
async function verifyAccount(id, cloudType) {
  const verifier = accountVerifiers[cloudType];
  if (!verifier) throw new Error("当前云类型的账号验证尚未接入");
  return verifier(id);
}
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (await handleAccountRoutes(req, res, url, { accounts, saveAccount, database, decryptSecret, encryptSecret, verifyAccount })) return;
    if (await handleAssetRoutes(req, res, url, { database, localAssets, syncCloudAssets })) return;
    if (handleLogRoutes(req, res, url, { database })) return;
    if (await handleDomainRoutes(req, res, url, { rpc, arr, database, tencent, ctyunRequest, ctyunResources })) return;
    if (await handleOssRoutes(req, res, url, { ossAcl, ossDetail, ossSetPublicRead, ossSetCors, ossCnameMutation })) return;
    if (await handleResourceRoutes(req, res, url, { database, cloudResources, esaOverview })) return;
    if (await handleResourceDetailRoutes(req, res, url, { arr, database, oracleInstanceDisks, ossObjects, rpc, tencent })) return;
    if (await handleInstanceActionRoutes(req, res, url, { crypto, database, rpc, tencent, baidu, vultr, securityGroupRuleParams, aliyunSecurityGroupDetails, baiduSecurityGroupDetails, baiduSecurityGroupRuleInput, baiduBccAction, oracleInstanceAction, updateCachedServerName, lightFirewallDetails, lightFirewallRuleInput, jdcloudFirewallMutation, jdcloudInstanceAction })) return;
    if (await handleCloudSummaryRoute(req, res, url, { database, rpc, arr, cloudResources, tencent, volcResources, ctyunResources })) return;
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    const status = Number(error?.statusCode);
    return send(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 500, { error: String(error?.message || error) });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`CloudHub Tools Web API: http://127.0.0.1:${port}`),
);
