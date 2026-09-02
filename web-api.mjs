import http from "node:http";
import crypto from "node:crypto";
import { database, writeApiLog } from "./web-api/core/database.mjs";
import { decryptSecret, encryptSecret } from "./web-api/core/crypto.mjs";
import { readBody, send, sendError, sendUnsupportedInPreview } from "./web-api/core/http.mjs";
import { allowedWebOrigins, applyWebCors } from "./web-api/core/security.mjs";
import { handleAccountRoutes } from "./web-api/routes/accounts.mjs";
import { handleLocalRoutes } from "./web-api/routes/local.mjs";
import { listAccounts, deleteAccount, getAccountSecretRecord, getAccountType, getAccountRegion, getAccountTypeAndRegion, getAccountForUpdate, saveAccountRecord, importAccountRecords } from "./web-api/repositories/accounts.mjs";
import { listAssets, deleteAsset, updateServerName } from "./web-api/repositories/assets.mjs";
import { listApiLogs, clearApiLogs, clearOperationLogs } from "./web-api/repositories/logs.mjs";
import { rpc, rpcEncode, resources as aliyunRpcResources } from "./web-api/providers/aliyun-rpc.mjs";
import * as ctyunProvider from "./web-api/providers/ctyun.mjs";
import * as qiniuProvider from "./web-api/providers/qiniu.mjs";
import * as awsProvider from "./web-api/providers/aws.mjs";
import * as azureProvider from "./web-api/providers/azure.mjs";
import * as gcpProvider from "./web-api/providers/gcp.mjs";
import * as ucloudProvider from "./web-api/providers/ucloud.mjs";
import * as jdcloudProvider from "./web-api/providers/jdcloud.mjs";
import * as qingcloudProvider from "./web-api/providers/qingcloud.mjs";
import * as ksyunProvider from "./web-api/providers/ksyun.mjs";
import * as tencentProvider from "./web-api/providers/tencent.mjs";
import * as huaweiProvider from "./web-api/providers/huawei.mjs";
import * as volcengineProvider from "./web-api/providers/volcengine.mjs";
import * as oracleProvider from "./web-api/providers/oracle.mjs";
import * as baiduProvider from "./web-api/providers/baidu.mjs";
import * as aliyunOssProvider from "./web-api/providers/aliyun-oss.mjs";
import * as aliyunEsaProvider from "./web-api/providers/aliyun-esa.mjs";
import * as tencentCosProvider from "./web-api/providers/tencent-cos.mjs";
import * as vultrProvider from "./web-api/providers/vultr.mjs";
import { syncCloudAssets } from "./web-api/services/assets.mjs";
import { saveAccount as saveAccountService } from "./web-api/services/accounts.mjs";

function webApiPort(value) {
  const port = Number(value || 1430);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 1430;
}

const port = webApiPort(process.env.CLOUDHUB_TOOLS_WEB_API_PORT || process.env.ALIYUN_TOOLS_WEB_API_PORT);
const allowedOrigins = allowedWebOrigins();

function oracleMeta(row) {
  let meta = {};
  try { meta = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ }
  const tenancyOcid = String(meta.tenancy_ocid || "").trim();
  const fingerprint = String(meta.key_fingerprint || "").trim();
  if (!tenancyOcid || !fingerprint) throw new Error("OCI 账号缺少 Tenancy OCID 或 Key Fingerprint");
  return { tenancyOcid, fingerprint };
}
function normalizeOciPrivateKey(value) {
  let key = String(value || "").trim()
    .replace(/^OCI_API_KEY\s*=\s*/i, "")
    .replace(/^(["'])([\s\S]*)\1$/, "$2")
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\r\n?/g, "\n");
  key = key.replace(/^[ \t]*\\+(?=-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----)/gm, "");

  for (const type of ["PRIVATE KEY", "RSA PRIVATE KEY"]) {
    const begin = `-----BEGIN ${type}-----`;
    const end = `-----END ${type}-----`;
    const start = key.indexOf(begin);
    const finish = start < 0 ? -1 : key.indexOf(end, start + begin.length);
    if (start < 0 || finish < 0) continue;
    const body = key.slice(start + begin.length, finish).replace(/\s/g, "");
    if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return key;
    const lines = body.match(/.{1,64}/g)?.join("\n") || body;
    return `${begin}\n${lines}\n${end}`;
  }
  return key;
}
function serializeOciPrivateKey(value) {
  return normalizeOciPrivateKey(value).replace(/\n/g, "\\n");
}
function oracleEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
async function oracleRequest(accountId, host, requestPath, options = {}) { return oracleProvider.request(accountId, host, requestPath, options); }
async function oraclePages(accountId, host, pathName, query = {}) { return oracleProvider.pages(accountId, host, pathName, query); }
async function oracleInstanceAction(accountId, region, instanceId, action) {
  if (!region || !instanceId) throw new Error("缺少 OCI 地域或实例 ID");
  const actionName = { start: "START", stop: "STOP", reboot: "SOFTRESET", forceReboot: "RESET" }[action];
  if (!actionName) throw new Error("不支持的 OCI 实例操作");
  const host = `iaas.${region}.oci.oraclecloud.com`;
  return (await oracleRequest(accountId, host, `/20160918/instances/${oracleEncode(instanceId)}?action=${actionName}`, { method: "POST", body: "" })).data;
}
async function oracleInstanceDisks(accountId, region, instanceId, compartmentId) {
  if (!region || !instanceId || !compartmentId) return [];
  const host = `iaas.${region}.oci.oraclecloud.com`;
  const query = { compartmentId, instanceId };
  const [bootAttachments, volumeAttachments] = await Promise.all([
    oraclePages(accountId, host, "/20160918/bootVolumeAttachments", query).catch(() => []),
    oraclePages(accountId, host, "/20160918/volumeAttachments", query).catch(() => []),
  ]);
  const bootVolumes = await Promise.all(bootAttachments.map(async (attachment) => {
    if (!attachment.bootVolumeId) return null;
    try {
      const volume = (await oracleRequest(accountId, host, `/20160918/bootVolumes/${oracleEncode(attachment.bootVolumeId)}`)).data;
      return { DiskId: attachment.bootVolumeId, DiskName: volume.displayName || attachment.displayName || attachment.bootVolumeId, Category: "启动卷", Size: volume.sizeInGBs ?? 0, Status: volume.lifecycleState || attachment.lifecycleState || "", Device: attachment.device || "" };
    } catch { return null; }
  }));
  const volumes = await Promise.all(volumeAttachments.map(async (attachment) => {
    if (!attachment.volumeId) return null;
    try {
      const volume = (await oracleRequest(accountId, host, `/20160918/volumes/${oracleEncode(attachment.volumeId)}`)).data;
      return { DiskId: attachment.volumeId, DiskName: volume.displayName || attachment.displayName || attachment.volumeId, Category: "数据卷", Size: volume.sizeInGBs ?? 0, Status: volume.lifecycleState || attachment.lifecycleState || "", Device: attachment.device || "" };
    } catch { return null; }
  }));
  return [...bootVolumes, ...volumes].filter(Boolean);
}
async function oracleResources(accountId, type) { return oracleProvider.resources(accountId, type); }
function securityGroupRuleParams({ regionId, securityGroupId, ipProtocol, portRange, sourceCidrIp, policy = "accept", priority = 1, nicType = "" }) {
  const protocol = String(ipProtocol || "").trim().toLowerCase();
  const range = String(portRange || "").trim();
  const source = String(sourceCidrIp || "").trim();
  const [start, end, extra] = range.split("/");
  if (!regionId || !securityGroupId) throw new Error("缺少安全组地域或安全组 ID");
  if (!["tcp", "udp", "icmp", "gre", "all"].includes(protocol)) throw new Error("不支持的安全组协议");
  if (extra !== undefined || !/^-?\d+$/.test(start || "") || !/^-?\d+$/.test(end || "")) throw new Error("端口范围格式无效，请使用 80/80 或 8000/9000");
  if (!(["tcp", "udp"].includes(protocol) ? ((Number(start) === -1 && Number(end) === -1) || (Number(start) >= 1 && Number(end) >= Number(start) && Number(end) <= 65535)) : (Number(start) === -1 && Number(end) === -1))) throw new Error("端口范围与协议不匹配，请使用 80/80、8000/9000 或 -1/-1");
  if (!source || !source.includes("/")) throw new Error("来源地址必须是 CIDR，例如 0.0.0.0/0");
  if (!Number.isInteger(Number(priority)) || Number(priority) < 1 || Number(priority) > 100) throw new Error("安全组规则优先级必须在 1 到 100 之间");
  const params = { RegionId: regionId, SecurityGroupId: securityGroupId, IpProtocol: protocol, PortRange: range, SourceCidrIp: source, Policy: String(policy).toLowerCase() === "drop" ? "drop" : "accept", Priority: String(priority) };
  if (["internet", "intranet"].includes(String(nicType).toLowerCase())) params.NicType = String(nicType).toLowerCase();
  return params;
}

async function aliyunSecurityGroupDetails(id, regionId, instanceId, securityGroupId = "") {
  if (!regionId || !instanceId) throw new Error("缺少服务器地域或实例 ID");
  const instance = await rpc(id, `ecs.${regionId}.aliyuncs.com`, "2014-05-26", "DescribeInstanceAttribute", { RegionId: regionId, InstanceId: instanceId });
  const attachedGroupIds = arr(instance, ["SecurityGroupIds", "SecurityGroupId"]).map(String).filter(Boolean);
  const groupsResult = await rpc(id, `ecs.${regionId}.aliyuncs.com`, "2014-05-26", "DescribeSecurityGroups", { RegionId: regionId, PageSize: "100" });
  const groups = arr(groupsResult, ["SecurityGroups", "SecurityGroup"]).map((group) => ({ SecurityGroupId: String(group.SecurityGroupId || ""), SecurityGroupName: String(group.SecurityGroupName || ""), Description: String(group.Description || ""), VpcId: String(group.VpcId || ""), NicType: group.VpcId ? "intranet" : "internet" })).filter((group) => group.SecurityGroupId && (!attachedGroupIds.length || attachedGroupIds.includes(group.SecurityGroupId)));
  const selectedSecurityGroupId = groups.some((group) => group.SecurityGroupId === securityGroupId) ? securityGroupId : groups[0]?.SecurityGroupId || "";
  if (!selectedSecurityGroupId) return { groups, selectedSecurityGroupId, rules: [] };
  const detail = await rpc(id, `ecs.${regionId}.aliyuncs.com`, "2014-05-26", "DescribeSecurityGroupAttribute", { RegionId: regionId, SecurityGroupId: selectedSecurityGroupId });
  const rules = arr(detail, ["Permissions", "Permission"]).filter((rule) => String(rule.Direction || "").toLowerCase() === "ingress").map((rule) => ({ Direction: String(rule.Direction || ""), IpProtocol: String(rule.IpProtocol || ""), PortRange: String(rule.PortRange || ""), SourceCidrIp: String(rule.SourceCidrIp || ""), SourceGroupId: String(rule.SourceGroupId || ""), Policy: String(rule.Policy || "accept"), Priority: Number(rule.Priority || 1), Description: String(rule.Description || ""), NicType: String(rule.NicType || "") }));
  return { groups, selectedSecurityGroupId, rules };
}

function tencentSecurityGroupPolicy({ ipProtocol, portRange, sourceCidrIp, description = "" }) {
  const protocol = String(ipProtocol || "").trim().toLowerCase();
  const range = String(portRange || "").trim();
  const source = String(sourceCidrIp || "").trim();
  const [start, end, extra] = range.split("/");
  if (!["tcp", "udp", "icmp", "gre", "all"].includes(protocol)) throw new Error("不支持的安全组协议");
  if (extra !== undefined || !/^-?\d+$/.test(start || "") || !/^-?\d+$/.test(end || "")) throw new Error("端口范围格式无效，请使用 80/80 或 8000/9000");
  const validRange = ["tcp", "udp"].includes(protocol) ? ((Number(start) === -1 && Number(end) === -1) || (Number(start) >= 1 && Number(end) >= Number(start) && Number(end) <= 65535)) : Number(start) === -1 && Number(end) === -1;
  if (!validRange) throw new Error("端口范围与协议不匹配，请使用 80/80、8000/9000 或 -1/-1");
  if (!source || !source.includes("/")) throw new Error("来源地址必须是 CIDR，例如 0.0.0.0/0");
  const port = protocol === "all" ? "ALL" : start === end ? start : `${start}-${end}`;
  const policy = { Action: "ACCEPT", CidrBlock: source, Port: port, Protocol: protocol.toUpperCase() };
  if (String(description || "").trim()) policy.PolicyDescription = String(description).trim();
  return policy;
}

function tencentSecurityGroupPort(port) {
  const value = String(port || "");
  if (!value || value.toLowerCase() === "all") return "-1/-1";
  const [start, end] = value.split("-");
  return end === undefined ? `${start}/${start}` : `${start}/${end}`;
}

async function tencentSecurityGroupDetails(id, regionId, instanceId, securityGroupId = "") {
  if (!regionId || !instanceId) throw new Error("缺少服务器地域或实例 ID");
  const instanceData = await tencentRequest(id, "cvm", "2017-03-12", "DescribeInstances", { InstanceIds: [instanceId] }, regionId);
  const attachedGroupIds = arr(instanceData, ["InstanceSet"])[0]?.SecurityGroupIds || [];
  const groupsData = await tencentRequest(id, "cvm", "2017-03-12", "DescribeSecurityGroups", { Limit: 100 }, regionId);
  const groups = arr(groupsData, ["SecurityGroupSet"]).map((group) => ({ SecurityGroupId: String(group.SecurityGroupId || ""), SecurityGroupName: String(group.SecurityGroupName || ""), Description: String(group.SecurityGroupDesc || ""), VpcId: String(group.VpcId || ""), NicType: "" })).filter((group) => group.SecurityGroupId && (!attachedGroupIds.length || attachedGroupIds.includes(group.SecurityGroupId)));
  const selectedSecurityGroupId = groups.some((group) => group.SecurityGroupId === securityGroupId) ? securityGroupId : groups[0]?.SecurityGroupId || "";
  if (!selectedSecurityGroupId) return { groups, selectedSecurityGroupId, rules: [] };
  const policies = await tencentRequest(id, "cvm", "2017-03-12", "DescribeSecurityGroupPolicies", { SecurityGroupId: selectedSecurityGroupId }, regionId);
  const rules = arr(policies, ["SecurityGroupPolicySet", "Ingress"]).map((rule) => ({ Direction: "ingress", IpProtocol: String(rule.Protocol || "").toLowerCase(), PortRange: tencentSecurityGroupPort(rule.Port), SourceCidrIp: String(rule.CidrBlock || ""), SourceGroupId: String(rule.SecurityGroupId || ""), Policy: String(rule.Action || "ACCEPT"), Priority: Number(rule.PolicyIndex || 0), Description: String(rule.PolicyDescription || ""), NicType: "" }));
  return { groups, selectedSecurityGroupId, rules };
}

function baiduSecurityGroupPort(portRange) {
  const value = String(portRange || "").trim();
  if (!value) return "-1/-1";
  const [start, end] = value.split("-");
  return end === undefined ? `${start}/${start}` : `${start}/${end}`;
}

function baiduSecurityGroupRuleInput({ ipProtocol, portRange, sourceCidrIp, description = "" }) {
  const protocol = String(ipProtocol || "").trim().toLowerCase();
  const range = String(portRange || "").trim();
  const sourceIp = String(sourceCidrIp || "").trim();
  const [startText, endText, extra] = range.split("/");
  const start = Number(startText);
  const end = Number(endText);
  if (!["tcp", "udp"].includes(protocol)) throw new Error("百度云安全组端口仅支持 TCP 或 UDP");
  if (extra !== undefined || !/^\d+$/.test(startText || "") || !/^\d+$/.test(endText || "") || start < 1 || end < start || end > 65535) throw new Error("端口范围必须为 1 到 65535 之间的 80/80 或 8000/9000");
  if (!sourceIp || !sourceIp.includes("/")) throw new Error("来源地址必须是 CIDR，例如 0.0.0.0/0");
  const rule = { direction: "ingress", ethertype: "IPv4", portRange: `${start}-${end}`, protocol, sourceIp };
  if (String(description || "").trim()) rule.remark = String(description).trim();
  return rule;
}

async function baiduSecurityGroupDetails(id, regionId, instanceId, securityGroupId = "") {
  if (!regionId || !instanceId) throw new Error("缺少服务器地域或实例 ID");
  const host = `bcc.${regionId}.baidubce.com`;
  const { data } = await baiduRequest(id, host, "/v2/securityGroup", { instanceId, maxKeys: 1000 });
  const groups = arr(data, ["securityGroups"]).map((group) => ({ SecurityGroupId: String(group.id || ""), SecurityGroupName: String(group.name || ""), Description: String(group.desc || ""), VpcId: String(group.vpcId || ""), NicType: "" }));
  const selectedSecurityGroupId = groups.some((group) => group.SecurityGroupId === securityGroupId) ? securityGroupId : groups[0]?.SecurityGroupId || "";
  if (!selectedSecurityGroupId) return { groups, selectedSecurityGroupId, rules: [] };
  const { data: detail } = await baiduRequest(id, host, `/v2/securityGroup/${encodeURIComponent(selectedSecurityGroupId)}`);
  const rules = arr(detail, ["rules"]).filter((rule) => String(rule.direction || "").toLowerCase() === "ingress").map((rule) => ({ Direction: String(rule.direction || "ingress"), IpProtocol: String(rule.protocol || ""), PortRange: baiduSecurityGroupPort(rule.portRange), SourceCidrIp: String(rule.sourceIp || ""), SourceGroupId: String(rule.sourceGroupId || ""), Policy: "accept", Priority: 0, Description: String(rule.remark || ""), NicType: "", SecurityGroupRuleId: String(rule.securityGroupRuleId || "") }));
  return { groups, selectedSecurityGroupId, rules, sgVersion: detail.sgVersion };
}

function lightFirewallRuleInput({ ipProtocol, portRange, sourceCidrIp, description = "" }) {
  const protocol = String(ipProtocol || "").trim().toLowerCase();
  const range = String(portRange || "").trim();
  const source = String(sourceCidrIp || "").trim();
  const [startText, endText, extra] = range.split("/");
  const start = Number(startText);
  const end = Number(endText);
  if (!["tcp", "udp"].includes(protocol)) throw new Error("轻量服务器仅支持 TCP 或 UDP 端口规则");
  if (extra !== undefined || !/^\d+$/.test(startText || "") || !/^\d+$/.test(endText || "") || start < 1 || end < start || end > 65535) throw new Error("端口范围必须为 1 到 65535 之间的 80/80 或 8000/9000");
  if (!source || !source.includes("/")) throw new Error("来源地址必须是 CIDR，例如 0.0.0.0/0");
  return { protocol, portRange: range, sourceCidrIp: source, description: String(description || "").trim() };
}

function tencentLighthousePort(port) {
  const value = String(port || "").trim();
  if (!value || value.toLowerCase() === "all") return "-1/-1";
  const [start, end] = value.split("-");
  return end === undefined ? `${start}/${start}` : `${start}/${end}`;
}

async function lightFirewallDetails(id, regionId, instanceId) {
  if (!regionId || !instanceId) throw new Error("缺少轻量服务器地域或实例 ID");
  const account = getAccountType(id);
  if (!account) throw new Error("云账号不存在");
  if (account.cloud_type === "aliyun") {
    const data = await rpc(id, `swas.${regionId}.aliyuncs.com`, "2020-06-01", "ListFirewallRules", { RegionId: regionId, InstanceId: instanceId, PageNumber: "1", PageSize: "100" });
    const firewallRules = Array.isArray(data.FirewallRules) ? data.FirewallRules : arr(data, ["FirewallRules", "FirewallRule"]);
    return { rules: firewallRules.filter((rule) => String(rule.Policy || "accept").toLowerCase() === "accept").map((rule) => ({ RuleId: String(rule.RuleId || ""), IpProtocol: String(rule.RuleProtocol || ""), PortRange: String(rule.Port || ""), SourceCidrIp: String(rule.SourceCidrIp || ""), Policy: String(rule.Policy || "accept"), Description: String(rule.Remark || "") })) };
  }
  if (account.cloud_type === "tencent") {
    const data = await tencentRequest(id, "lighthouse", "2020-03-24", "DescribeFirewallRules", { InstanceId: instanceId, Limit: 100 }, regionId);
    return { rules: arr(data, ["FirewallRuleSet"]).filter((rule) => String(rule.Action || "ACCEPT").toUpperCase() === "ACCEPT").map((rule) => {
      const firewallRule = { Protocol: String(rule.Protocol || ""), Port: String(rule.Port || ""), CidrBlock: String(rule.CidrBlock || ""), Action: String(rule.Action || "ACCEPT"), FirewallRuleDescription: String(rule.FirewallRuleDescription || "") };
      return { RuleId: "", IpProtocol: firewallRule.Protocol, PortRange: tencentLighthousePort(firewallRule.Port), SourceCidrIp: firewallRule.CidrBlock, Policy: firewallRule.Action, Description: firewallRule.FirewallRuleDescription, FirewallRule: firewallRule };
    }), firewallVersion: data.FirewallVersion };
  }
  if (account.cloud_type === "jdcloud") {
    const data = await jdcloudRequest(id, "lavm", regionId, `/v1/regions/${encodeURIComponent(regionId)}/firewallRule`, { instanceId, pageSize: 100, pageNumber: 1 });
    return { rules: arr(data?.result, ["firewallRules"]).map((rule) => ({ RuleId: String(rule.ruleId || ""), IpProtocol: String(rule.ruleProtocol || ""), PortRange: String(rule.port || ""), SourceCidrIp: String(rule.sourceAddress || ""), Policy: "accept", Description: String(rule.remark || "") })) };
  }
  throw new Error("当前云类型暂不支持轻量服务器防火墙管理");
}
async function tencentRequest(accountId, service, version, action, payload = {}, region = "") {
  return tencentProvider.request(accountId, service, version, action, payload, region);
}
async function tencentResources(accountId, type) { return tencentProvider.resources(accountId, type); }
async function ctyunRequest(accountId, endpoint, method, requestPath, payload = null, query = {}, extraHeaders = {}) {
  return ctyunProvider.request(accountId, endpoint, method, requestPath, payload, query, extraHeaders);
}
async function ctyunResources(id, type) { return ctyunProvider.resources(id, type); }
async function verifyCtyunAccount(id) { return ctyunProvider.verify(id); }
async function huaweiResources(accountId, type) { return huaweiProvider.resources(accountId, type); }
async function verifyHuaweiAccount(id) { return huaweiProvider.verify(id); }
async function baiduRequest(accountId, host, pathname, query = {}, options = {}) { return baiduProvider.request(accountId, host, pathname, query, options); }
async function baiduBccAction(accountId, region, instanceId, action, forceStop = false) { return baiduProvider.bccAction(accountId, region, instanceId, action, forceStop); }
async function baiduResources(accountId, type) { return baiduProvider.resources(accountId, type); }
async function verifyBaiduAccount(id) { return baiduProvider.verify(id); }
function configuredRegions(accountId, fallback) {
  const account = getAccountRegion(accountId);
  const values = String(account?.region_id || fallback).split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean);
  return [...new Set(values.length ? values : [fallback])];
}
async function ucloudResources(accountId, type) {
  return ucloudProvider.resources(accountId, type, configuredRegions(accountId, "cn-bj2"));
}
async function verifyUcloudAccount(id) {
  return ucloudProvider.verify(id, configuredRegions(id, "cn-bj2"));
}
async function qiniuResources(accountId, type) {
  return qiniuProvider.resources(accountId, type);
}
async function verifyQiniuAccount(id) {
  return qiniuProvider.verify(id, configuredRegions(id, "z0"));
}
async function awsResources(accountId, type) { return awsProvider.resources(accountId, type, configuredRegions(accountId, "ap-northeast-1")); }
async function verifyAwsAccount(id) { return awsProvider.verify(id, configuredRegions(id, "ap-northeast-1")); }
function azureMeta(row) { return azureProvider.meta(row); }
async function azureResources(accountId, type) { return azureProvider.resources(accountId, type); }
async function verifyAzureAccount(id) { return azureProvider.verify(id, configuredRegions(id, "eastasia")); }
function gcpMeta(row) { return gcpProvider.meta(row); }
async function gcpResources(accountId, type) { return gcpProvider.resources(accountId, type); }
async function verifyGcpAccount(id) { return gcpProvider.verify(id, configuredRegions(id, "asia-east1")); }
async function jdcloudInstanceAction(accountId, region, instanceId, action) {
  return jdcloudProvider.mutate(accountId, region, "POST", `/v1/regions/${encodeURIComponent(region)}/instances/${encodeURIComponent(instanceId)}:${action}`, null);
}
async function jdcloudFirewallMutation(accountId, region, method, pathname, payload) {
  return jdcloudProvider.mutate(accountId, region, method, pathname, payload);
}
 async function jdcloudResources(accountId, type) { return jdcloudProvider.resources(accountId, type, configuredRegions(accountId, "cn-north-1")); }
 async function verifyJdcloudAccount(id) { return jdcloudProvider.verify(id, configuredRegions(id, "cn-north-1")); }
async function qingcloudResources(accountId, type) {
  return qingcloudProvider.resources(accountId, type, configuredRegions(accountId, "pek3a"));
}
async function verifyQingcloudAccount(id) {
  return qingcloudProvider.verify(id, configuredRegions(id, "pek3a"));
}
async function ksyunResources(accountId, type) { return ksyunProvider.resources(accountId, type, configuredRegions(accountId, "cn_beijing_6")); }
async function verifyKsyunAccount(id) { return ksyunProvider.verify(id, configuredRegions(id, "cn_beijing_6")); }
async function volcRequest(accountId, service, version, action, params = {}, region = "cn-beijing") { return volcengineProvider.request(accountId, service, version, action, params, region); }
async function volcJsonRequest(accountId, service, version, action, payload = {}, region = "cn-beijing") { return volcengineProvider.jsonRequest(accountId, service, version, action, payload, region); }
async function volcResources(id, type) {
  return volcengineProvider.resources(id, type);
}
function arr(data, path) {
  let value = data;
  for (const key of path) value = value?.[key];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
function tencentNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
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
async function cosObjects(id, bucket, location, options = {}) { return tencentCosProvider.objects(id, bucket, location, options); }
async function cosAcl(id, bucket, location) { return tencentCosProvider.acl(id, bucket, location); }
async function cosDetail(id, bucket, location) { return tencentCosProvider.detail(id, bucket, location); }
function bucketEndpoint(name, endpoint, location, internal = false) {
  const fallback = `${location}${internal ? "-internal" : ""}.aliyuncs.com`;
  const value = String(endpoint || fallback).replace(/^https?:\/\//, "").replace(/\/$/, "");
  return value === name || value.startsWith(`${name}.`) ? value : `${name}.${value}`;
}
async function ossRequest(id, bucket, location, options = {}) { return aliyunOssProvider.request(id, bucket, location, options); }
async function ossObjects(id, bucket, location, { prefix = "", marker = "" } = {}) {
  const account = getAccountType(id);
  if (account?.cloud_type === "tencent") return cosObjects(id, bucket, location, { prefix, marker });
  return aliyunOssProvider.objects(id, bucket, location, { prefix, marker });
}
async function ossAcl(id, bucket, location) {
  const account = getAccountType(id);
  if (account?.cloud_type === "tencent") return cosAcl(id, bucket, location);
  return aliyunOssProvider.acl(id, bucket, location);
}
async function ossStat(id, bucket, location) {
  return aliyunOssProvider.stat(id, bucket, location);
}
async function ossCnames(id, bucket, location) {
  return aliyunOssProvider.cnames(id, bucket, location);
}
async function ossCors(id, bucket, location) {
  return aliyunOssProvider.cors(id, bucket, location);
}
function metricTotal(data) {
  const points = typeof data?.Datapoints === "string" ? JSON.parse(data.Datapoints || "[]") : data?.Datapoints || [];
  return Array.isArray(points) ? points.reduce((sum, point) => sum + Number(point?.Value || 0), 0) : 0;
}
async function ossMonthMetrics(id, bucket) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const end = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const params = { Namespace: "acs_oss_dashboard", Dimensions: JSON.stringify({ BucketName: bucket }), StartTime: start, EndTime: end, Period: "3600" };
  const [traffic, get, put] = await Promise.all([
    rpc(id, "metrics.aliyuncs.com", "2019-01-01", "DescribeMetricList", { ...params, MetricName: "MeteringInternetTX" }),
    rpc(id, "metrics.aliyuncs.com", "2019-01-01", "DescribeMetricList", { ...params, MetricName: "MeteringGetRequest" }),
    rpc(id, "metrics.aliyuncs.com", "2019-01-01", "DescribeMetricList", { ...params, MetricName: "MeteringPutRequest" }),
  ]);
  return { monthTraffic: metricTotal(traffic), monthRequests: metricTotal(get) + metricTotal(put) };
}
async function ossDetail(id, bucket, location) {
  const account = getAccountType(id);
  if (account?.cloud_type === "tencent") return cosDetail(id, bucket, location);
  const [stat, cnames, acl, cors, metrics] = await Promise.allSettled([ossStat(id, bucket, location), ossCnames(id, bucket, location), ossAcl(id, bucket, location), ossCors(id, bucket, location), ossMonthMetrics(id, bucket)]);
  const errors = [stat, cnames, acl, cors]
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason?.message || result.reason))
    .filter((message) => !message.includes("The CORS Configuration does not exist"));
  const values = (result, fallback) => result.status === "fulfilled" ? result.value : fallback;
  const summary = values(stat, {});
  return { storage: Number(summary.Storage || 0), objectCount: Number(summary.ObjectCount || 0), multipartUploadCount: Number(summary.MultipartUploadCount || 0), liveChannelCount: Number(summary.LiveChannelCount || 0), monthTraffic: values(metrics, {}).monthTraffic || 0, monthRequests: values(metrics, {}).monthRequests || 0, acl: values(acl, "private"), cnames: values(cnames, []), cors: values(cors, []), errors };
}
async function ossSetPublicRead(id, bucket, location) {
  await ossRequest(id, bucket, location, { method: "PUT", query: "acl", resource: `/${bucket}/?acl`, headers: { "x-oss-acl": "public-read", "Content-Length": "0" } });
}
async function ossSetCors(id, bucket, location, origins) {
  const safeOrigin = String(origins || "*").replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
  const body = `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule><AllowedOrigin>${safeOrigin}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>DELETE</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
  await ossRequest(id, bucket, location, { method: "PUT", query: "cors", resource: `/${bucket}/?cors`, body, contentType: "application/xml" });
}
function validCname(domain) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain);
}
async function ossCnameMutation(id, bucket, location, operation, domain) {
  const value = String(domain || "").trim().toLowerCase();
  if (!validCname(value)) throw new Error("请输入有效的完整域名，例如 img.example.com");
  const component = operation === "token" ? "token" : operation === "bind" ? "add" : "delete";
  const query = `cname&comp=${component}`;
  const body = `<BucketCnameConfiguration><Cname><Domain>${value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character])}</Domain></Cname></BucketCnameConfiguration>`;
  const xml = await ossRequest(id, bucket, location, { method: "POST", query, resource: `/${bucket}/?${query}`, body, contentType: "application/xml" });
  return { domain: value, token: xmlText(xml, "Token"), cname: xmlText(xml, "Cname"), expireTime: xmlText(xml, "ExpireTime") };
}
function vultrFirewallRuleInput(payload) {
  const protocol = String(payload.ipProtocol || "").trim().toLowerCase();
  if (!["tcp", "udp"].includes(protocol)) throw new Error("Vultr 防火墙端口仅支持 TCP 或 UDP");
  const port = String(payload.port || "").trim();
  if (!/^\d+(?:-\d+)?$/.test(port)) throw new Error("端口格式无效，请使用 80 或 8000-9000");
  const [start, end = start] = port.split("-").map(Number);
  if (start < 1 || end < start || end > 65535) throw new Error("端口范围必须在 1 到 65535 之间");
  const parts = String(payload.sourceCidrIp || "").trim().split("/");
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw new Error("来源地址必须是 IPv4 CIDR，例如 0.0.0.0/0");
  const octets = parts[0].split(".");
  const subnetSize = Number(parts[1]);
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet) || Number(octet) > 255) || subnetSize > 32) throw new Error("来源地址必须是有效 IPv4 CIDR，例如 0.0.0.0/0");
  const rule = { ip_type: "v4", protocol, subnet: parts[0], subnet_size: subnetSize, port };
  const notes = String(payload.description || "").trim();
  if (notes) rule.notes = notes;
  return rule;
}
function vultrFirewallRules(data) {
  const values = Array.isArray(data?.firewall_rules) ? data.firewall_rules : [];
  return values.filter((rule) => !rule?.ip_type || rule.ip_type === "v4").map((rule) => ({
    RuleId: vultrValue(rule, "id"),
    IpProtocol: vultrValue(rule, "protocol"),
    PortRange: vultrValue(rule, "port"),
    SourceCidrIp: vultrValue(rule, "source") || (rule?.subnet_size !== undefined && rule?.subnet_size !== null ? `${vultrValue(rule, "subnet")}/${rule.subnet_size}` : vultrValue(rule, "subnet")),
    Description: vultrValue(rule, "notes"),
  }));
}
async function vultrRequest(accountId, pathName, query = {}, init = {}) { return vultrProvider.request(accountId, pathName, query, init); }
async function vultrPages(accountId, pathName, itemKey) { return vultrProvider.pages(accountId, pathName, itemKey); }
function vultrValue(item, ...keys) { return keys.map((key) => item?.[key]).find((value) => value !== undefined && value !== null && value !== "") ?? ""; }
async function vultrResources(accountId, type) {
  return vultrProvider.resources(accountId, type);
}
async function verifyVultrAccount(id) {
  const [account, regions] = await Promise.all([vultrRequest(id, "account"), vultrPages(id, "regions", "regions")]);
  const ids = regions.map((region) => String(region.id || "")).filter(Boolean);
  return { provider: "vultr", verified: true, region_count: ids.length, regions: ids, default_region: ids[0] || "ewr", account: account.account || account };
}
async function cloudResources(id, type) {
  const account = getAccountType(id);
  if (!account) throw new Error("云账号不存在");
  if (account.cloud_type === "vultr") return vultrResources(id, type);
  if (account.cloud_type === "tencent") return tencentResources(id, type);
  if (account.cloud_type === "volcengine") return volcResources(id, type);
  if (account.cloud_type === "ctyun") return ctyunResources(id, type);
  if (account.cloud_type === "huawei") return huaweiResources(id, type);
  if (account.cloud_type === "baidu") return baiduResources(id, type);
  if (account.cloud_type === "ucloud") return ucloudResources(id, type);
  if (account.cloud_type === "qiniu") return qiniuResources(id, type);
  if (account.cloud_type === "aws") return awsResources(id, type);
  if (account.cloud_type === "azure") return azureResources(id, type);
  if (account.cloud_type === "gcp") return gcpResources(id, type);
  if (account.cloud_type === "jdcloud") return jdcloudResources(id, type);
  if (account.cloud_type === "qingcloud") return qingcloudResources(id, type);
  if (account.cloud_type === "ksyun") return ksyunResources(id, type);
  if (account.cloud_type === "oracle") return oracleResources(id, type);
  if (account.cloud_type === "aliyun" && ["domain", "ecs", "swas", "rds", "redis"].includes(type)) return aliyunRpcResources(id, type);
  const items = [];
  const errors = [];
  if (type === "oss") {
    let token = "";
    let page = 0;
    do {
      const query = new URLSearchParams({ "max-keys": "1000" });
      if (token) query.set("continuation-token", token);
      const xml = await ossRequest(id, "", "", { query: query.toString(), resource: "/" });
      for (const block of xmlBlocks(xml, "Bucket")) {
        const name = xmlText(block, "Name");
        const location = xmlText(block, "Location");
        if (!name || !location) continue;
        items.push({
          Name: name,
          Location: location,
          CreationDate: xmlText(block, "CreationDate"),
          StorageClass: xmlText(block, "StorageClass") || "Standard",
          ExtranetEndpoint: bucketEndpoint(name, xmlText(block, "ExtranetEndpoint"), location),
          IntranetEndpoint: bucketEndpoint(name, xmlText(block, "IntranetEndpoint"), location, true),
          Acl: xmlText(block, "Acl") || "private",
        });
      }
      token = xmlText(xml, "NextContinuationToken");
      page += 1;
      if (xmlText(xml, "IsTruncated").toLowerCase() !== "true") token = "";
    } while (token && page < 100);
    return {
      resource_type: type,
      items,
      errors: token ? ["OSS 存储桶分页超过 100 页，已停止读取"] : errors,
      fetched_at: Date.now(),
    };
  }
  if (type === "ecs" || type === "swas") {
    const regionIds = type === "ecs" ? await regions(id) : ["cn-hangzhou", "cn-shanghai", "cn-beijing", "cn-shenzhen", "cn-hongkong", "ap-southeast-1"];
    for (const regionId of regionIds) {
      try {
        const data = type === "ecs"
          ? await rpc(id, `ecs.${regionId}.aliyuncs.com`, "2014-05-26", "DescribeInstances", { RegionId: regionId, PageSize: "100" })
          : await rpc(id, `swas.${regionId}.aliyuncs.com`, "2020-06-01", "ListInstances", { RegionId: regionId, PageSize: "100" });
        const path = type === "ecs" ? ["Instances", "Instance"] : ["Instances"];
        for (const item of arr(data, path)) items.push({ ...item, _region_id: regionId });
      } catch (error) { errors.push(`${regionId}: ${error.message}`); }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  if (type === "rds" || type === "redis") {
    for (const regionId of await regions(id)) {
      try {
        const endpoint =
          type === "rds" ? "rds.aliyuncs.com" : "r-kvstore.aliyuncs.com";
        const version = type === "rds" ? "2014-08-15" : "2015-01-01";
        const action =
          type === "rds" ? "DescribeDBInstances" : "DescribeInstances";
        const data = await rpc(id, endpoint, version, action, {
          RegionId: regionId,
          PageSize: "100",
        });
        const path =
          type === "rds"
            ? ["Items", "DBInstance"]
            : ["Instances", "KVStoreInstance"];
        for (const item of arr(data, path))
          items.push({ ...item, _region_id: regionId });
      } catch (error) {
        errors.push(`${regionId}: ${error.message}`);
      }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }
  if (type === "esa") {
    try {
      const data = await esaRequest(id, "ListSites", { PageNumber: "1", PageSize: "100" });
      return {
        resource_type: type,
        items: arr(data, ["Sites"]),
        errors: [],
        fetched_at: Date.now(),
      };
    } catch (error) {
      return {
        resource_type: type,
        items: [],
        errors: [error.message],
        fetched_at: Date.now(),
      };
    }
  }
  return {
    resource_type: type,
    items: [],
    errors: [`Web 预览暂未接入 ${type} API`],
    fetched_at: Date.now(),
  };
}

async function esaRequest(id, action, params = {}, method = "GET") { return aliyunEsaProvider.request(id, action, params, method); }

function esaRange(range) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start = today;
  let end = now;
  let label = "今日";
  if (range === "yesterday") {
    start = new Date(today); start.setDate(start.getDate() - 1); end = today; label = "昨日";
  } else if (range === "week") {
    start = new Date(today); start.setDate(start.getDate() - 6); label = "近 7 日";
  } else if (range === "month") {
    start = new Date(today); start.setDate(start.getDate() - 29); label = "近 30 日";
  }
  return { start, end, label, interval: range === "week" || range === "month" ? "86400" : "3600" };
}

function esaDetails(data, fieldName) {
  const row = arr(data, ["Data"]).find((item) => item.FieldName === fieldName);
  return row ? arr(row, ["DetailData"]) : [];
}

async function esaOverview(id, range = "today", siteId = "") {
  const account = getAccountType(id);
  if (account?.cloud_type === "tencent" || account?.cloud_type === "volcengine") {
    const zones = account.cloud_type === "tencent" ? await tencentResources(id, "esa") : await volcResources(id, "esa");
    const sites = zones.items;
    return {
      traffic: 0, requests: 0, defence_requests: 0, site_count: sites.length,
      active_count: sites.filter((site) => String(site.Status || "").toLowerCase() === "active").length,
      range_label: esaRange(["today", "yesterday", "week", "month"].includes(range) ? range : "today").label,
      trend: { traffic: [], requests: [], page_view: [] },
      site_options: sites.map((site) => ({ id: String(site.SiteId || ""), name: String(site.SiteName || site.DomainName || site.SiteId || "") })),
    };
  }
  const sitesResult = await esaRequest(id, "ListSites", { SiteSearchType: "fuzzy", SiteName: "", PageNumber: "1", PageSize: "100" });
  const sites = arr(sitesResult, ["Sites"]);
  const period = esaRange(["today", "yesterday", "week", "month"].includes(range) ? range : "today");
  const fields = JSON.stringify([
    { FieldName: "Requests", Dimension: ["ALL"] },
    { FieldName: "Traffic", Dimension: ["ALL"] },
    { FieldName: "PageView", Dimension: ["ALL"] },
  ]);
  const base = {
    StartTime: period.start.toISOString().replace(/\.\d{3}Z$/, "Z"),
    EndTime: period.end.toISOString().replace(/\.\d{3}Z$/, "Z"),
    Interval: period.interval,
  };
  const siteParam = siteId ? { SiteId: siteId } : {};
  const [top, defence, trend] = await Promise.all([
    esaRequest(id, "DescribeSiteTopData", { ...base, AnalysisType: "1", Fields: fields, ...siteParam }, "POST"),
    esaRequest(id, "DescribeSiteStatisticsData", {
      ...base,
      Fields: JSON.stringify([{ FieldName: "Requests", Dimension: ["ALL"] }]),
      Filter: JSON.stringify({ where: { and: [[{ key: "MitigationType", operator: "in", value: ["WafMitigated"] }]] } }),
      ...siteParam,
    }, "POST"),
    esaRequest(id, "DescribeSiteStatisticsData", { ...base, Fields: fields, ...siteParam }, "POST"),
  ]);
  const toNumber = (value) => Number(value || 0) || 0;
  const trendMap = { traffic: [], requests: [], page_view: [] };
  for (const [fieldName, key] of [["Traffic", "traffic"], ["Requests", "requests"], ["PageView", "page_view"]]) {
    trendMap[key] = esaDetails(trend, fieldName).map((detail) => ({
      time: detail.Time || detail.Timestamp || detail.TimeStamp || detail.Date || "",
      value: toNumber(detail.Value),
    }));
  }
  return {
    traffic: toNumber(esaDetails(top, "Traffic")[0]?.Value),
    requests: toNumber(esaDetails(top, "Requests")[0]?.Value),
    defence_requests: toNumber(esaDetails(defence, "Requests")[0]?.Value),
    site_count: Number(sitesResult.TotalCount || sites.length),
    active_count: sites.filter((site) => String(site.Status || "").toLowerCase() === "active").length,
    range_label: period.label,
    trend: trendMap,
    site_options: sites.map((site) => ({ id: String(site.SiteId || ""), name: String(site.SiteName || site.DomainName || site.SiteId || "") })),
  };
}
function saveAccount(input) {
  return saveAccountService(input, { accountRepository: { getAccountForUpdate, saveAccountRecord }, encryptSecret, serializeOciPrivateKey, validateOracleMeta: oracleMeta, validateAzureMeta: azureMeta, validateGcpMeta: gcpMeta });
}
async function jdcloudRequest(accountId, service, region, pathname, query = {}) { return jdcloudProvider.request(accountId, service, region, pathname, query); }
const server = http.createServer(async (req, res) => {
  const originPolicy = applyWebCors(req, res, allowedOrigins);
  if (!originPolicy.allowed) {
    return sendError(res, 403, "forbidden-origin", "请求来源不受 CloudHub Tools Web API 信任");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (await handleAccountRoutes(req, res, url, { accounts: listAccounts, saveAccount, deleteAccount })) return;
    if (handleLocalRoutes(req, res, url, { listAssets, deleteAsset, listApiLogs, clearApiLogs, clearOperationLogs })) return;
    if (req.method === "POST" && url.pathname === "/api/sync-assets") {
      const payload = JSON.parse(await readBody(req));
      return send(res, 200, await syncCloudAssets(Number(payload.account_id), Array.isArray(payload.resource_types) ? payload.resource_types : [], { database, cloudResources }));
    }
    if (req.method === "POST" && url.pathname === "/api/verify-account") {
      try {
        const payload = JSON.parse(await readBody(req));
        const id = Number(payload.account_id);
        if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: "账号 ID 无效" });
        const account = getAccountType(id);
        if (!account) return send(res, 404, { error: "云账号不存在" });
        if (account.cloud_type === "vultr") return send(res, 200, await verifyVultrAccount(id));
        if (account.cloud_type === "ctyun") return send(res, 200, await verifyCtyunAccount(id));
        if (account.cloud_type === "huawei") return send(res, 200, await verifyHuaweiAccount(id));
        if (account.cloud_type === "baidu") return send(res, 200, await verifyBaiduAccount(id));
        if (account.cloud_type === "ucloud") return send(res, 200, await verifyUcloudAccount(id));
        if (account.cloud_type === "qiniu") return send(res, 200, await verifyQiniuAccount(id));
        if (account.cloud_type === "aws") return send(res, 200, await verifyAwsAccount(id));
        if (account.cloud_type === "azure") return send(res, 200, await verifyAzureAccount(id));
        if (account.cloud_type === "gcp") return send(res, 200, await verifyGcpAccount(id));
        if (account.cloud_type === "jdcloud") return send(res, 200, await verifyJdcloudAccount(id));
        if (account.cloud_type === "qingcloud") return send(res, 200, await verifyQingcloudAccount(id));
        if (account.cloud_type === "ksyun") return send(res, 200, await verifyKsyunAccount(id));
        return send(res, 400, { error: "当前云类型的账号验证尚未接入" });
      } catch (error) { return send(res, 400, { error: error.message || "天翼云账号验证失败" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/export") {
      return sendUnsupportedInPreview(res, "导出账号密钥", "请在桌面端导出并妥善保管文件");
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      const payload = JSON.parse(await readBody(req));
      const incoming = Array.isArray(payload) ? payload : payload.accounts;
      if (!Array.isArray(incoming))
        return send(res, 400, { error: "文件格式无效，需要 accounts 数组" });
      if (!incoming.length) return send(res, 400, { error: "导入文件中没有云账号" });
      const invalidIndex = incoming.findIndex((item) => !item?.account_name || !item?.access_key_id || !item?.access_key_secret);
      if (invalidIndex >= 0) return send(res, 400, { error: `第 ${invalidIndex + 1} 条账号缺少完整密钥信息` });
      const imported = importAccountRecords(incoming.map((item) => ({
        account_name: item.account_name,
        cloud_type: item.cloud_type || "aliyun",
        group_name: item.group_name || null,
        access_key_id: item.access_key_id,
        secret: encryptSecret(item.access_key_secret),
        credential_meta: ["oracle", "azure", "gcp"].includes(item.cloud_type) ? item.credential_meta || null : null,
        region_id: item.region_id || null,
        sort_order: Math.max(0, Number(item.sort_order) || 0),
        enabled: item.enabled === false ? 0 : 1,
        remark: item.remark || null,
      })));
      return send(res, 200, { imported });
    }
    if (req.method === "GET" && url.pathname === "/api/dns-records") {
      const type = url.searchParams.get("type") || "";
      const keyword = url.searchParams.get("keyword") || "";
      const page = url.searchParams.get("page") || "1";
      const pageSize = url.searchParams.get("pageSize") || "20";
      const id = Number(url.searchParams.get("id"));
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const limit = Math.min(100, Math.max(1, Number(pageSize) || 20));
        const data = await tencentRequest(id, "dnspod", "2021-03-23", "DescribeRecordList", {
          Domain: url.searchParams.get("domain") || "",
          Offset: Math.max(0, (Number(page) - 1) * limit),
          Limit: limit,
          ...(type ? { RecordType: type } : {}),
          ...(keyword ? { Keyword: keyword } : {}),
        });
        const items = arr(data, ["RecordList"]).map((item) => ({
          ...item,
          RecordId: item.RecordId,
          RR: item.Name || "@",
          Type: item.Type,
          Value: item.Value,
          TTL: item.TTL,
          Priority: item.MX || item.Priority,
          Line: item.Line || "默认",
          Status: item.Status,
        }));
        return send(res, 200, { items, total: tencentNumber(data.RecordCountInfo?.TotalCount || data.TotalCount) });
      }
      if (account.cloud_type === "ctyun") {
        const region = String(getAccountRegion(id)?.region_id || "cn-huabei-9");
        const zones = await ctyunResources(id, "domain");
        const zone = zones.items.find((item) => String(item.DomainName || "").toLowerCase() === String(url.searchParams.get("domain") || "").toLowerCase());
        if (!zone?.ZoneId) return send(res, 200, { items: [], total: 0 });
        const data = await ctyunRequest(id, "ctvpc-global.ctapi.ctyun.cn", "GET", "/v4/private-zone-record/list", null, {
          regionID: String(zone._region_id || region), zoneID: String(zone.ZoneId), pageNo: page, pageSize,
          ...(keyword ? { zoneRecordName: keyword } : {}),
        });
        const items = arr(data, ["zoneRecords"]).filter((item) => !type || String(item.type || "").toUpperCase() === type.toUpperCase()).map((item) => ({
          ...item, RecordId: item.zoneRecordID || "", RR: item.name || "@", Type: item.type || "", Value: Array.isArray(item.value) ? item.value.join(", ") : item.value || "", TTL: item.TTL || 0, Priority: "", Line: "默认", Status: "ENABLE",
        }));
        return send(res, 200, { items, total: Number(data.totalCount || items.length) });
      }
      const data = await rpc(
        id,
        "alidns.aliyuncs.com",
        "2015-01-09",
        "DescribeDomainRecords",
        {
          DomainName: url.searchParams.get("domain") || "",
          PageNumber: page,
          PageSize: pageSize,
          ...(type ? { TypeKeyWord: type } : {}),
          ...(keyword ? { RRKeyWord: keyword } : {}),
        },
      );
      return send(res, 200, {
        items: arr(data, ["DomainRecords", "Record"]),
        total: data.TotalCount || 0,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const params = {
        DomainName: payload.domain,
        RR: payload.rr,
        Type: payload.recordType,
        Value: payload.value,
        TTL: payload.ttl || 600,
        ...(payload.line && payload.line !== "default" ? { Line: payload.line } : {}),
      };
      if (payload.recordType === "MX" && payload.priority !== undefined) {
        params.Priority = payload.priority;
      }
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "AddDomainRecord",
        params,
      );
      return send(res, 200, data);
    }
    if (req.method === "PUT" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const params = {
        RecordId: payload.recordId,
        RR: payload.rr,
        Type: payload.recordType,
        Value: payload.value,
        TTL: payload.ttl,
        Line: payload.line,
      };
      if (payload.recordType === "MX" && payload.priority !== undefined) {
        params.Priority = payload.priority;
      }
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "UpdateDomainRecord",
        params,
      );
      return send(res, 200, data);
    }
    if (req.method === "PATCH" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "SetDomainRecordStatus",
        {
          RecordId: payload.recordId,
          Status: payload.status,
        },
      );
      return send(res, 200, data);
    }
    if (req.method === "DELETE" && url.pathname === "/api/dns-records") {
      const payload = JSON.parse(await readBody(req));
      const data = await rpc(
        Number(payload.id),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "DeleteDomainRecord",
        { RecordId: payload.recordId },
      );
      return send(res, 200, data);
    }
    if (req.method === "GET" && url.pathname === "/api/rds-databases") {
      const id = Number(url.searchParams.get("id"));
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const data = await tencentRequest(id, "cdb", "2017-03-20", "DescribeDatabases", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || "");
        return send(res, 200, arr(data, ["Items"]).map((item) => ({ ...item, DBName: item.DatabaseName || item.DBName || "" })));
      }
      const data = await rpc(
        id,
        "rds.aliyuncs.com",
        "2014-08-15",
        "DescribeDatabases",
        {
          RegionId: url.searchParams.get("region") || "",
          DBInstanceId: url.searchParams.get("instance") || "",
        },
      );
      return send(res, 200, arr(data, ["Databases", "Database"]));
    }
    if (req.method === "GET" && url.pathname === "/api/rds-accounts") {
      const id = Number(url.searchParams.get("id"));
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const data = await tencentRequest(id, "cdb", "2017-03-20", "DescribeAccounts", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || "");
        return send(res, 200, arr(data, ["Items"]).map((item) => ({
          ...item,
          AccountName: item.AccountName || item.UserName || "",
          AccountType: item.AccountType || "Normal",
          AccountStatus: item.Status || "Available",
          AccountDescription: item.Description || "",
        })));
      }
      const data = await rpc(
        id,
        "rds.aliyuncs.com",
        "2014-08-15",
        "DescribeAccounts",
        {
          RegionId: url.searchParams.get("region") || "",
          DBInstanceId: url.searchParams.get("instance") || "",
        },
      );
      return send(res, 200, arr(data, ["Accounts", "DBInstanceAccount"]));
    }
    if (req.method === "GET" && url.pathname === "/api/redis-accounts") {
      const id = Number(url.searchParams.get("id"));
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type === "tencent") {
        const data = await tencentRequest(id, "redis", "2018-04-12", "DescribeInstanceAccount", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || "");
        return send(res, 200, arr(data, ["Accounts"]).map((item) => ({
          ...item,
          AccountName: item.AccountName || item.UserName || "",
          AccountType: item.AccountType || "Normal",
          AccountStatus: item.Status || "Available",
          AccountDescription: item.Description || "",
        })));
      }
      const data = await rpc(
        id,
        "r-kvstore.aliyuncs.com",
        "2015-01-01",
        "DescribeAccounts",
        {
          RegionId: url.searchParams.get("region") || "",
          InstanceId: url.searchParams.get("instance") || "",
        },
      );
      return send(res, 200, arr(data, ["Accounts", "Account"]));
    }
    if (req.method === "GET" && url.pathname === "/api/oss-objects") {
      return send(
        res,
        200,
        await ossObjects(
          Number(url.searchParams.get("id")),
          url.searchParams.get("bucket") || "",
          url.searchParams.get("location") || "",
          {
            prefix: url.searchParams.get("prefix") || "",
            marker: url.searchParams.get("marker") || "",
          },
        ),
      );
    }
    if (req.method === "GET" && url.pathname === "/api/instance-disks") {
      try {
        const id = Number(url.searchParams.get("id"));
        const account = getAccountType(id);
        if (!account) return send(res, 404, { error: "云账号不存在" });
        const item = account.cloud_type === "oracle"
          ? await oracleInstanceDisks(id, url.searchParams.get("region") || "", url.searchParams.get("instance") || "", url.searchParams.get("compartment") || "")
          : account.cloud_type === "tencent"
          ? arr(await tencentRequest(id, "cbs", "2017-03-12", "DescribeDisks", { InstanceId: url.searchParams.get("instance") || "" }, url.searchParams.get("region") || ""), ["DiskSet"]).map((disk) => ({ ...disk, DiskId: disk.DiskId, DiskName: disk.DiskName || disk.DiskId, Category: disk.DiskType, Size: disk.DiskSize, Status: disk.DiskState }))
          : arr(await rpc(id, `ecs.${url.searchParams.get("region")}.aliyuncs.com`, "2014-05-26", "DescribeDisks", { RegionId: url.searchParams.get("region") || "", InstanceId: url.searchParams.get("instance") || "" }), ["Disks", "Disk"]);
        return send(res, 200, item);
      } catch (error) { return send(res, 200, []); }
    }
    if (req.method === "GET" && url.pathname === "/api/light-firewall-rules") {
      return send(res, 200, await lightFirewallDetails(Number(url.searchParams.get("id")), String(url.searchParams.get("region") || ""), String(url.searchParams.get("instance") || "")));
    }
    if (req.method === "POST" && url.pathname === "/api/light-firewall-rules") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      const action = String(payload.action || "");
      if (!region || !instanceId) return send(res, 400, { error: "缺少轻量服务器地域或实例 ID" });
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (action === "create") {
        const rule = lightFirewallRuleInput(payload);
        if (account.cloud_type === "aliyun") {
          return send(res, 200, await rpc(id, `swas.${region}.aliyuncs.com`, "2020-06-01", "CreateFirewallRules", { RegionId: region, InstanceId: instanceId, FirewallRules: JSON.stringify([{ Port: rule.portRange, RuleProtocol: rule.protocol.toUpperCase(), SourceCidrIp: rule.sourceCidrIp, Remark: rule.description }]) }));
        }
        if (account.cloud_type === "tencent") {
          const [start, end] = rule.portRange.split("/");
          const firewallRule = { Protocol: rule.protocol.toUpperCase(), Port: start === end ? start : `${start}-${end}`, CidrBlock: rule.sourceCidrIp, Action: "ACCEPT" };
          if (rule.description) firewallRule.FirewallRuleDescription = rule.description;
          const request = { InstanceId: instanceId, FirewallRules: [firewallRule] };
          if (Number.isInteger(Number(payload.firewallVersion))) request.FirewallVersion = Number(payload.firewallVersion);
          return send(res, 200, await tencentRequest(id, "lighthouse", "2020-03-24", "CreateFirewallRules", request, region));
        }
        if (account.cloud_type === "jdcloud") return send(res, 200, await jdcloudFirewallMutation(id, region, "POST", `/v1/regions/${encodeURIComponent(region)}/firewallRule`, { instanceId: instanceId, sourceAddress: rule.sourceCidrIp, ruleProtocol: rule.protocol.toUpperCase(), port: rule.portRange, remark: rule.description || "", clientToken: crypto.randomUUID(), regionId: region }));
      }
      if (action === "delete") {
        if (account.cloud_type === "aliyun") {
          const ruleId = String(payload.ruleId || "").trim();
          if (!ruleId) return send(res, 400, { error: "缺少阿里云防火墙规则 ID" });
          return send(res, 200, await rpc(id, `swas.${region}.aliyuncs.com`, "2020-06-01", "DeleteFirewallRules", { RegionId: region, InstanceId: instanceId, RuleIds: ruleId }));
        }
        if (account.cloud_type === "tencent") {
          const firewallRule = payload.firewallRule;
          if (!firewallRule || typeof firewallRule !== "object" || Array.isArray(firewallRule)) return send(res, 400, { error: "缺少腾讯云防火墙规则内容" });
          const request = { InstanceId: instanceId, FirewallRules: [firewallRule] };
          if (Number.isInteger(Number(payload.firewallVersion))) request.FirewallVersion = Number(payload.firewallVersion);
          return send(res, 200, await tencentRequest(id, "lighthouse", "2020-03-24", "DeleteFirewallRules", request, region));
        }
        if (account.cloud_type === "jdcloud") {
          const ruleId = String(payload.ruleId || "").trim();
          if (!ruleId) return send(res, 400, { error: "缺少京东云防火墙规则 ID" });
          return send(res, 200, await jdcloudFirewallMutation(id, region, "DELETE", `/v1/regions/${encodeURIComponent(region)}/firewallRule`, { instanceId, ruleId, regionId: region }));
        }
      }
      return send(res, 400, { error: "不支持的轻量服务器防火墙操作" });
    }
    if (req.method === "POST" && (url.pathname === "/api/swas-action" || url.pathname === "/api/lighthouse-action")) {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      const action = String(payload.action || "");
      if (!region || !instanceId) return send(res, 400, { error: "缺少轻量服务器地域或实例 ID" });
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      const actionNames = account.cloud_type === "tencent"
        ? { start: "StartInstances", reboot: "RebootInstances", stop: "StopInstances" }
        : account.cloud_type === "aliyun"
          ? { start: "StartInstance", reboot: "RebootInstance", stop: "StopInstance" }
          : account.cloud_type === "jdcloud" ? { start: "startInstance", reboot: "rebootInstance", stop: "stopInstance" } : {};
      const actionName = actionNames[action];
      if (!actionName) return send(res, 400, { error: "不支持的轻量服务器操作" });
      if (account.cloud_type === "jdcloud") return send(res, 200, await jdcloudInstanceAction(id, region, instanceId, actionName));
      if (account.cloud_type === "aliyun") {
        const forceReboot = action === "reboot" && Boolean(payload.forceStop);
        return send(res, 200, await rpc(id, `swas.${region}.aliyuncs.com`, "2020-06-01", forceReboot ? "RebootInstances" : actionName, forceReboot
          ? { RegionId: region, InstanceIds: JSON.stringify([instanceId]), ForceReboot: "true" }
          : { RegionId: region, InstanceId: instanceId }));
      }
      const request = { InstanceIds: [instanceId] };
      if (action === "reboot" && payload.forceStop) request.ForceStop = true;
      return send(res, 200, await tencentRequest(id, "lighthouse", "2020-03-24", actionName, request, region));
    }
    if (req.method === "POST" && url.pathname === "/api/cvm-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      if (!region || !instanceId) return send(res, 400, { error: "缺少服务器地域或实例 ID" });
      const action = String(payload.action || "reboot");
      const actionNames = { start: "StartInstances", stop: "StopInstances", reboot: "RebootInstances" };
      const actionName = actionNames[action];
      if (!actionName) return send(res, 400, { error: "不支持的腾讯云服务器操作" });
      const request = { InstanceIds: [instanceId] };
      if (payload.forceStop && (action === "stop" || action === "reboot")) request.ForceStop = true;
      return send(res, 200, await tencentRequest(id, "cvm", "2017-03-12", actionName, request, region));
    }
    if (req.method === "POST" && url.pathname === "/api/ecs-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      const action = String(payload.action || "");
      if (!region || !instanceId) return send(res, 400, { error: "缺少服务器地域或实例 ID" });
      const actionNames = { start: "StartInstance", stop: "StopInstance", reboot: "RebootInstance" };
      const actionName = actionNames[action];
      if (!actionName) return send(res, 400, { error: "不支持的阿里云服务器操作" });
      return send(res, 200, await rpc(id, `ecs.${region}.aliyuncs.com`, "2014-05-26", actionName, { RegionId: region, InstanceId: instanceId }));
    }
    if (req.method === "GET" && url.pathname === "/api/aliyun-security-groups") {
      const id = Number(url.searchParams.get("id"));
      const region = String(url.searchParams.get("region") || "");
      const instanceId = String(url.searchParams.get("instance") || "");
      const securityGroupId = String(url.searchParams.get("securityGroupId") || "");
      return send(res, 200, await aliyunSecurityGroupDetails(id, region, instanceId, securityGroupId));
    }
    if (req.method === "POST" && url.pathname === "/api/aliyun-security-group-rules") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const securityGroupId = String(payload.securityGroupId || "");
      const params = securityGroupRuleParams({ regionId: region, securityGroupId, ipProtocol: payload.ipProtocol, portRange: payload.portRange, sourceCidrIp: payload.sourceCidrIp, policy: payload.policy, priority: payload.priority, nicType: payload.nicType });
      const action = String(payload.action || "");
      if (action === "authorize") {
        const description = String(payload.description || "").trim();
        if (description) params.Description = description;
        return send(res, 200, await rpc(id, `ecs.${region}.aliyuncs.com`, "2014-05-26", "AuthorizeSecurityGroup", params));
      }
      if (action === "revoke") return send(res, 200, await rpc(id, `ecs.${region}.aliyuncs.com`, "2014-05-26", "RevokeSecurityGroup", params));
      return send(res, 400, { error: "不支持的安全组规则操作" });
    }
    if (req.method === "GET" && url.pathname === "/api/tencent-security-groups") {
      const id = Number(url.searchParams.get("id"));
      const region = String(url.searchParams.get("region") || "");
      const instanceId = String(url.searchParams.get("instance") || "");
      const securityGroupId = String(url.searchParams.get("securityGroupId") || "");
      return send(res, 200, await tencentSecurityGroupDetails(id, region, instanceId, securityGroupId));
    }
    if (req.method === "POST" && url.pathname === "/api/tencent-security-group-rules") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const securityGroupId = String(payload.securityGroupId || "");
      if (!region || !securityGroupId) return send(res, 400, { error: "缺少安全组地域或安全组 ID" });
      const action = String(payload.action || "");
      if (action === "authorize") {
        const policy = tencentSecurityGroupPolicy({ ipProtocol: payload.ipProtocol, portRange: payload.portRange, sourceCidrIp: payload.sourceCidrIp, description: payload.description });
        return send(res, 200, await tencentRequest(id, "cvm", "2017-03-12", "AuthorizeSecurityGroupIngress", { SecurityGroupId: securityGroupId, SecurityGroupPolicySet: [policy] }, region));
      }
      if (action === "revoke") {
        const policyIndex = Number(payload.priority);
        if (!Number.isInteger(policyIndex) || policyIndex < 0) return send(res, 400, { error: "缺少有效的安全组规则索引" });
        return send(res, 200, await tencentRequest(id, "cvm", "2017-03-12", "RevokeSecurityGroupIngress", { SecurityGroupId: securityGroupId, SecurityGroupPolicySet: [{ PolicyIndex: policyIndex }] }, region));
      }
      return send(res, 400, { error: "不支持的安全组规则操作" });
    }
    if (req.method === "GET" && url.pathname === "/api/baidu-security-groups") {
      const id = Number(url.searchParams.get("id"));
      const region = String(url.searchParams.get("region") || "");
      const instanceId = String(url.searchParams.get("instance") || "");
      const securityGroupId = String(url.searchParams.get("securityGroupId") || "");
      return send(res, 200, await baiduSecurityGroupDetails(id, region, instanceId, securityGroupId));
    }
    if (req.method === "POST" && url.pathname === "/api/baidu-security-group-rules") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const securityGroupId = String(payload.securityGroupId || "");
      if (!region || !securityGroupId) return send(res, 400, { error: "缺少安全组地域或安全组 ID" });
      const host = `bcc.${region}.baidubce.com`;
      const action = String(payload.action || "");
      if (action === "authorize") {
        const query = { authorizeRule: "", clientToken: crypto.randomUUID() };
        if (Number.isInteger(Number(payload.sgVersion))) query.sgVersion = Number(payload.sgVersion);
        const { data } = await baiduRequest(id, host, `/v2/securityGroup/${encodeURIComponent(securityGroupId)}`, query, { method: "PUT", body: { rule: baiduSecurityGroupRuleInput(payload) }, includeEmptyQuery: true });
        return send(res, 200, data);
      }
      if (action === "revoke") {
        const ruleId = String(payload.securityGroupRuleId || "").trim();
        if (!ruleId) return send(res, 400, { error: "缺少百度云安全组规则 ID" });
        const query = { clientToken: crypto.randomUUID() };
        if (Number.isInteger(Number(payload.sgVersion))) query.sgVersion = Number(payload.sgVersion);
        const { data } = await baiduRequest(id, host, `/v2/securityGroup/rule/${encodeURIComponent(ruleId)}`, query, { method: "DELETE" });
        return send(res, 200, data);
      }
      return send(res, 400, { error: "不支持的百度云安全组规则操作" });
    }
    if (req.method === "GET" && url.pathname === "/api/vultr-firewall-rules") {
      const id = Number(url.searchParams.get("id"));
      const firewallGroupId = String(url.searchParams.get("firewallGroupId") || "").trim();
      if (!firewallGroupId) return send(res, 400, { error: "缺少 Vultr 防火墙组 ID" });
      const data = await vultrRequest(id, `firewalls/${encodeURIComponent(firewallGroupId)}/rules`);
      return send(res, 200, { rules: vultrFirewallRules(data) });
    }
    if (req.method === "POST" && url.pathname === "/api/vultr-firewall-rules") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const firewallGroupId = String(payload.firewallGroupId || "").trim();
      const action = String(payload.action || "").trim();
      if (!firewallGroupId) return send(res, 400, { error: "缺少 Vultr 防火墙组 ID" });
      const pathName = `firewalls/${encodeURIComponent(firewallGroupId)}/rules`;
      if (action === "create") return send(res, 200, await vultrRequest(id, pathName, {}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(vultrFirewallRuleInput(payload)) }));
      if (action === "delete") {
        const ruleId = String(payload.ruleId || "").trim();
        if (!ruleId) return send(res, 400, { error: "缺少 Vultr 防火墙规则 ID" });
        return send(res, 200, await vultrRequest(id, `${pathName}/${encodeURIComponent(ruleId)}`, {}, { method: "DELETE" }));
      }
      return send(res, 400, { error: "不支持的 Vultr 防火墙规则操作" });
    }
    if (req.method === "POST" && url.pathname === "/api/vultr-instance-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const instanceId = String(payload.instanceId || "").trim();
      const action = String(payload.action || "").trim();
      if (!instanceId) return send(res, 400, { error: "缺少 Vultr 实例 ID" });
      if (!new Set(["start", "stop", "reboot"]).has(action)) return send(res, 400, { error: "不支持的 Vultr 服务器操作" });
      const endpoint = action === "stop" ? "halt" : action;
      return send(res, 200, await vultrRequest(id, `instances/${encodeURIComponent(instanceId)}/${endpoint}`, {}, { method: "POST" }));
    }
    if (req.method === "POST" && url.pathname === "/api/vultr-instance-manage") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const instanceId = String(payload.instanceId || "").trim();
      const action = String(payload.action || "").trim();
      const value = String(payload.value || "").trim();
      if (!instanceId) return send(res, 400, { error: "缺少 Vultr 实例 ID" });
      const updatePath = `instances/${encodeURIComponent(instanceId)}`;
      const actions = {
        snapshot: { path: "snapshots", method: "POST", body: { instance_id: instanceId, description: value } },
        label: value ? { path: updatePath, method: "PATCH", body: { label: value } } : null,
        tags: { path: updatePath, method: "PATCH", body: { tags: value.split(",").map((tag) => tag.trim()).filter(Boolean) } },
        enable_backups: { path: updatePath, method: "PATCH", body: { backups: "enabled" } },
        disable_backups: { path: updatePath, method: "PATCH", body: { backups: "disabled" } },
        enable_ddos: { path: updatePath, method: "PATCH", body: { ddos_protection: true } },
        disable_ddos: { path: updatePath, method: "PATCH", body: { ddos_protection: false } },
        enable_ipv6: { path: updatePath, method: "PATCH", body: { enable_ipv6: true } },
        firewall: value ? { path: updatePath, method: "PATCH", body: { firewall_group_id: value } } : null,
      };
      const request = actions[action];
      if (!request) return send(res, 400, { error: "不支持的 Vultr 实例管理操作，或缺少必要参数" });
      return send(res, 200, await vultrRequest(id, request.path, {}, { method: request.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) }));
    }
    if (req.method === "POST" && url.pathname === "/api/bcc-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      const action = String(payload.action || "");
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type !== "baidu") return send(res, 400, { error: "当前账号不是百度智能云账号" });
      return send(res, 200, await baiduBccAction(id, region, instanceId, action, Boolean(payload.forceStop)));
    }
    if (req.method === "POST" && url.pathname === "/api/oracle-instance-action") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "");
      const instanceId = String(payload.instanceId || "");
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      if (account.cloud_type !== "oracle") return send(res, 400, { error: "当前账号不是 Oracle Cloud 账号" });
      return send(res, 200, await oracleInstanceAction(id, region, instanceId, String(payload.action || "")));
    }
    if (req.method === "POST" && url.pathname === "/api/server-name") {
      const payload = JSON.parse(await readBody(req));
      const id = Number(payload.id);
      const region = String(payload.regionId || "").trim();
      const instanceId = String(payload.instanceId || "").trim();
      const instanceName = String(payload.instanceName || "").trim();
      if (!region || !instanceId) return send(res, 400, { error: "缺少服务器地域或实例 ID" });
      if (!instanceName) return send(res, 400, { error: "服务器名称不能为空" });
      if (Buffer.byteLength(instanceName, "utf8") > 128) return send(res, 400, { error: "服务器名称不能超过 128 个字节" });
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      const data = account.cloud_type === "tencent"
        ? await tencentRequest(id, "cvm", "2017-03-12", "ModifyInstancesAttribute", { InstanceIds: [instanceId], InstanceName: instanceName }, region)
        : await rpc(id, `ecs.${region}.aliyuncs.com`, "2014-05-26", "ModifyInstanceAttribute", { RegionId: region, InstanceId: instanceId, InstanceName: instanceName });
      updateServerName(id, instanceId, instanceName);
      return send(res, 200, data);
    }
    if (req.method === "GET" && url.pathname === "/api/oss-acl") {
      return send(res, 200, {
        acl: await ossAcl(
          Number(url.searchParams.get("id")),
          url.searchParams.get("bucket") || "",
          url.searchParams.get("location") || "",
        ),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/oss-detail") {
      return send(res, 200, await ossDetail(
        Number(url.searchParams.get("id")),
        url.searchParams.get("bucket") || "",
        url.searchParams.get("location") || "",
      ));
    }
    if (req.method === "POST" && url.pathname === "/api/oss-public-read") {
      await ossSetPublicRead(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "");
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/oss-cors") {
      await ossSetCors(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "", url.searchParams.get("origins") || "*");
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/oss-cname-token") {
      return send(res, 200, await ossCnameMutation(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "", "token", url.searchParams.get("domain") || ""));
    }
    if (req.method === "POST" && url.pathname === "/api/oss-cname") {
      return send(res, 200, await ossCnameMutation(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "", "bind", url.searchParams.get("domain") || ""));
    }
    if (req.method === "DELETE" && url.pathname === "/api/oss-cname") {
      return send(res, 200, await ossCnameMutation(Number(url.searchParams.get("id")), url.searchParams.get("bucket") || "", url.searchParams.get("location") || "", "delete", url.searchParams.get("domain") || ""));
    }
    if (req.method === "GET" && url.pathname === "/api/cloud-resources") {
      const type = url.searchParams.get("type") || "domain";
      const id = Number(url.searchParams.get("id"));
      const account = getAccountType(id);
      if (!account) return send(res, 404, { error: "云账号不存在" });
      return send(res, 200, await cloudResources(id, type));
    }
    if (req.method === "GET" && url.pathname === "/api/esa-overview") {
      return send(res, 200, await esaOverview(
        Number(url.searchParams.get("id")),
        url.searchParams.get("range") || "today",
        url.searchParams.get("site_id") || "",
      ));
    }
    if (req.method === "GET" && url.pathname === "/api/cloud-summary") {
      const id = Number(url.searchParams.get("id"));
      const accountRow = getAccountSecretRecord(id);
      if (!accountRow) return send(res, 404, { error: "云账号不存在" });
      if (accountRow.cloud_type === "tencent") {
        const today = new Date().toISOString().slice(0, 10);
        const monthStart = `${today.slice(0, 8)}01`;
        const [cvmResult, domainResult, swasResult, rdsResult, redisResult, ossResult, esaResult, identityResult, balanceResult, billResult] = await Promise.allSettled([
          tencentResources(id, "ecs"),
          tencentResources(id, "domain"),
          tencentResources(id, "swas"),
          tencentResources(id, "rds"),
          tencentResources(id, "redis"),
          tencentResources(id, "oss"),
          tencentResources(id, "esa"),
          tencentRequest(id, "cam", "2019-01-16", "GetUserAppId"),
          tencentRequest(id, "billing", "2018-07-09", "DescribeAccountBalance"),
          tencentRequest(id, "billing", "2018-07-09", "DescribeBillSummaryByPayMode", { BeginTime: monthStart, EndTime: today }),
        ]);
        const cvm = cvmResult.status === "fulfilled" ? cvmResult.value.items : [];
        const domains = domainResult.status === "fulfilled" ? domainResult.value.items : [];
        const swas = swasResult.status === "fulfilled" ? swasResult.value.items : [];
        const rds = rdsResult.status === "fulfilled" ? rdsResult.value.items : [];
        const redis = redisResult.status === "fulfilled" ? redisResult.value.items : [];
        const oss = ossResult.status === "fulfilled" ? ossResult.value.items : [];
        const esa = esaResult.status === "fulfilled" ? esaResult.value.items : [];
        const identity = identityResult.status === "fulfilled" ? identityResult.value : {};
        const balance = balanceResult.status === "fulfilled" ? balanceResult.value : {};
        const bill = billResult.status === "fulfilled" ? billResult.value : {};
        const overview = bill.SummaryOverview || bill.SummarySet?.[0] || {};
        const monthlyTotal = tencentNumber(overview.RealTotalCost || overview.TotalCost || overview.CashPayAmount);
        return send(res, 200, {
          account_id: identity.AppId || identity.UserAppId || accountRow.access_key_id,
          account_type: "腾讯云账号",
          available_amount: tencentNumber(balance.Balance || balance.RealBalance) / 100,
          available_cash_amount: tencentNumber(balance.CashAccountBalance) / 100,
          credit_amount: tencentNumber(balance.PresentAccountBalance || balance.IncentiveAccountBalance || balance.VoucherBalance) / 100,
          month_consume: monthlyTotal,
          month_bill: monthlyTotal,
          ecs_count: cvm.length,
          domain_count: domains.length,
          dns_record_count: domains.reduce((sum, item) => sum + tencentNumber(item.RecordCount), 0),
          oss_count: oss.length, rds_count: rds.length, redis_count: redis.length, swas_count: swas.length, esa_count: esa.length,
        });
      }
      if (accountRow.cloud_type === "volcengine") {
        const [ecsResult, domainResult, swasResult, ossResult, rdsResult, redisResult, esaResult] = await Promise.allSettled([
          volcResources(id, "ecs"),
          volcResources(id, "domain"),
          volcResources(id, "swas"),
          volcResources(id, "oss"),
          volcResources(id, "rds"),
          volcResources(id, "redis"),
          volcResources(id, "esa"),
        ]);
        const itemCount = (result) => result.status === "fulfilled" ? result.value.items.length : 0;
        return send(res, 200, {
          account_id: accountRow.access_key_id,
          account_type: "火山引擎账号",
          available_amount: 0,
          available_cash_amount: 0,
          credit_amount: 0,
          month_consume: 0,
          month_bill: 0,
          ecs_count: itemCount(ecsResult),
          domain_count: itemCount(domainResult),
          dns_record_count: 0,
          oss_count: itemCount(ossResult),
          rds_count: itemCount(rdsResult),
          redis_count: itemCount(redisResult),
          swas_count: itemCount(swasResult),
          esa_count: itemCount(esaResult),
        });
      }
      if (accountRow.cloud_type === "ctyun") {
        const [ecs, domains, rds, redis, oss] = await Promise.all(["ecs", "domain", "rds", "redis", "oss"].map((type) => ctyunResources(id, type)));
        return send(res, 200, {
          account_id: accountRow.access_key_id,
          account_type: "天翼云账号",
          available_amount: 0,
          available_cash_amount: 0,
          credit_amount: 0,
          month_consume: 0,
          month_bill: 0,
          ecs_count: ecs.items.length,
          domain_count: domains.items.length,
          dns_record_count: domains.items.reduce((sum, item) => sum + Number(item.RecordCount || 0), 0),
          oss_count: oss.items.length,
          rds_count: rds.items.length,
          redis_count: redis.items.length,
          swas_count: 0,
          esa_count: 0,
        });
      }
      const accountIdText = accountRow?.access_key_id || "-";
      const [domainData, accountData, balanceData, billData] = await Promise.allSettled([
        rpc(id, "domain.aliyuncs.com", "2018-01-29", "QueryDomainList", { PageNum: "1", PageSize: "100" }),
        rpc(id, "bss.openapi.aliyuncs.com", "2017-12-14", "QueryAccountInfo", {}),
        rpc(id, "bss.openapi.aliyuncs.com", "2017-12-14", "QueryAccountBalance", {}),
        rpc(id, "bss.openapi.aliyuncs.com", "2017-12-14", "QueryBillOverview", { BillingCycle: new Date().toISOString().slice(0, 7) }),
      ]);
      const domains = domainData.status === "fulfilled" ? arr(domainData.value, ["Data", "Domain"]) : [];
      const resourceTypes = ["ecs", "oss", "rds", "redis", "swas", "esa"];
      const results = await Promise.allSettled(resourceTypes.map((type) => cloudResources(id, type)));
      const counts = Object.fromEntries(resourceTypes.map((type, index) => [type, results[index].status === "fulfilled" ? results[index].value.items.length : 0]));
      const dnsCount = domains.reduce((sum, d) => sum + Number(d.RecordCount || 0), 0);
      const accountInfo = accountData.status === "fulfilled" ? accountData.value.Data || {} : {};
      const balanceInfo = balanceData.status === "fulfilled" ? balanceData.value.Data || {} : {};
      const billInfo = billData.status === "fulfilled" ? billData.value.Data || {} : {};
      return send(res, 200, {
        account_id: accountInfo.AccountId || accountIdText,
        account_type: accountInfo.AccountType === "1" ? "主账号" : accountInfo.AccountType === "2" ? "子账号" : "-",
        available_amount: Number(balanceInfo.AvailableAmount || 0),
        available_cash_amount: Number(balanceInfo.AvailableCashAmount || 0),
        credit_amount: Number(balanceInfo.CreditAmount || 0),
        month_consume: Number(billInfo.PretaxAmount || 0),
        month_bill: Number(billInfo.PretaxAmount || 0),
        ecs_count: counts.ecs,
        domain_count: domains.length,
        dns_record_count: dnsCount,
        oss_count: counts.oss,
        rds_count: counts.rds,
        redis_count: counts.redis,
        swas_count: counts.swas,
        esa_count: counts.esa,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/domain-logs") {
      const page = url.searchParams.get("page") || "1";
      const pageSize = url.searchParams.get("pageSize") || "20";
      const data = await rpc(
        Number(url.searchParams.get("id")),
        "alidns.aliyuncs.com",
        "2015-01-09",
        "DescribeRecordLogs",
        {
          DomainName: url.searchParams.get("domain") || "",
          PageNumber: page,
          PageSize: pageSize,
        },
      );
      return send(res, 200, {
        items: arr(data, ["RecordLogs", "RecordLog"]),
        total: data.TotalCount || 0,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/whois") {
      const data = await rpc(
        Number(url.searchParams.get("id")),
        "domain.aliyuncs.com",
        "2018-01-29",
        "QueryDomainByDomainName",
        { DomainName: url.searchParams.get("domain") || "" },
      );
      const get = (key) => data[key] ?? "-";
      return send(
        res,
        200,
        `域名信息查询结果\n=====================================\n\n域名: ${get("DomainName")}\n域名持有者: ${get("ZhRegistrantOrganization") || get("RegistrantOrganization")}\n持有者类型: ${get("RegistrantType")}\n联系人: ${get("ZhRegistrantName") || get("RegistrantName")}\n联系邮箱: ${get("Email")}\n\n注册时间: ${get("RegistrationDate")}\n到期时间: ${get("ExpirationDate")}\n注册商: 阿里云\n\n实名认证: ${get("RealNameStatus")}\n域名状态: ${get("DomainStatus")}\nDNS服务器: ${JSON.stringify(get("DnsList"))}`,
      );
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    const status = Number(error?.statusCode);
    return send(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 500, { error: String(error?.message || error) });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`CloudHub Tools Web API: http://127.0.0.1:${port}`),
);
