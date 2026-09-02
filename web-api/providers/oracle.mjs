import crypto from "node:crypto";
import { writeApiLog } from "../core/database.mjs";
import { decryptSecret } from "../core/crypto.mjs";
import { getAccountSecretRecord } from "../repositories/accounts.mjs";

function encode(value) { return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }
function meta(row) {
  let value = {};
  try { value = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ }
  const tenancyOcid = String(value.tenancy_ocid || "").trim();
  const fingerprint = String(value.key_fingerprint || "").trim();
  if (!tenancyOcid || !fingerprint) throw new Error("OCI 账号缺少 Tenancy OCID 或 Key Fingerprint");
  return { tenancyOcid, fingerprint };
}
function normalizePrivateKey(value) { return String(value || "").trim().replace(/^OCI_API_KEY\s*=\s*/i, "").replace(/^(['"])([\s\S]*)\1$/, "$2").replace(/\\r\\n|\\n|\\r/g, "\n"); }
function account(accountId) {
  const row = getAccountSecretRecord(accountId);
  if (!row) throw new Error("云账号不存在");
  if (!row.enabled) throw new Error("云账号已停用");
  if (row.cloud_type !== "oracle") throw new Error("当前账号不是 Oracle Cloud 账号");
  return row;
}

export function validateMeta(row) { return meta(row); }

export async function request(accountId, host, requestPath, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const body = options.body === undefined ? "" : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  const row = account(accountId);
  const { tenancyOcid, fingerprint } = meta(row);
  const privateKey = normalizePrivateKey(decryptSecret(row.secret_ciphertext));
  const date = new Date().toUTCString();
  const signedHeaders = ["(request-target)", "host", "date"];
  const canonicalLines = [`(request-target): ${method.toLowerCase()} ${requestPath}`, `host: ${host}`, `date: ${date}`];
  const headers = { host, date };
  if (method !== "GET" && method !== "HEAD") {
    const contentLength = Buffer.byteLength(body, "utf8");
    const contentSha256 = crypto.createHash("sha256").update(body, "utf8").digest("base64");
    signedHeaders.push("content-type", "content-length", "x-content-sha256");
    canonicalLines.push("content-type: application/json", `content-length: ${contentLength}`, `x-content-sha256: ${contentSha256}`);
    Object.assign(headers, { "content-type": "application/json", "content-length": String(contentLength), "x-content-sha256": contentSha256 });
  }
  let signature;
  try { signature = crypto.sign("RSA-SHA256", Buffer.from(canonicalLines.join("\n")), privateKey).toString("base64"); }
  catch { throw new Error("OCI API 私钥无效，需使用未加密的 RSA PEM 私钥"); }
  const keyId = `${tenancyOcid}/${row.access_key_id}/${fingerprint}`;
  const authorization = `Signature version=\"1\",keyId=\"${keyId}\",algorithm=\"rsa-sha256\",headers=\"${signedHeaders.join(" ")}\",signature=\"${signature}\"`;
  const response = await fetch(`https://${host}${requestPath}`, { method, headers: { ...headers, authorization }, body: method === "GET" || method === "HEAD" ? undefined : body });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) {
    const message = data?.message || data?.code || `OCI ${response.status}`;
    writeApiLog(accountId, host, `${method} ${requestPath.split("?")[0]}`, {}, data, "失败", message);
    throw new Error(message);
  }
  writeApiLog(accountId, host, `${method} ${requestPath.split("?")[0]}`, {}, data, "成功");
  return { data, nextPage: response.headers.get("opc-next-page") || "" };
}

export async function pages(accountId, host, pathName, query = {}) {
  const items = [];
  let page = "";
  for (let index = 0; index < 100; index += 1) {
    const params = new URLSearchParams(query);
    if (page) params.set("page", page);
    const result = await request(accountId, host, `${pathName}${params.size ? `?${params.toString()}` : ""}`);
    items.push(...(Array.isArray(result.data) ? result.data : []));
    if (!result.nextPage) return items;
    page = result.nextPage;
  }
  throw new Error("OCI 分页超过 100 页，已停止读取");
}

export async function context(accountId) {
  const row = account(accountId);
  const { tenancyOcid } = meta(row);
  const homeRegion = String(row.region_id || "ap-tokyo-1");
  const identityHost = `identity.${homeRegion}.oci.oraclecloud.com`;
  const compartments = await pages(accountId, identityHost, "/20160918/compartments", { compartmentId: tenancyOcid, compartmentIdInSubtree: "true", accessLevel: "ACCESSIBLE", lifecycleState: "ACTIVE" });
  const subscriptions = await pages(accountId, identityHost, `/20160918/tenancy/${encode(tenancyOcid)}/regionSubscriptions`).catch(() => []);
  const allCompartments = [{ id: tenancyOcid, name: "Root Compartment" }, ...compartments].filter((item) => !/^ManagedCompartmentForPaaS$/i.test(String(item?.name || ""))).filter((item, index, values) => values.findIndex((value) => value.id === item.id) === index);
  const regions = [...new Set(subscriptions.filter((item) => String(item.status || "").toUpperCase() === "READY").map((item) => item.regionName).filter(Boolean))];
  return { compartments: allCompartments, regions: regions.length ? regions : [homeRegion] };
}

function objectStorageHost(region) { return `objectstorage.${region}.oci.customer-oci.com`; }
function addressList(values) { return [...new Set(values.filter(Boolean).map(String))].join(", "); }
async function imageName(accountId, host, imageId) { if (!imageId) return ""; try { const image = (await request(accountId, host, `/20160918/images/${encode(imageId)}`)).data; return image.displayName || [image.operatingSystem, image.operatingSystemVersion].filter(Boolean).join(" ") || imageId; } catch { return imageId; } }
async function instance(accountId, host, item, region, compartment, shape) {
  const attachmentQuery = { compartmentId: compartment.id, instanceId: item.id };
  const [detailResult, attachmentResult] = await Promise.allSettled([request(accountId, host, `/20160918/instances/${encode(item.id)}`), pages(accountId, host, "/20160918/vnicAttachments", attachmentQuery)]);
  const current = detailResult.status === "fulfilled" ? detailResult.value.data : item;
  const networkErrors = attachmentResult.status === "rejected" ? [attachmentResult.reason?.message || String(attachmentResult.reason)] : [];
  const attachments = attachmentResult.status === "fulfilled" ? attachmentResult.value : [];
  const vnicResults = await Promise.all(attachments.map(async (attachment) => { const publicIps = [attachment.publicIp, attachment.publicIpAddress].filter(Boolean); const privateIps = [attachment.privateIp, attachment.privateIpAddress].filter(Boolean); if (!attachment.vnicId) return { publicIps, privateIps, error: "VNIC attachment 缺少 vnicId" }; try { const vnic = (await request(accountId, host, `/20160918/vnics/${encode(attachment.vnicId)}`)).data; return { publicIps: [...publicIps, vnic.publicIp, vnic.publicIpAddress].filter(Boolean), privateIps: [...privateIps, vnic.privateIp, vnic.privateIpAddress].filter(Boolean), vnic }; } catch (error) { return { publicIps, privateIps, error: error.message || String(error) }; } }));
  vnicResults.forEach((result) => { if (result.error) networkErrors.push(result.error); });
  const vnics = vnicResults.map((result) => result.vnic || null); const shapeConfig = current.shapeConfig || item.shapeConfig || {}; const ocpus = shapeConfig.ocpus ?? shape?.ocpus ?? null; const memoryInGBs = shapeConfig.memoryInGBs ?? shape?.memoryInGBs ?? null;
  return { ...item, ...current, InstanceId: current.id || item.id, InstanceName: current.displayName || item.displayName || item.id, InstanceStatus: current.lifecycleState || item.lifecycleState, Status: current.lifecycleState || item.lifecycleState, InstanceType: current.shape || item.shape || "", Cpu: ocpus, Memory: memoryInGBs == null ? null : Number(memoryInGBs) * 1024, PublicIpAddress: addressList([...vnics.map((vnic) => vnic?.publicIp || vnic?.publicIpAddress), ...vnicResults.flatMap((result) => result.publicIps)]), PrivateIpAddress: addressList([...vnics.map((vnic) => vnic?.privateIp || vnic?.privateIpAddress), ...vnicResults.flatMap((result) => result.privateIps)]), OSName: await imageName(accountId, host, current.imageId || item.imageId), ImageId: current.imageId || item.imageId || "", CreationTime: current.timeCreated || item.timeCreated || "", _network_error: networkErrors.length ? [...new Set(networkErrors)].join("；") : "", _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name };
}
function dbSystem(item, region, compartment) { return { ...item, DBInstanceId: item.id, DBInstanceDescription: item.displayName || item.id, DBInstanceStatus: item.lifecycleState, Engine: item.dbSystemOptions?.storageManagement || item.databaseEdition || "Oracle Database", EngineVersion: item.dbVersion || "", ConnectionString: item.hostname || "", _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name }; }
function zone(item, region, compartment) { return { ...item, DomainName: String(item.name || "").replace(/\.$/, ""), DomainStatus: item.lifecycleState || "ACTIVE", RecordCount: 0, ZoneId: item.id || item.name, _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name }; }
function bucket(item, region, compartment) { return { ...item, Name: item.name, BucketName: item.name, Location: region, StorageClass: item.publicAccessType || "Standard", Acl: item.publicAccessType || "NoPublicAccess", _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name }; }

export async function resources(accountId, type) {
  const { compartments, regions } = await context(accountId);
  const items = []; const errors = [];
  for (const region of regions) {
    const hosts = { ecs: `iaas.${region}.oci.oraclecloud.com`, rds: `database.${region}.oci.oraclecloud.com`, domain: `dns.${region}.oci.oraclecloud.com`, oss: objectStorageHost(region) };
    if (!hosts[type]) return { resource_type: type, items, errors: [`Oracle Cloud 暂未接入 ${type} 资源`], fetched_at: Date.now() };
    let namespace = "";
    if (type === "oss") { try { namespace = String((await request(accountId, hosts.oss, "/n/")).data || ""); } catch (error) { errors.push(`${region}: ${error.message}`); continue; } if (!namespace) { errors.push(`${region}: 未能读取 Object Storage namespace`); continue; } }
    for (const compartment of compartments) {
      try {
        const values = type === "ecs" ? await pages(accountId, hosts.ecs, "/20160918/instances", { compartmentId: compartment.id }) : type === "rds" ? await pages(accountId, hosts.rds, "/20160918/dbSystems", { compartmentId: compartment.id }) : type === "domain" ? await pages(accountId, hosts.domain, "/20180115/zones", { compartmentId: compartment.id }) : await pages(accountId, hosts.oss, `/n/${encode(namespace)}/b/`, { compartmentId: compartment.id });
        const shapes = type === "ecs" ? await pages(accountId, hosts.ecs, "/20160928/shapes", { compartmentId: compartment.id }).catch(() => []) : [];
        const normalized = type === "ecs" ? await Promise.all(values.map((item) => instance(accountId, hosts.ecs, item, region, compartment, shapes.find((shape) => shape.shape === item.shape)))) : type === "rds" ? values.map((item) => dbSystem(item, region, compartment)) : type === "domain" ? values.map((item) => zone(item, region, compartment)) : values.map((item) => bucket(item, region, compartment));
        items.push(...normalized);
      } catch (error) { errors.push(`${region}/${compartment.name}: ${error.message}`); }
    }
  }
  return { resource_type: type, items, errors, fetched_at: Date.now() };
}
