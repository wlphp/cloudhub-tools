export function createOracleProvider({ crypto, database, decryptSecret, writeApiLog }) {
  function metadata(row) {
    let meta = {};
    try { meta = JSON.parse(row.credential_meta || "{}"); } catch { /* legacy account */ }
    const tenancyOcid = String(meta.tenancy_ocid || "").trim();
    const fingerprint = String(meta.key_fingerprint || "").trim();
    if (!tenancyOcid || !fingerprint) throw new Error("OCI 账号缺少 Tenancy OCID 或 Key Fingerprint");
    return { tenancyOcid, fingerprint };
  }

  function normalizePrivateKey(value) {
    let key = String(value || "").trim().replace(/^OCI_API_KEY\s*=\s*/i, "").replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\r\n?/g, "\n");
    key = key.replace(/^[ \t]*\\+(?=-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----)/gm, "");
    for (const type of ["PRIVATE KEY", "RSA PRIVATE KEY"]) {
      const begin = "-----BEGIN " + type + "-----";
      const end = "-----END " + type + "-----";
      const start = key.indexOf(begin);
      const finish = start < 0 ? -1 : key.indexOf(end, start + begin.length);
      if (start < 0 || finish < 0) continue;
      const body = key.slice(start + begin.length, finish).replace(/\s/g, "");
      if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return key;
      return begin + "\n" + (body.match(/.{1,64}/g)?.join("\n") || body) + "\n" + end;
    }
    return key;
  }

  function serializePrivateKey(value) {
    return normalizePrivateKey(value).replace(/\n/g, "\\n");
  }

  function encode(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  }

  async function request(accountId, host, requestPath, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body === undefined ? "" : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    const row = database().prepare("SELECT access_key_id,secret_ciphertext,credential_meta,enabled,cloud_type FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    if (!row.enabled) throw new Error("云账号已停用");
    if (row.cloud_type !== "oracle") throw new Error("当前账号不是 Oracle Cloud 账号");
    const { tenancyOcid, fingerprint } = metadata(row);
    const privateKey = normalizePrivateKey(decryptSecret(row.secret_ciphertext));
    const date = new Date().toUTCString();
    const signedHeaders = ["(request-target)", "host", "date"];
    const canonicalLines = ["(request-target): " + method.toLowerCase() + " " + requestPath, "host: " + host, "date: " + date];
    const headers = { host, date };
    if (method !== "GET" && method !== "HEAD") {
      const contentLength = Buffer.byteLength(body, "utf8");
      const contentSha256 = crypto.createHash("sha256").update(body, "utf8").digest("base64");
      signedHeaders.push("content-type", "content-length", "x-content-sha256");
      canonicalLines.push("content-type: application/json", "content-length: " + contentLength, "x-content-sha256: " + contentSha256);
      Object.assign(headers, { "content-type": "application/json", "content-length": String(contentLength), "x-content-sha256": contentSha256 });
    }
    let signature;
    try { signature = crypto.sign("RSA-SHA256", Buffer.from(canonicalLines.join("\n")), privateKey).toString("base64"); }
    catch { throw new Error("OCI API 私钥无效，需使用未加密的 RSA PEM 私钥"); }
    const authorization = "Signature version=\"1\",keyId=\"" + tenancyOcid + "/" + row.access_key_id + "/" + fingerprint + "\",algorithm=\"rsa-sha256\",headers=\"" + signedHeaders.join(" ") + "\",signature=\"" + signature + "\"";
    const response = await fetch("https://" + host + requestPath, { method, headers: { ...headers, authorization }, body: method === "GET" || method === "HEAD" ? undefined : body });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok) {
      const message = data?.message || data?.code || "OCI " + response.status;
      writeApiLog(accountId, host, method + " " + requestPath.split("?")[0], {}, data, "失败", message);
      throw new Error(message);
    }
    writeApiLog(accountId, host, method + " " + requestPath.split("?")[0], {}, data, "成功");
    return { data, nextPage: response.headers.get("opc-next-page") || "" };
  }

  async function pages(accountId, host, pathName, query = {}) {
    const items = [];
    let page = "";
    for (let index = 0; index < 100; index += 1) {
      const params = new URLSearchParams(query);
      if (page) params.set("page", page);
      const result = await request(accountId, host, pathName + (params.size ? "?" + params.toString() : ""));
      items.push(...(Array.isArray(result.data) ? result.data : []));
      if (!result.nextPage) return items;
      page = result.nextPage;
    }
    throw new Error("OCI 分页超过 100 页，已停止读取");
  }

  async function context(accountId) {
    const row = database().prepare("SELECT credential_meta,region_id FROM cloud_accounts WHERE id=?").get(accountId);
    if (!row) throw new Error("云账号不存在");
    const { tenancyOcid } = metadata(row);
    const homeRegion = String(row.region_id || "ap-tokyo-1");
    const identityHost = "identity." + homeRegion + ".oci.oraclecloud.com";
    const compartments = await pages(accountId, identityHost, "/20160918/compartments", { compartmentId: tenancyOcid, compartmentIdInSubtree: "true", accessLevel: "ACCESSIBLE", lifecycleState: "ACTIVE" });
    const subscriptions = await pages(accountId, identityHost, "/20160918/tenancy/" + encode(tenancyOcid) + "/regionSubscriptions").catch(() => []);
    const allCompartments = [{ id: tenancyOcid, name: "Root Compartment" }, ...compartments].filter((item) => !/^ManagedCompartmentForPaaS$/i.test(String(item?.name || ""))).filter((item, index, values) => values.findIndex((candidate) => candidate.id === item.id) === index);
    const regions = [...new Set(subscriptions.filter((item) => String(item.status || "").toUpperCase() === "READY").map((item) => item.regionName).filter(Boolean))];
    return { compartments: allCompartments, regions: regions.length ? regions : [homeRegion] };
  }

  function addressList(values) { return [...new Set(values.filter(Boolean).map(String))].join(", "); }

  async function imageName(accountId, host, imageId) {
    if (!imageId) return "";
    try {
      const image = (await request(accountId, host, "/20160918/images/" + encode(imageId))).data;
      return image.displayName || [image.operatingSystem, image.operatingSystemVersion].filter(Boolean).join(" ") || imageId;
    } catch { return imageId; }
  }

  async function instance(accountId, host, item, region, compartment, shape) {
    const attachmentQuery = { compartmentId: compartment.id, instanceId: item.id };
    const [detailResult, attachmentResult] = await Promise.allSettled([request(accountId, host, "/20160918/instances/" + encode(item.id)), pages(accountId, host, "/20160918/vnicAttachments", attachmentQuery)]);
    const value = detailResult.status === "fulfilled" ? detailResult.value.data : item;
    const networkErrors = attachmentResult.status === "rejected" ? [attachmentResult.reason?.message || String(attachmentResult.reason)] : [];
    const attachments = attachmentResult.status === "fulfilled" ? attachmentResult.value : [];
    const vnicResults = await Promise.all(attachments.map(async (attachment) => {
      const publicIps = [attachment.publicIp, attachment.publicIpAddress].filter(Boolean);
      const privateIps = [attachment.privateIp, attachment.privateIpAddress].filter(Boolean);
      if (!attachment.vnicId) return { publicIps, privateIps, error: "VNIC attachment 缺少 vnicId" };
      try {
        const vnic = (await request(accountId, host, "/20160918/vnics/" + encode(attachment.vnicId))).data;
        return { publicIps: [...publicIps, vnic.publicIp, vnic.publicIpAddress].filter(Boolean), privateIps: [...privateIps, vnic.privateIp, vnic.privateIpAddress].filter(Boolean), vnic };
      } catch (error) { return { publicIps, privateIps, error: error.message || String(error) }; }
    }));
    vnicResults.forEach((result) => { if (result.error) networkErrors.push(result.error); });
    const shapeConfig = value.shapeConfig || item.shapeConfig || {};
    const memoryInGBs = shapeConfig.memoryInGBs ?? shape?.memoryInGBs ?? null;
    return {
      ...item, ...value,
      InstanceId: value.id || item.id, InstanceName: value.displayName || item.displayName || item.id, InstanceStatus: value.lifecycleState || item.lifecycleState, Status: value.lifecycleState || item.lifecycleState, InstanceType: value.shape || item.shape || "",
      Cpu: shapeConfig.ocpus ?? shape?.ocpus ?? null, Memory: memoryInGBs == null ? null : Number(memoryInGBs) * 1024,
      PublicIpAddress: addressList([...vnicResults.map((result) => result.vnic?.publicIp || result.vnic?.publicIpAddress), ...vnicResults.flatMap((result) => result.publicIps)]),
      PrivateIpAddress: addressList([...vnicResults.map((result) => result.vnic?.privateIp || result.vnic?.privateIpAddress), ...vnicResults.flatMap((result) => result.privateIps)]),
      OSName: await imageName(accountId, host, value.imageId || item.imageId), ImageId: value.imageId || item.imageId || "", CreationTime: value.timeCreated || item.timeCreated || "",
      _network_error: networkErrors.length ? [...new Set(networkErrors)].join("；") : "", _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name,
    };
  }

  async function instanceAction(accountId, region, instanceId, action) {
    if (!region || !instanceId) throw new Error("缺少 OCI 地域或实例 ID");
    const actionName = { start: "START", stop: "STOP", reboot: "SOFTRESET", forceReboot: "RESET" }[action];
    if (!actionName) throw new Error("不支持的 OCI 实例操作");
    return (await request(accountId, "iaas." + region + ".oci.oraclecloud.com", "/20160918/instances/" + encode(instanceId) + "?action=" + actionName, { method: "POST", body: "" })).data;
  }

  function dbSystem(item, region, compartment) { return { ...item, DBInstanceId: item.id, DBInstanceDescription: item.displayName || item.id, DBInstanceStatus: item.lifecycleState, Engine: item.dbSystemOptions?.storageManagement || item.databaseEdition || "Oracle Database", EngineVersion: item.dbVersion || "", ConnectionString: item.hostname || "", _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name }; }
  function zone(item, region, compartment) { return { ...item, DomainName: String(item.name || "").replace(/\.$/, ""), DomainStatus: item.lifecycleState || "ACTIVE", RecordCount: 0, ZoneId: item.id || item.name, _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name }; }
  function bucket(item, region, compartment) { return { ...item, Name: item.name, BucketName: item.name, Location: region, StorageClass: item.publicAccessType || "Standard", Acl: item.publicAccessType || "NoPublicAccess", _region_id: region, _compartment_ocid: compartment.id, _compartment_name: compartment.name }; }

  async function instanceDisks(accountId, region, instanceId, compartmentId) {
    if (!region || !instanceId || !compartmentId) return [];
    const host = "iaas." + region + ".oci.oraclecloud.com";
    const query = { compartmentId, instanceId };
    const [bootAttachments, volumeAttachments] = await Promise.all([pages(accountId, host, "/20160918/bootVolumeAttachments", query).catch(() => []), pages(accountId, host, "/20160918/volumeAttachments", query).catch(() => [])]);
    const buildDisks = async (attachments, attachmentKey, endpoint, category) => Promise.all(attachments.map(async (attachment) => {
      const id = attachment[attachmentKey];
      if (!id) return null;
      try {
        const volume = (await request(accountId, host, endpoint + encode(id))).data;
        return { DiskId: id, DiskName: volume.displayName || attachment.displayName || id, Category: category, Size: volume.sizeInGBs ?? 0, Status: volume.lifecycleState || attachment.lifecycleState || "", Device: attachment.device || "" };
      } catch { return null; }
    }));
    return [...await buildDisks(bootAttachments, "bootVolumeId", "/20160918/bootVolumes/", "启动卷"), ...await buildDisks(volumeAttachments, "volumeId", "/20160918/volumes/", "数据卷")].filter(Boolean);
  }

  async function resources(accountId, type) {
    const { compartments, regions } = await context(accountId);
    const items = []; const errors = [];
    for (const region of regions) {
      const hosts = { ecs: "iaas." + region + ".oci.oraclecloud.com", rds: "database." + region + ".oci.oraclecloud.com", domain: "dns." + region + ".oci.oraclecloud.com", oss: "objectstorage." + region + ".oci.customer-oci.com" };
      if (!hosts[type]) return { resource_type: type, items, errors: ["Oracle Cloud 暂未接入 " + type + " 资源"], fetched_at: Date.now() };
      let namespace = "";
      if (type === "oss") {
        try { namespace = String((await request(accountId, hosts.oss, "/n/")).data || ""); } catch (error) { errors.push(region + ": " + error.message); continue; }
        if (!namespace) { errors.push(region + ": 未能读取 Object Storage namespace"); continue; }
      }
      for (const compartment of compartments) {
        try {
          const values = type === "ecs" ? await pages(accountId, hosts.ecs, "/20160918/instances", { compartmentId: compartment.id }) : type === "rds" ? await pages(accountId, hosts.rds, "/20160918/dbSystems", { compartmentId: compartment.id }) : type === "domain" ? await pages(accountId, hosts.domain, "/20180115/zones", { compartmentId: compartment.id }) : await pages(accountId, hosts.oss, "/n/" + encode(namespace) + "/b/", { compartmentId: compartment.id });
          const shapes = type === "ecs" ? await pages(accountId, hosts.ecs, "/20160928/shapes", { compartmentId: compartment.id }).catch(() => []) : [];
          const normalized = type === "ecs" ? await Promise.all(values.map((item) => instance(accountId, hosts.ecs, item, region, compartment, shapes.find((shape) => shape.shape === item.shape)))) : type === "rds" ? values.map((item) => dbSystem(item, region, compartment)) : type === "domain" ? values.map((item) => zone(item, region, compartment)) : values.map((item) => bucket(item, region, compartment));
          items.push(...normalized);
        } catch (error) { errors.push(region + "/" + compartment.name + ": " + error.message); }
      }
    }
    return { resource_type: type, items, errors, fetched_at: Date.now() };
  }

  return { metadata, serializePrivateKey, resources, instanceAction, instanceDisks };
}
