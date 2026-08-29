import { readBody, send } from "../core/http.mjs";

export async function handleInstanceActionRoutes(req, res, url, services) {
  const {
    crypto, database, rpc, tencent, baidu, vultr, securityGroupRuleParams,
    aliyunSecurityGroupDetails, baiduSecurityGroupDetails, baiduSecurityGroupRuleInput,
    baiduBccAction, oracleInstanceAction, updateCachedServerName,
    lightFirewallDetails, lightFirewallRuleInput, jdcloudFirewallMutation, jdcloudInstanceAction,
  } = services;

  if (req.method === "GET" && url.pathname === "/api/aliyun-security-groups") {
    const id = Number(url.searchParams.get("id"));
    const region = String(url.searchParams.get("region") || "");
    const instanceId = String(url.searchParams.get("instance") || "");
    const securityGroupId = String(url.searchParams.get("securityGroupId") || "");
    send(res, 200, await aliyunSecurityGroupDetails(id, region, instanceId, securityGroupId));
    return true;
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
      send(res, 200, await rpc(id, `ecs.${region}.aliyuncs.com`, "2014-05-26", "AuthorizeSecurityGroup", params));
      return true;
    }
    if (action === "revoke") {
      send(res, 200, await rpc(id, `ecs.${region}.aliyuncs.com`, "2014-05-26", "RevokeSecurityGroup", params));
      return true;
    }
    send(res, 400, { error: "不支持的安全组规则操作" });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/tencent-security-groups") {
    const id = Number(url.searchParams.get("id"));
    const region = String(url.searchParams.get("region") || "");
    const instanceId = String(url.searchParams.get("instance") || "");
    const securityGroupId = String(url.searchParams.get("securityGroupId") || "");
    send(res, 200, await tencent.securityGroupDetails(id, region, instanceId, securityGroupId));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/tencent-security-group-rules") {
    const payload = JSON.parse(await readBody(req));
    const id = Number(payload.id);
    const region = String(payload.regionId || "");
    const securityGroupId = String(payload.securityGroupId || "");
    if (!region || !securityGroupId) { send(res, 400, { error: "缺少安全组地域或安全组 ID" }); return true; }
    const action = String(payload.action || "");
    if (action === "authorize") {
      const policy = tencent.securityGroupPolicy({ ipProtocol: payload.ipProtocol, portRange: payload.portRange, sourceCidrIp: payload.sourceCidrIp, description: payload.description });
      send(res, 200, await tencent.request(id, "cvm", "2017-03-12", "AuthorizeSecurityGroupIngress", { SecurityGroupId: securityGroupId, SecurityGroupPolicySet: [policy] }, region));
      return true;
    }
    if (action === "revoke") {
      const policyIndex = Number(payload.priority);
      if (!Number.isInteger(policyIndex) || policyIndex < 0) { send(res, 400, { error: "缺少有效的安全组规则索引" }); return true; }
      send(res, 200, await tencent.request(id, "cvm", "2017-03-12", "RevokeSecurityGroupIngress", { SecurityGroupId: securityGroupId, SecurityGroupPolicySet: [{ PolicyIndex: policyIndex }] }, region));
      return true;
    }
    send(res, 400, { error: "不支持的安全组规则操作" });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/baidu-security-groups") {
    const id = Number(url.searchParams.get("id"));
    const region = String(url.searchParams.get("region") || "");
    const instanceId = String(url.searchParams.get("instance") || "");
    const securityGroupId = String(url.searchParams.get("securityGroupId") || "");
    send(res, 200, await baiduSecurityGroupDetails(id, region, instanceId, securityGroupId));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/baidu-security-group-rules") {
    const payload = JSON.parse(await readBody(req));
    const id = Number(payload.id);
    const region = String(payload.regionId || "");
    const securityGroupId = String(payload.securityGroupId || "");
    if (!region || !securityGroupId) { send(res, 400, { error: "缺少安全组地域或安全组 ID" }); return true; }
    const host = `bcc.${region}.baidubce.com`;
    const action = String(payload.action || "");
    if (action === "authorize") {
      const query = { authorizeRule: "", clientToken: crypto.randomUUID() };
      if (Number.isInteger(Number(payload.sgVersion))) query.sgVersion = Number(payload.sgVersion);
      const { data } = await baidu.request(id, host, `/v2/securityGroup/${encodeURIComponent(securityGroupId)}`, query, { method: "PUT", body: { rule: baiduSecurityGroupRuleInput(payload) }, includeEmptyQuery: true });
      send(res, 200, data);
      return true;
    }
    if (action === "revoke") {
      const ruleId = String(payload.securityGroupRuleId || "").trim();
      if (!ruleId) { send(res, 400, { error: "缺少百度云安全组规则 ID" }); return true; }
      const query = { clientToken: crypto.randomUUID() };
      if (Number.isInteger(Number(payload.sgVersion))) query.sgVersion = Number(payload.sgVersion);
      const { data } = await baidu.request(id, host, `/v2/securityGroup/rule/${encodeURIComponent(ruleId)}`, query, { method: "DELETE" });
      send(res, 200, data);
      return true;
    }
    send(res, 400, { error: "不支持的百度云安全组规则操作" });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/vultr-firewall-rules") {
    const id = Number(url.searchParams.get("id"));
    const firewallGroupId = String(url.searchParams.get("firewallGroupId") || "").trim();
    if (!firewallGroupId) { send(res, 400, { error: "缺少 Vultr 防火墙组 ID" }); return true; }
    const data = await vultr.request(id, `firewalls/${encodeURIComponent(firewallGroupId)}/rules`);
    send(res, 200, { rules: vultr.firewallRules(data) });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/vultr-firewall-rules") {
    const payload = JSON.parse(await readBody(req));
    const id = Number(payload.id);
    const firewallGroupId = String(payload.firewallGroupId || "").trim();
    const action = String(payload.action || "").trim();
    if (!firewallGroupId) { send(res, 400, { error: "缺少 Vultr 防火墙组 ID" }); return true; }
    const pathName = `firewalls/${encodeURIComponent(firewallGroupId)}/rules`;
    if (action === "create") { send(res, 200, await vultr.request(id, pathName, {}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(vultr.firewallRuleInput(payload)) })); return true; }
    if (action === "delete") {
      const ruleId = String(payload.ruleId || "").trim();
      if (!ruleId) { send(res, 400, { error: "缺少 Vultr 防火墙规则 ID" }); return true; }
      send(res, 200, await vultr.request(id, `${pathName}/${encodeURIComponent(ruleId)}`, {}, { method: "DELETE" }));
      return true;
    }
    send(res, 400, { error: "不支持的 Vultr 防火墙规则操作" });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/vultr-instance-action") {
    const payload = JSON.parse(await readBody(req));
    const id = Number(payload.id);
    const instanceId = String(payload.instanceId || "").trim();
    const action = String(payload.action || "").trim();
    if (!instanceId) { send(res, 400, { error: "缺少 Vultr 实例 ID" }); return true; }
    if (!new Set(["start", "stop", "reboot"]).has(action)) { send(res, 400, { error: "不支持的 Vultr 服务器操作" }); return true; }
    const endpoint = action === "stop" ? "halt" : action;
    send(res, 200, await vultr.request(id, `instances/${encodeURIComponent(instanceId)}/${endpoint}`, {}, { method: "POST" }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/vultr-instance-manage") {
    const payload = JSON.parse(await readBody(req));
    const id = Number(payload.id);
    const instanceId = String(payload.instanceId || "").trim();
    const action = String(payload.action || "").trim();
    const value = String(payload.value || "").trim();
    if (!instanceId) { send(res, 400, { error: "缺少 Vultr 实例 ID" }); return true; }
    const updatePath = `instances/${encodeURIComponent(instanceId)}`;
    const actions = {
      snapshot: { path: "snapshots", method: "POST", body: { instance_id: instanceId, description: value } },
      label: value ? { path: updatePath, method: "PATCH", body: { label: value } } : null,
      tags: { path: updatePath, method: "PATCH", body: { tags: value.split(",").map((tag) => tag.trim()).filter(Boolean) } },
      enable_backups: { path: updatePath, method: "PATCH", body: { backups: "enabled" } }, disable_backups: { path: updatePath, method: "PATCH", body: { backups: "disabled" } },
      enable_ddos: { path: updatePath, method: "PATCH", body: { ddos_protection: true } }, disable_ddos: { path: updatePath, method: "PATCH", body: { ddos_protection: false } },
      enable_ipv6: { path: updatePath, method: "PATCH", body: { enable_ipv6: true } }, firewall: value ? { path: updatePath, method: "PATCH", body: { firewall_group_id: value } } : null,
    };
    const request = actions[action];
    if (!request) { send(res, 400, { error: "不支持的 Vultr 实例管理操作，或缺少必要参数" }); return true; }
    send(res, 200, await vultr.request(id, request.path, {}, { method: request.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/bcc-action") {
    const payload = JSON.parse(await readBody(req));
    const id = Number(payload.id);
    const region = String(payload.regionId || "");
    const instanceId = String(payload.instanceId || "");
    const action = String(payload.action || "");
    const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
    if (!account) { send(res, 404, { error: "云账号不存在" }); return true; }
    if (account.cloud_type !== "baidu") { send(res, 400, { error: "当前账号不是百度智能云账号" }); return true; }
    send(res, 200, await baiduBccAction(id, region, instanceId, action, Boolean(payload.forceStop)));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/oracle-instance-action") {
    const payload = JSON.parse(await readBody(req));
    const id = Number(payload.id);
    const region = String(payload.regionId || "");
    const instanceId = String(payload.instanceId || "");
    const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
    if (!account) { send(res, 404, { error: "云账号不存在" }); return true; }
    if (account.cloud_type !== "oracle") { send(res, 400, { error: "当前账号不是 Oracle Cloud 账号" }); return true; }
    send(res, 200, await oracleInstanceAction(id, region, instanceId, String(payload.action || "")));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/server-name") {
    const payload = JSON.parse(await readBody(req));
    const id = Number(payload.id);
    const region = String(payload.regionId || "").trim();
    const instanceId = String(payload.instanceId || "").trim();
    const instanceName = String(payload.instanceName || "").trim();
    if (!region || !instanceId) { send(res, 400, { error: "缺少服务器地域或实例 ID" }); return true; }
    if (!instanceName) { send(res, 400, { error: "服务器名称不能为空" }); return true; }
    if (Buffer.byteLength(instanceName, "utf8") > 128) { send(res, 400, { error: "服务器名称不能超过 128 个字节" }); return true; }
    const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
    if (!account) { send(res, 404, { error: "云账号不存在" }); return true; }
    const data = account.cloud_type === "tencent"
      ? await tencent.request(id, "cvm", "2017-03-12", "ModifyInstancesAttribute", { InstanceIds: [instanceId], InstanceName: instanceName }, region)
      : await rpc(id, `ecs.${region}.aliyuncs.com`, "2014-05-26", "ModifyInstanceAttribute", { RegionId: region, InstanceId: instanceId, InstanceName: instanceName });
    updateCachedServerName(id, instanceId, instanceName);
    send(res, 200, data);
    return true;
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
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
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
          return send(res, 200, await tencent.request(id, "lighthouse", "2020-03-24", "CreateFirewallRules", request, region));
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
          return send(res, 200, await tencent.request(id, "lighthouse", "2020-03-24", "DeleteFirewallRules", request, region));
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
      const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
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
      return send(res, 200, await tencent.request(id, "lighthouse", "2020-03-24", actionName, request, region));
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
      return send(res, 200, await tencent.request(id, "cvm", "2017-03-12", actionName, request, region));
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
  return false;
}
