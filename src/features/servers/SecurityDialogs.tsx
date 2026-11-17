import { serversClient } from "../../platform/clients";
import type { Account } from "../../shared/types";
import { SecurityGroupManager, type RuleDraft, type SecurityRule, type SecuritySnapshot } from "./SecurityGroupManager";

type DialogProps = { account: Account; onClose: () => void; onConfirm: (message: string) => Promise<boolean>; onNotice: (message: string) => void };
type ServerProps = DialogProps & { regionId: string; instanceId: string };
type RawRule = Record<string, unknown>;
const text = (value: unknown) => value == null ? "" : String(value);
const ruleFields = (rule: RuleDraft) => ({ protocol: rule.protocol, ports: rule.ports, source: rule.source, description: rule.description, policy: rule.policy, priority: rule.priority });

function normalize(raw: RawRule, index: number, light = false): SecurityRule {
  const source = text(raw.SourceCidrIp);
  const sourceGroup = text(raw.SourceGroupId);
  const policy = text(raw.Policy || "accept").toLowerCase();
  return {
    key: text(raw.SecurityGroupRuleId || raw.RuleId) || `${text(raw.Direction)}-${text(raw.IpProtocol)}-${text(raw.PortRange)}-${source}-${sourceGroup}-${index}`,
    direction: text(raw.Direction || "ingress").toLowerCase(), protocol: text(raw.IpProtocol).toLowerCase(),
    ports: text(raw.PortRange), source, sourceGroup, description: text(raw.Description),
    policy: ["accept", "allow"].includes(policy) ? "accept" : "drop",
    priority: typeof raw.Priority === "number" ? raw.Priority : light ? index + 1 : 1,
    updatedAt: text(raw.UpdateTime || raw.UpdatedAt), readOnly: Boolean(raw.ReadOnly) || !source, raw,
  };
}

export function SecurityGroupDialog(props: ServerProps) {
  const { account, regionId, instanceId } = props;
  const provider = account.cloud_type === "volcengine" ? "volcengine" : account.cloud_type === "tencent" ? "tencent" : account.cloud_type === "baidu" ? "baidu" : "aliyun";
  const label = { volcengine: "火山引擎 ECS", tencent: "腾讯云 CVM", baidu: "百度智能云 BCC", aliyun: "阿里云 ECS" }[provider];
  return <SecurityGroupManager {...props} resourceKey={`${account.id}:${regionId}:${instanceId}`} adapter={{
    label, scope: "规则变更会影响所有绑定该安全组的服务器。", ipv6: provider === "volcengine", createDeny: ["aliyun", "tencent", "volcengine"].includes(provider), references: provider === "volcengine" || provider === "aliyun", protocols: provider === "baidu" ? ["tcp", "udp", "icmp", "all"] : provider === "volcengine" ? ["tcp", "udp", "icmp", "icmpv6", "gre", "all"] : ["tcp", "udp", "icmp", "gre", "all"],
    async load(group) {
      const result = await serversClient.listSecurityGroups<{ groups: RawRule[]; selectedSecurityGroupId: string; rules: RawRule[]; sgVersion?: number }>(provider, { id: account.id, regionId, instanceId, securityGroupId: group || null });
      return { groups: (result.groups || []).map(group => ({ id: text(group.SecurityGroupId), name: text(group.SecurityGroupName || group.SecurityGroupId), description: text(group.Description), nicType: text(group.NicType) })), selected: result.selectedSecurityGroupId || "", rules: (result.rules || []).map((raw, index) => {
        const source = text(raw.SourceCidrIp || raw.SourceGroupId || raw.SourcePrefixListId || (provider === "volcengine" ? raw.PrefixListId : ""));
        const ruleId = text(raw.SecurityGroupRuleId || raw.RuleId || raw.securityGroupRuleId || raw.ruleId || raw.id);
        const normalized = normalize(raw, index);
        return { ...normalized, ...(provider === "baidu" && ruleId ? { key: ruleId, raw: { ...raw, SecurityGroupRuleId: ruleId } } : {}), source, ...(provider === "tencent" ? { priority: Number(raw.Priority ?? 0) + 1 } : {}), readOnly: Boolean(raw.ReadOnly) || (!source && !(provider === "tencent" && raw.SourceGroupId)) || (provider === "baidu" && !ruleId) };
      }), version: result.sgVersion };
    },
    ...(["volcengine", "aliyun", "tencent"].includes(provider) ? {
      editPolicy: true, editPriority: provider !== "tencent",
      canEdit: (rule: SecurityRule) => !rule.readOnly && (provider === "tencent" ? rule.raw.Priority != null && !rule.sourceGroup : Boolean(rule.raw.SecurityGroupRuleId)),
      update(original: SecurityRule, updated: RuleDraft, snapshot: SecuritySnapshot) {
        if (provider === "volcengine") return serversClient.updateVolcSecurityGroup({ id: account.id, regionId, instanceId, securityGroupId: snapshot.selected, securityGroupRuleId: text(original.raw.SecurityGroupRuleId), original: ruleFields(original), updated: ruleFields(updated) });
        if (provider === "aliyun") return serversClient.updateSecurityGroup(provider, { id: account.id, regionId, securityGroupId: snapshot.selected, securityGroupRuleId: text(original.raw.SecurityGroupRuleId), original: ruleFields(original), updated: ruleFields(updated) });
        return serversClient.updateSecurityGroup("tencent", { id: account.id, regionId, securityGroupId: snapshot.selected, priority: Number(original.raw.Priority ?? 0), ipProtocol: updated.protocol, portRange: updated.ports, sourceCidrIp: updated.source, description: updated.description || null, policy: updated.policy });
      },
    } : {}),
    ...(provider === "baidu" ? {
      groupReferences: true,
      policyHint: "百度智能云普通安全组为纯白名单，仅支持允许策略，无优先级；如需拒绝策略请改用企业安全组。",
      priorityHint: "百度智能云普通安全组没有优先级，命中任意一条允许规则即放行。",
      canEdit: (rule: SecurityRule) => !rule.readOnly && Boolean(rule.raw.SecurityGroupRuleId),
      update(original: SecurityRule, updated: RuleDraft, snapshot: SecuritySnapshot) {
        return serversClient.updateSecurityGroup("baidu", { id: account.id, regionId, securityGroupId: snapshot.selected, securityGroupRuleId: text(original.raw.SecurityGroupRuleId), original: ruleFields(original), updated: ruleFields(updated), sgVersion: snapshot.version ?? null });
      },
    } : {}),
    create(draft: RuleDraft, snapshot: SecuritySnapshot) {
      return serversClient.mutateSecurityGroup(provider, "authorize", { id: account.id, regionId, instanceId, securityGroupId: snapshot.selected, ipProtocol: draft.protocol, portRange: draft.ports, sourceCidrIp: draft.source, description: draft.description || null, ...(["volcengine", "aliyun", "tencent"].includes(provider) ? { policy: draft.policy, priority: draft.priority } : {}), nicType: snapshot.groups.find(group => group.id === snapshot.selected)?.nicType || null, sgVersion: snapshot.version ?? null });
    },
    remove(rule, snapshot) {
      return serversClient.mutateSecurityGroup(provider, "revoke", { id: account.id, regionId, instanceId, securityGroupId: snapshot.selected, ipProtocol: text(rule.raw.IpProtocol), portRange: rule.ports, sourceCidrIp: rule.source, policy: text(rule.raw.Policy || "accept"), priority: Number(rule.raw.Priority ?? 1), nicType: rule.raw.NicType || snapshot.groups.find(group => group.id === snapshot.selected)?.nicType || null, securityGroupRuleId: rule.raw.SecurityGroupRuleId || null, sgVersion: snapshot.version ?? null });
    },
  }} />;
}

export function LightFirewallDialog(props: ServerProps) {
  const { account, regionId, instanceId } = props;
  const label = account.cloud_type === "tencent" ? "腾讯云 Lighthouse" : account.cloud_type === "jdcloud" ? "京东云轻量应用服务器" : "阿里云轻量应用服务器";
  return <SecurityGroupManager {...props} resourceKey={`${account.id}:${regionId}:${instanceId}:light`} adapter={{
    label, scope: account.cloud_type === "jdcloud" ? "仅管理当前轻量服务器的 TCP/UDP 放行规则；京东云接口不支持拒绝策略及 ICMP/ALL 协议，规则修改通过新建后删除旧规则完成。" : account.cloud_type === "tencent" ? "支持 TCP、UDP、ICMP、ICMPv6、ALL 及允许/拒绝策略；IPv6 来源按协议映射。修改操作仅支持调整描述，预置无来源规则保持只读。" : account.cloud_type === "aliyun" ? "仅管理当前轻量服务器的 TCP/UDP/ICMP 放行规则；支持原位修改端口、来源和备注。" : "仅管理当前轻量服务器的访问规则，变更不会影响其他服务器。", ipv6: account.cloud_type === "jdcloud" || account.cloud_type === "tencent", createDeny: account.cloud_type === "tencent", descriptionOnlyEdit: account.cloud_type === "tencent", protocols: account.cloud_type === "tencent" ? ["tcp", "udp", "icmp", "icmpv6", "all"] : account.cloud_type === "aliyun" ? ["tcp", "udp", "icmp"] : ["tcp", "udp"],
    async load() {
      const result = await serversClient.listLightFirewall<{ rules: RawRule[]; firewallVersion?: number }>({ id: account.id, regionId, instanceId });
      return { groups: [{ id: instanceId, name: "当前服务器" }], selected: instanceId, rules: (result.rules || []).map((raw, index) => normalize(raw, index, true)), version: result.firewallVersion };
    },
    create(draft, snapshot) {
      return serversClient.mutateLightFirewall("create", { id: account.id, regionId, instanceId, ipProtocol: draft.protocol, portRange: draft.ports, sourceCidrIp: draft.source, description: draft.description || null, policy: account.cloud_type === "tencent" ? draft.policy : "accept", firewallVersion: snapshot.version ?? null });
    },
    ...(account.cloud_type === "tencent" ? {
      update(original: SecurityRule, updated: RuleDraft, snapshot: SecuritySnapshot) {
        return serversClient.mutateLightFirewall("update-description", { id: account.id, regionId, instanceId, firewallRule: original.raw.FirewallRule, description: updated.description, firewallVersion: snapshot.version ?? null });
      },
      canEdit: (rule: SecurityRule) => Boolean(rule.raw.FirewallRule && rule.source),
    } : {}),
    ...(account.cloud_type === "aliyun" ? {
      canEdit: (rule: SecurityRule) => !rule.readOnly && Boolean(rule.raw.RuleId && rule.source),
      update(original: SecurityRule, updated: RuleDraft) {
        return serversClient.mutateLightFirewall("modify", { id: account.id, regionId, instanceId, ruleId: text(original.raw.RuleId), original: ruleFields(original), updated: ruleFields(updated) });
      },
    } : {}),
    ...(account.cloud_type === "jdcloud" ? {
      async update(original: SecurityRule, updated: RuleDraft) {
        if (updated.policy !== original.policy || updated.priority !== original.priority) throw new Error("京东云轻量接口不支持修改策略或优先级");
        const created: unknown = await serversClient.mutateLightFirewall("create", { id: account.id, regionId, instanceId, ipProtocol: updated.protocol, portRange: updated.ports, sourceCidrIp: updated.source, description: updated.description || null });
        const response = created as RawRule | null;
        const result = response?.result as RawRule | undefined;
        const createdRuleId = typeof created === "string" ? created : text(response?.ruleId || (result?.firewallRule as RawRule | undefined)?.ruleId || result?.ruleId);
        try {
          await serversClient.mutateLightFirewall("delete", { id: account.id, regionId, instanceId, ruleId: original.raw.RuleId || null });
        } catch (reason) {
          if (createdRuleId) {
            try { await serversClient.mutateLightFirewall("delete", { id: account.id, regionId, instanceId, ruleId: createdRuleId }); }
            catch { throw new Error(`删除原规则失败；新规则也未能自动回滚（${text(reason)}），请检查规则列表，避免重复规则。`); }
          }
          throw reason;
        }
      },
    } : {}),
    remove(rule, snapshot) {
      return serversClient.mutateLightFirewall("delete", { id: account.id, regionId, instanceId, ruleId: rule.raw.RuleId || null, firewallRule: rule.raw.FirewallRule || null, firewallVersion: snapshot.version ?? null });
    },
  }} />;
}

export function OracleSecurityGroupDialog(props: ServerProps & { compartmentId: string }) {
  const { account, regionId, instanceId, compartmentId } = props;
  return <SecurityGroupManager {...props} resourceKey={`${account.id}:${regionId}:${instanceId}:oci-nsg`} adapter={{
    label: "Oracle Cloud 实例",
    scope: "网络安全组（NSG）按实例网卡生效；实例未绑定 NSG 时展示所在子网的安全列表，安全列表的规则对该子网内所有实例生效。规则都是有状态的允许规则，没有优先级。",
    protocols: ["tcp", "udp", "icmp", "all"],
    ipv6: true,
    policyHint: "Oracle Cloud 网络安全组与安全列表都只有允许规则，不支持拒绝；如需阻断请在云防火墙中配置。",
    priorityHint: "Oracle Cloud 安全组没有优先级，命中任意一条允许规则即放行。",
    canCreate: snapshot => Boolean(snapshot.selected),
    async load(group) {
      const result = await serversClient.listSecurityGroups<{ groups: RawRule[]; selectedSecurityGroupId: string; rules: RawRule[] }>("oracle", { id: account.id, regionId, instanceId, securityGroupId: group || null, compartmentId });
      return {
        groups: (result.groups || []).map(value => ({ id: text(value.SecurityGroupId), name: text(value.SecurityGroupName || value.SecurityGroupId), description: text(value.Description) })),
        selected: result.selectedSecurityGroupId || "",
        rules: (result.rules || []).map((raw, index) => {
          const source = text(raw.SourceCidrIp || raw.SourceGroupId);
          const ruleId = text(raw.RuleId);
          // 安全列表规则没有 OCID，用 RuleIndex 定位；没有来源（组引用）的规则仍保持只读。
          const identifiable = Boolean(ruleId) || typeof raw.RuleIndex === "number";
          return { ...normalize(raw, index), source, raw: { ...raw, RuleId: ruleId }, readOnly: Boolean(raw.ReadOnly) || !identifiable || !text(raw.SourceCidrIp) };
        }),
      };
    },
    canEdit: (rule: SecurityRule) => !rule.readOnly && (text(rule.raw.RuleId).startsWith("ocid1.securityrule.") || typeof rule.raw.RuleIndex === "number"),
    update(original: SecurityRule, updated: RuleDraft, snapshot: SecuritySnapshot) {
      return serversClient.updateSecurityGroup("oracle", { id: account.id, regionId, securityGroupId: snapshot.selected, securityGroupRuleId: text(original.raw.RuleId), ruleIndex: typeof original.raw.RuleIndex === "number" ? original.raw.RuleIndex : null, original: ruleFields(original), updated: ruleFields(updated), isStateless: Boolean(original.raw.IsStateless) });
    },
    create(draft: RuleDraft, snapshot: SecuritySnapshot) {
      return serversClient.mutateSecurityGroup("oracle", "authorize", { id: account.id, regionId, instanceId, compartmentId, securityGroupId: snapshot.selected, ipProtocol: draft.protocol, portRange: draft.ports, sourceCidrIp: draft.source, description: draft.description || null });
    },
    remove(rule, snapshot) {
      return serversClient.mutateSecurityGroup("oracle", "revoke", { id: account.id, regionId, instanceId, compartmentId, securityGroupId: snapshot.selected, securityGroupRuleId: text(rule.raw.RuleId), ruleIndex: typeof rule.raw.RuleIndex === "number" ? rule.raw.RuleIndex : null, original: ruleFields(rule) });
    },
  }} />;
}

export function VultrFirewallDialog(props: DialogProps & { firewallGroupId: string }) {
  const { account, firewallGroupId } = props;
  return <SecurityGroupManager {...props} resourceKey={`${account.id}:${firewallGroupId}:vultr`} adapter={{
    label: "Vultr", scope: "规则变更会影响所有绑定该安全组的服务器，当前接口仅接入 IPv4 入方向规则。", protocols: ["tcp", "udp"],
    async load() {
      const result = await serversClient.listVultrFirewall<{ rules: RawRule[] }>({ id: account.id, firewallGroupId });
      return { groups: [{ id: firewallGroupId, name: "当前安全组" }], selected: firewallGroupId, rules: (result.rules || []).map((raw, index) => ({ ...normalize(raw, index, true), readOnly: !raw.RuleId || !raw.SourceCidrIp })) };
    },
    create(draft) {
      if (draft.source.includes(":")) return Promise.reject(new Error("Vultr 当前接口仅支持 IPv4 来源"));
      const [start, end] = draft.ports.split("/");
      return serversClient.mutateVultrFirewall("create", { id: account.id, firewallGroupId, ipProtocol: draft.protocol, port: start === end ? start : `${start}-${end}`, sourceCidrIp: draft.source, description: draft.description || null });
    },
    remove(rule) { return serversClient.mutateVultrFirewall("delete", { id: account.id, firewallGroupId, ruleId: rule.raw.RuleId }); },
  }} />;
}
