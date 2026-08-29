export function createInstanceActionService({ database, rpc, arr, tencent, baidu, jdcloudRequest }) {
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
    const { data } = await baidu.request(id, host, "/v2/securityGroup", { instanceId, maxKeys: 1000 });
    const groups = arr(data, ["securityGroups"]).map((group) => ({ SecurityGroupId: String(group.id || ""), SecurityGroupName: String(group.name || ""), Description: String(group.desc || ""), VpcId: String(group.vpcId || ""), NicType: "" }));
    const selectedSecurityGroupId = groups.some((group) => group.SecurityGroupId === securityGroupId) ? securityGroupId : groups[0]?.SecurityGroupId || "";
    if (!selectedSecurityGroupId) return { groups, selectedSecurityGroupId, rules: [] };
    const { data: detail } = await baidu.request(id, host, `/v2/securityGroup/${encodeURIComponent(selectedSecurityGroupId)}`);
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

  async function lightFirewallDetails(id, regionId, instanceId) {
    if (!regionId || !instanceId) throw new Error("缺少轻量服务器地域或实例 ID");
    const account = database().prepare("SELECT cloud_type FROM cloud_accounts WHERE id=?").get(id);
    if (!account) throw new Error("云账号不存在");
    if (account.cloud_type === "aliyun") {
      const data = await rpc(id, `swas.${regionId}.aliyuncs.com`, "2020-06-01", "ListFirewallRules", { RegionId: regionId, InstanceId: instanceId, PageNumber: "1", PageSize: "100" });
      const firewallRules = Array.isArray(data.FirewallRules) ? data.FirewallRules : arr(data, ["FirewallRules", "FirewallRule"]);
      return { rules: firewallRules.filter((rule) => String(rule.Policy || "accept").toLowerCase() === "accept").map((rule) => ({ RuleId: String(rule.RuleId || ""), IpProtocol: String(rule.RuleProtocol || ""), PortRange: String(rule.Port || ""), SourceCidrIp: String(rule.SourceCidrIp || ""), Policy: String(rule.Policy || "accept"), Description: String(rule.Remark || "") })) };
    }
    if (account.cloud_type === "tencent") {
      const data = await tencent.request(id, "lighthouse", "2020-03-24", "DescribeFirewallRules", { InstanceId: instanceId, Limit: 100 }, regionId);
      return { rules: arr(data, ["FirewallRuleSet"]).filter((rule) => String(rule.Action || "ACCEPT").toUpperCase() === "ACCEPT").map((rule) => { const firewallRule = { Protocol: String(rule.Protocol || ""), Port: String(rule.Port || ""), CidrBlock: String(rule.CidrBlock || ""), Action: String(rule.Action || "ACCEPT"), FirewallRuleDescription: String(rule.FirewallRuleDescription || "") }; return { RuleId: "", IpProtocol: firewallRule.Protocol, PortRange: tencent.lighthousePort(firewallRule.Port), SourceCidrIp: firewallRule.CidrBlock, Policy: firewallRule.Action, Description: firewallRule.FirewallRuleDescription, FirewallRule: firewallRule }; }), firewallVersion: data.FirewallVersion };
    }
    if (account.cloud_type === "jdcloud") {
      const data = await jdcloudRequest(id, "lavm", regionId, `/v1/regions/${encodeURIComponent(regionId)}/firewallRule`, { instanceId, pageSize: 100, pageNumber: 1 });
      return { rules: arr(data?.result, ["firewallRules"]).map((rule) => ({ RuleId: String(rule.ruleId || ""), IpProtocol: String(rule.ruleProtocol || ""), PortRange: String(rule.port || ""), SourceCidrIp: String(rule.sourceAddress || ""), Policy: "accept", Description: String(rule.remark || "") })) };
    }
    throw new Error("当前云类型暂不支持轻量服务器防火墙管理");
  }

  return { securityGroupRuleParams, aliyunSecurityGroupDetails, baiduSecurityGroupDetails, baiduSecurityGroupRuleInput, lightFirewallDetails, lightFirewallRuleInput };
}
