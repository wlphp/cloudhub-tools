import { useState, type Dispatch, type SetStateAction } from "react";
import { invoke, runningInTauri, webApi } from "../../platform/api";
import type { Account, LocalAsset } from "../../shared/types";

type AssetNameDraft = { key: string; value: string; initial: string } | null;

type UseInstanceActionsOptions = {
  accounts: Account[];
  loadApiLogs: () => Promise<void>;
  notify: (message: string) => void;
  requestConfirm: (message: string) => Promise<boolean>;
  setLocalAssets: Dispatch<SetStateAction<LocalAsset[]>>;
};

export function useInstanceActions({ accounts, loadApiLogs, notify, requestConfirm, setLocalAssets }: UseInstanceActionsOptions) {
  const [editingName, setEditingName] = useState<AssetNameDraft>(null);
  const [savingName, setSavingName] = useState<string | null>(null);

  async function reboot(asset: LocalAsset, forceStop: boolean) {
    const account = accounts.find((item) => item.id === asset.account_id);
    const instanceId = String(asset.payload?.InstanceId || asset.asset_key);
    const regionId = String(asset.region_id || asset.payload?.RegionId || account?.region_id || "");
    if (!account || !regionId || !instanceId) {
      notify("服务器缺少账号、地域或实例 ID");
      return;
    }
    const resourceLabel = asset.resource_type === "swas" ? "轻量服务器" : "服务器";
    if (!(await requestConfirm(`确认${forceStop ? "强制" : "正常"}重启${resourceLabel}“${String(asset.payload?.InstanceName || instanceId)}”吗？`))) return;
    try {
      if (asset.resource_type === "swas") {
        if (account.cloud_type !== "aliyun" && account.cloud_type !== "tencent") throw new Error("当前轻量服务器暂不支持重启操作");
        const supportsForcedReboot = account.cloud_type === "aliyun" || account.cloud_type === "tencent";
        if (runningInTauri) await invoke("swas_instance_action", { id: account.id, regionId, instanceId, action: "reboot", forceStop: supportsForcedReboot && forceStop });
        else await webApi("/api/swas-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: account.id, regionId, instanceId, action: "reboot", forceStop: supportsForcedReboot && forceStop }) });
      } else if (account.cloud_type === "tencent") {
        if (runningInTauri) await invoke("cvm_instance_reboot", { id: account.id, regionId, instanceId, forceStop });
        else await webApi("/api/cvm-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: account.id, regionId, instanceId, action: "reboot", forceStop }) });
      } else if (account.cloud_type === "oracle") {
        const payload = { id: account.id, regionId, instanceId, action: forceStop ? "forceReboot" : "reboot" };
        if (runningInTauri) await invoke("oracle_instance_action", payload);
        else await webApi("/api/oracle-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "baidu") {
        const payload = { id: account.id, regionId, instanceId, action: "reboot", forceStop };
        if (runningInTauri) await invoke("baidu_instance_action", payload);
        else await webApi("/api/bcc-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "vultr") {
        const payload = { id: account.id, instanceId, action: "reboot" };
        if (runningInTauri) await invoke("vultr_instance_action", payload);
        else await webApi("/api/vultr-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        if (!runningInTauri) throw new Error("网页端暂不支持阿里云服务器重启，请使用客户端操作");
        await invoke("reboot_instance", { id: account.id, regionId, instanceId, forceStop });
      }
      notify(`${forceStop ? "强制" : "正常"}重启${resourceLabel}指令已提交`);
      await loadApiLogs();
    } catch (error) {
      notify(`${resourceLabel}重启失败：${String(error)}`);
    }
  }

  async function stop(asset: LocalAsset) {
    const account = accounts.find((item) => item.id === asset.account_id);
    const instanceId = String(asset.payload?.InstanceId || asset.asset_key);
    const regionId = String(asset.region_id || asset.payload?.RegionId || account?.region_id || "");
    if (!account || !regionId || !instanceId) {
      notify("服务器缺少账号、地域或实例 ID");
      return;
    }
    const resourceLabel = asset.resource_type === "swas" ? "轻量服务器" : "服务器";
    if (!(await requestConfirm(`确认关机${resourceLabel}“${String(asset.payload?.InstanceName || instanceId)}”吗？`))) return;
    try {
      if (asset.resource_type === "swas") {
        if (account.cloud_type !== "aliyun" && account.cloud_type !== "tencent") throw new Error("当前轻量服务器暂不支持关机操作");
        const payload = { id: account.id, regionId, instanceId, action: "stop", forceStop: false };
        if (runningInTauri) await invoke("swas_instance_action", payload);
        else await webApi("/api/swas-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "tencent") {
        const payload = { id: account.id, regionId, instanceId, action: "stop", forceStop: false };
        if (runningInTauri) await invoke("cvm_instance_action", payload);
        else await webApi("/api/cvm-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "oracle") {
        const payload = { id: account.id, regionId, instanceId, action: "stop" };
        if (runningInTauri) await invoke("oracle_instance_action", payload);
        else await webApi("/api/oracle-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "baidu") {
        const payload = { id: account.id, regionId, instanceId, action: "stop", forceStop: false };
        if (runningInTauri) await invoke("baidu_instance_action", payload);
        else await webApi("/api/bcc-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else if (account.cloud_type === "vultr") {
        const payload = { id: account.id, instanceId, action: "stop" };
        if (runningInTauri) await invoke("vultr_instance_action", payload);
        else await webApi("/api/vultr-instance-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        const payload = { id: account.id, regionId, instanceId, action: "stop" };
        if (runningInTauri) await invoke("stop_instance", payload);
        else await webApi("/api/ecs-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      }
      notify(`${resourceLabel}关机指令已提交`);
      await loadApiLogs();
    } catch (error) {
      notify(`${resourceLabel}关机失败：${String(error)}`);
    }
  }

  async function saveName(asset: LocalAsset, account: Account, key: string) {
    const currentDraft = editingName;
    if (!currentDraft || currentDraft.key !== key || savingName === key) return;
    const instanceName = currentDraft.value.trim();
    setEditingName(null);
    if (!instanceName || instanceName === currentDraft.initial) return;
    const instanceId = String(asset.payload.InstanceId || asset.asset_key);
    const regionId = String(asset.region_id || asset.payload.RegionId || account.region_id || "");
    if (!instanceId || !regionId) {
      notify("服务器缺少地域或实例 ID，无法修改名称");
      return;
    }
    setSavingName(key);
    try {
      if (runningInTauri) {
        await invoke("rename_server", { id: account.id, regionId, instanceId, instanceName });
      } else {
        await webApi("/api/server-name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: account.id, regionId, instanceId, instanceName }) });
      }
      setLocalAssets((items) => items.map((item) => item.account_id === asset.account_id && item.resource_type === asset.resource_type && item.asset_key === asset.asset_key
        ? { ...item, payload: { ...item.payload, InstanceName: instanceName } }
        : item));
      notify("服务器名称已更新");
      await loadApiLogs();
    } catch (error) {
      const message = String(error);
      notify(message.includes("Not found")
        ? "当前桌面客户端尚未包含服务器改名功能，请关闭客户端并安装 0.1.1 或更高版本后重试"
        : `修改服务器名称失败：${message}`);
    } finally {
      setSavingName(null);
    }
  }

  return {
    editingName,
    setEditingName,
    savingName,
    reboot,
    stop,
    saveName,
  };
}
