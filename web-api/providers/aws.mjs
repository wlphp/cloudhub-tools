import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { rpcEncode } from "./aliyun-rpc.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

export function sign(key, value) { return crypto.createHmac("sha256", key).update(value).digest(); }
export function queryValues(query = {}) { return Object.entries(query).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [rpcEncode(key), rpcEncode(value)]).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)).map(([key, value]) => `${key}=${value}`).join("&"); }

function xmlMessage(text) {
  const match = String(text).match(/<Message>([\s\S]*?)<\/Message>|<Code>([\s\S]*?)<\/Code>/i);
  return (match?.[1] || match?.[2] || "").replace(/&amp;/g, "&").trim();
}

function xmlDecode(value = "") {
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function xmlText(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match ? xmlDecode(match[1]).trim() : "";
}

function xmlBlocks(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"))].map((match) => match[1]);
}

export async function request(accountId, service, region, host, pathname = "/", query = {}) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "aws") throw new Error("当前账号不是 AWS 账号");
  const date = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const queryText = queryValues(query);
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const headers = `host:${host}\nx-amz-date:${date}\n`;
  const signedHeaders = "host;x-amz-date";
  const canonicalRequest = `GET\n${pathname}\n${queryText}\n${headers}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const secret = decryptSecret(row.secret_ciphertext);
  const keyDate = sign(`AWS4${secret}`, day); const keyRegion = sign(keyDate, region); const keyService = sign(keyRegion, service); const keySigning = sign(keyService, "aws4_request");
  const signature = sign(keySigning, stringToSign).toString("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${row.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}${pathname}${queryText ? `?${queryText}` : ""}`, { headers: { Host: host, "X-Amz-Date": date, Authorization: authorization } });
  const text = await response.text();
  if (!response.ok) { const message = xmlMessage(text) || `AWS ${response.status}`; writeApiLog(accountId, host, `GET ${pathname}`, query, { body: text }, "失败", message); throw new Error(message); }
  writeApiLog(accountId, host, `GET ${pathname}`, query, { body: text }, "成功");
  return text;
}

function instance(item, region) { const tags = xmlBlocks(item, "item"); const nameTag = tags.find((tag) => xmlText(tag, "key") === "Name"); return { InstanceId: xmlText(item, "instanceId"), InstanceName: nameTag ? xmlText(nameTag, "value") : xmlText(item, "instanceId"), InstanceStatus: xmlText(item, "instanceState") || xmlText(item, "name"), Status: xmlText(item, "name"), PublicIpAddress: xmlText(item, "ipAddress"), PrivateIpAddress: xmlText(item, "privateIpAddress"), InstanceType: xmlText(item, "instanceType"), VpcId: xmlText(item, "vpcId"), _region_id: region, _raw_xml: item }; }
function rds(item, region) { return { DBInstanceId: xmlText(item, "DBInstanceIdentifier"), DBInstanceDescription: xmlText(item, "DBInstanceIdentifier"), DBInstanceStatus: xmlText(item, "DBInstanceStatus"), DBInstanceClass: xmlText(item, "DBInstanceClass"), DBInstanceStorage: Number(xmlText(item, "AllocatedStorage") || 0), ConnectionString: xmlText(item, "Address"), Port: xmlText(item, "Port"), Engine: xmlText(item, "Engine"), EngineVersion: xmlText(item, "EngineVersion"), CreateTime: xmlText(item, "InstanceCreateTime"), _region_id: region, _raw_xml: item }; }
function redis(item, region) { return { InstanceId: xmlText(item, "CacheClusterId"), InstanceName: xmlText(item, "CacheClusterId"), InstanceStatus: xmlText(item, "CacheClusterStatus"), InstanceType: "Redis", InstanceClass: xmlText(item, "CacheNodeType"), Capacity: 0, ConnectionDomain: xmlText(item, "Address"), Port: xmlText(item, "Port"), EngineVersion: xmlText(item, "EngineVersion"), NetworkType: xmlText(item, "VpcId"), _region_id: region, _raw_xml: item }; }

export async function resources(accountId, type, regions = ["ap-northeast-1"]) {
  const items = [];
  const errors = [];
  if (type === "oss") { try { const xml = await request(accountId, "s3", "us-east-1", "s3.amazonaws.com"); items.push(...xmlBlocks(xml, "Bucket").map((block) => ({ Name: xmlText(block, "Name"), BucketName: xmlText(block, "Name"), Location: "global", CreationDate: xmlText(block, "CreationDate"), StorageClass: "STANDARD", Acl: "private", ExtranetEndpoint: "-", IntranetEndpoint: "-", _region_id: "global" }))); } catch (error) { errors.push(error.message); } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
  if (type === "domain") { try { const xml = await request(accountId, "route53", "us-east-1", "route53.amazonaws.com", "/2013-04-01/hostedzone"); items.push(...xmlBlocks(xml, "HostedZone").map((block) => ({ DomainName: xmlText(block, "Name").replace(/\.$/, ""), DomainStatus: xmlText(block, "PrivateZone") === "true" ? "PRIVATE" : "ACTIVE", ZoneId: xmlText(block, "Id"), RecordCount: Number(xmlText(block, "ResourceRecordSetCount") || 0), RegistrationDate: "", _region_id: "global", _aws_route53: true }))); } catch (error) { errors.push(error.message); } return { resource_type: type, items, errors, fetched_at: Date.now() }; }
  const services = { ecs: ["ec2", "ec2", "DescribeInstances", "2016-11-15", "reservationSet", instance], rds: ["rds", "rds", "DescribeDBInstances", "2014-10-31", "DBInstances", rds], redis: ["elasticache", "elasticache", "DescribeCacheClusters", "2015-02-02", "CacheClusters", redis] };
  const definition = services[type];
  if (!definition) return { resource_type: type, items, errors: [`AWS 暂未接入 ${type} 资源`], fetched_at: Date.now() };
  for (const region of regions) { const [serviceName, subdomain, action, version, tag, normalize] = definition; try { const xml = await request(accountId, serviceName, region, `${subdomain}.${region}.amazonaws.com`, "/", { Action: action, Version: version, ...(type === "redis" ? { ShowCacheNodeInfo: "true" } : {}) }); const blocks = type === "ecs" ? xmlBlocks(xml, "instancesSet").flatMap((set) => xmlBlocks(set, "item")) : xmlBlocks(xml, tag).flatMap((set) => xmlBlocks(set, "item")); items.push(...blocks.map((block) => normalize(block, region))); } catch (error) { errors.push(`${region}: ${error.message}`); } }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}

export async function verify(accountId, regions = ["ap-northeast-1"]) {
  await request(accountId, "ec2", regions[0], `ec2.${regions[0]}.amazonaws.com`, "/", { Action: "DescribeInstances", Version: "2016-11-15", MaxResults: "5" });
  return { provider: "aws", verified: true, region_count: regions.length, regions, default_region: regions[0] };
}
