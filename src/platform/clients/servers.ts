import type { ManagedHost, ManagedHostDraft } from "../../shared/types";
import { invokeOrWeb, jsonRequest, nativeOnly, queryPath } from "./base";

export type CloudServerProvider = "aliyun" | "tencent" | "oracle" | "baidu" | "vultr";
export type InstanceAction = "start" | "stop" | "reboot";

const securityGroupContracts = {
  aliyun: {
    list: "list_aliyun_security_groups",
    authorize: "authorize_aliyun_security_group_rule",
    revoke: "revoke_aliyun_security_group_rule",
    path: "/api/aliyun-security-groups",
    rulesPath: "/api/aliyun-security-group-rules",
  },
  tencent: {
    list: "list_tencent_security_groups",
    authorize: "authorize_tencent_security_group_rule",
    revoke: "revoke_tencent_security_group_rule",
    path: "/api/tencent-security-groups",
    rulesPath: "/api/tencent-security-group-rules",
  },
  baidu: {
    list: "list_baidu_security_groups",
    authorize: "authorize_baidu_security_group_rule",
    revoke: "revoke_baidu_security_group_rule",
    path: "/api/baidu-security-groups",
    rulesPath: "/api/baidu-security-group-rules",
  },
} as const;

function providerAction(provider: Exclude<CloudServerProvider, "aliyun">, payload: Record<string, unknown>): Promise<void> {
  const command = {
    tencent: payload.action === "reboot" ? "cvm_instance_reboot" : "cvm_instance_action",
    oracle: "oracle_instance_action",
    baidu: "baidu_instance_action",
    vultr: "vultr_instance_action",
  }[provider];
  const path = {
    tencent: "/api/cvm-action",
    oracle: "/api/oracle-instance-action",
    baidu: "/api/bcc-action",
    vultr: "/api/vultr-instance-action",
  }[provider];
  return invokeOrWeb(command, payload, { path, init: jsonRequest("POST", payload) });
}

export const serversClient = {
  listManaged(): Promise<ManagedHost[]> {
    return nativeOnly("list_managed_hosts");
  },
  saveManaged(input: ManagedHostDraft): Promise<ManagedHost> {
    return nativeOnly("save_managed_host", { input });
  },
  probeManaged(id: number): Promise<ManagedHost> {
    return nativeOnly("probe_managed_host", { id });
  },
  removeManaged(id: number): Promise<void> {
    return nativeOnly("delete_managed_host", { id });
  },
  exportManaged(): Promise<string> {
    return nativeOnly("export_managed_hosts_file");
  },
  importManaged(hosts: unknown[]): Promise<number> {
    return nativeOnly("import_managed_hosts", { hosts });
  },
  launchManagedRdp(id: number): Promise<void> {
    return nativeOnly("launch_managed_host_rdp", { id });
  },

  swasAction(payload: { id: number; regionId: string; instanceId: string; action: InstanceAction; forceStop?: boolean }): Promise<void> {
    return invokeOrWeb("swas_instance_action", payload, { path: "/api/swas-action", init: jsonRequest("POST", payload) });
  },
  providerAction,
  aliyunAction(payload: { id: number; regionId: string; instanceId: string; action: InstanceAction; forceStop?: boolean }, allowPreview = false): Promise<void> {
    if (payload.action === "reboot") return nativeOnly("reboot_instance", { id: payload.id, regionId: payload.regionId, instanceId: payload.instanceId, forceStop: payload.forceStop || false });
    if (!allowPreview) return nativeOnly(payload.action === "start" ? "start_instance" : "stop_instance", { id: payload.id, regionId: payload.regionId, instanceId: payload.instanceId });
    return invokeOrWeb(payload.action === "start" ? "start_instance" : "stop_instance", { id: payload.id, regionId: payload.regionId, instanceId: payload.instanceId }, {
      path: "/api/ecs-action",
      init: jsonRequest("POST", payload),
    });
  },
  rename(payload: { id: number; regionId: string; instanceId: string; instanceName: string }): Promise<void> {
    return invokeOrWeb("rename_server", payload, { path: "/api/server-name", init: jsonRequest("POST", payload) });
  },
  instanceStatus(payload: { id: number; regionId: string; instanceId: string }): Promise<void> {
    return nativeOnly("instance_status", payload);
  },
  vultrManage(payload: Record<string, unknown>): Promise<void> {
    return invokeOrWeb("vultr_instance_manage", payload, { path: "/api/vultr-instance-manage", init: jsonRequest("POST", payload) });
  },
  listDisks(accountId: number, regionId: string, instanceId: string, compartment = ""): Promise<Record<string, unknown>[]> {
    return invokeOrWeb("list_instance_disks", { id: accountId, regionId, instanceId, compartmentOcid: compartment }, {
      path: queryPath("/api/instance-disks", { id: accountId, region: regionId, instance: instanceId, compartment }),
    });
  },

  listSecurityGroups<T>(provider: "aliyun" | "tencent" | "baidu", payload: { id: number; regionId: string; instanceId: string; securityGroupId?: string | null }): Promise<T> {
    const contract = securityGroupContracts[provider];
    return invokeOrWeb(contract.list, payload, { path: queryPath(contract.path, { id: payload.id, region: payload.regionId, instance: payload.instanceId, securityGroupId: payload.securityGroupId }) });
  },
  mutateSecurityGroup(provider: "aliyun" | "tencent" | "baidu", action: "authorize" | "revoke", payload: Record<string, unknown>): Promise<void> {
    const contract = securityGroupContracts[provider];
    return invokeOrWeb(contract[action], payload, {
      path: contract.rulesPath,
      init: jsonRequest("POST", { ...payload, action }),
    });
  },
  listLightFirewall<T>(payload: { id: number; regionId: string; instanceId: string }): Promise<T> {
    return invokeOrWeb("list_light_firewall_rules", payload, { path: queryPath("/api/light-firewall-rules", { id: payload.id, region: payload.regionId, instance: payload.instanceId }) });
  },
  mutateLightFirewall(action: "create" | "delete", payload: Record<string, unknown>): Promise<void> {
    const command = action === "create" ? "create_light_firewall_rule" : "delete_light_firewall_rule";
    return invokeOrWeb(command, payload, { path: "/api/light-firewall-rules", init: jsonRequest("POST", { ...payload, action }) });
  },
  listVultrFirewall<T>(payload: { id: number; firewallGroupId: string }): Promise<T> {
    return invokeOrWeb("list_vultr_firewall_rules", payload, { path: queryPath("/api/vultr-firewall-rules", payload) });
  },
  mutateVultrFirewall(action: "create" | "delete", payload: Record<string, unknown>): Promise<void> {
    const command = action === "create" ? "create_vultr_firewall_rule" : "delete_vultr_firewall_rule";
    return invokeOrWeb(command, payload, { path: "/api/vultr-firewall-rules", init: jsonRequest("POST", { ...payload, action }) });
  },
};
