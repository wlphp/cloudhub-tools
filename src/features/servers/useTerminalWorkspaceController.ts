import { useEffect, useState } from "react";
import { invoke, runningInTauri } from "../../platform/api";
import type { Account, LocalAsset, ManagedHost, SshConnectResult, TerminalWorkspaceTab } from "../../shared/types";
import { firstAddress } from "../../shared/utils/display";
import { remotePlatformFromPayload } from "../resources/presentation";
import { useSshConnection } from "./useSshConnection";
import { useSshFiles } from "./useSshFiles";
import { useSshTerminal } from "./useSshTerminal";

type TerminalWorkspaceControllerOptions = {
  isTerminalSection: boolean;
  loadManagedHosts: () => Promise<void>;
  notify: (message: string) => void;
  requestConfirm: (message: string) => Promise<boolean>;
  requestPrompt: (message: string, initialValue?: string) => Promise<string | null>;
};

export function useTerminalWorkspaceController({
  isTerminalSection,
  loadManagedHosts,
  notify,
  requestConfirm,
  requestPrompt,
}: TerminalWorkspaceControllerOptions) {
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const [terminalSshError, setTerminalSshError] = useState("");
  const terminal = useSshTerminal({ onError: setTerminalSshError });
  const sshFiles = useSshFiles({
    sessionId: terminal.sessionId,
    requestConfirm,
    requestPrompt,
    notify,
  });
  const connection = useSshConnection({
    onSessionReset: () => {
      terminal.setSessionId("");
      terminal.pendingOutputRef.current = "";
    },
    onFilesReset: sshFiles.reset,
    onTestSuccess: () => notify("SSH 测试连接成功"),
  });
  const sshError = connection.error || terminalSshError;

  function setSshError(message: string) {
    connection.setError(message);
    setTerminalSshError("");
  }

  useEffect(() => {
    if (terminal.sessionId) void sshFiles.loadFiles("/");
  }, [terminal.sessionId]);

  function activateTab(tab: TerminalWorkspaceTab) {
    terminal.setActiveTabId(tab.id);
    if (tab.target.managedHostId) setSelectedHostId(tab.target.managedHostId);
    connection.setTarget(tab.target);
    connection.setHost(tab.host);
    connection.setPort(tab.port);
    connection.setUsername(tab.username);
    terminal.setSessionId(tab.sessionId);
    connection.setPassword("");
    setSshError("");
    sshFiles.reset();
  }

  async function closeTab(tabId: string) {
    const tab = terminal.tabsRef.current.find((item) => item.id === tabId);
    if (!tab) return;
    const remaining = terminal.tabsRef.current.filter((item) => item.id !== tabId);
    const closingActiveTab = terminal.activeTabId === tabId;
    const nextTab = closingActiveTab ? remaining[remaining.length - 1] || null : null;
    terminal.setTabs(remaining);
    if (nextTab) activateTab(nextTab);
    else if (closingActiveTab) {
      terminal.setActiveTabId(null);
      terminal.setSessionId("");
      connection.setTarget(null);
      sshFiles.reset();
      sshFiles.setPaneCollapsed(true);
    }
    await terminal.disconnectSession(tab.sessionId);
  }

  function openManagedHost(host: ManagedHost) {
    if (!runningInTauri) {
      notify("远程连接仅支持桌面客户端");
      return;
    }
    setSelectedHostId(host.id);
    if (host.platform === "windows") {
      void invoke("launch_managed_host_rdp", { id: host.id })
        .then(() => notify(`已打开 ${host.name} 的 Windows 远程桌面连接`))
        .catch((error) => notify(`打开 RDP 失败：${String(error)}`));
      return;
    }
    const existingTab = terminal.tabsRef.current.find((tab) => tab.target.managedHostId === host.id);
    if (existingTab) {
      activateTab(existingTab);
      return;
    }
    terminal.setActiveTabId(null);
    const account: Account = {
      id: 0,
      account_name: "服务器管理",
      cloud_type: "other",
      access_key_id: "managed-host",
      enabled: true,
      sort_order: 0,
      created_at: host.created_at,
      updated_at: host.updated_at,
    };
    const asset: LocalAsset = {
      account_id: 0,
      resource_type: "managed",
      asset_key: `managed-host-${host.id}`,
      payload: { InstanceName: host.name },
      fetched_at: host.updated_at,
    };
    connection.setTarget({ account, asset, managedHostId: host.id });
    connection.setHost(host.host);
    connection.setPort(host.port || 22);
    connection.setUsername(host.username || "root");
    connection.setPassword("");
    connection.setShowPassword(false);
    connection.setPlatform("linux");
    connection.setAuthMethod(host.auth_method === "private_key" ? "private_key" : "password");
    connection.setPrivateKey("");
    connection.setKeyPassphrase("");
    connection.setSavePassword(false);
    connection.setPasswordSaved(host.password_saved || host.private_key_saved);
    connection.setMaximized(false);
    terminal.setSessionId("");
    terminal.pendingOutputRef.current = "";
    setSshError("");
    sshFiles.reset();
    sshFiles.setPaneCollapsed(true);
  }

  async function openAssetSshClient(asset: LocalAsset, account: Account) {
    if (!runningInTauri) {
      notify("远程连接仅支持桌面客户端，请从客户端打开资源管理");
      return;
    }
    const payload = asset.payload || {};
    const defaultHost = firstAddress(payload.PublicIpAddress || payload.PublicAddresses || payload.PublicIp || payload.InternetIp || payload.EipAddress);
    await connection.openAssetTarget(asset, account, defaultHost, remotePlatformFromPayload(payload));
  }

  async function closeClient() {
    if (isTerminalSection && terminal.activeTabId) {
      await closeTab(terminal.activeTabId);
      return;
    }
    const sessionId = terminal.sessionId;
    terminal.setSessionId("");
    connection.setTarget(null);
    connection.setShowPassword(false);
    connection.setMaximized(false);
    sshFiles.reset();
    await terminal.disconnectSession(sessionId);
  }

  async function launchRdpClient() {
    if (!connection.target) return;
    if (!connection.host.trim() || !connection.username.trim()) {
      setSshError("请填写 RDP 主机和用户名");
      return;
    }
    connection.setConnecting(true);
    setSshError("");
    try {
      await invoke("launch_rdp_connection", {
        input: {
          targetKey: connection.targetKey() || `direct:${Date.now()}`,
          host: connection.host.trim(),
          port: connection.port || 3389,
          username: connection.username.trim(),
          password: connection.password || null,
          savePassword: !connection.target.direct && connection.savePassword,
        },
      });
      connection.setPassword("");
      connection.setPasswordSaved(!connection.target.direct && connection.savePassword && Boolean(connection.password || connection.passwordSaved));
      notify("已打开 Windows 远程桌面连接");
      await closeClient();
    } catch (error) {
      setSshError(String(error));
    } finally {
      connection.setConnecting(false);
    }
  }

  async function connectClient() {
    if (!connection.target) return;
    if (connection.platform === "windows") {
      await launchRdpClient();
      return;
    }
    if (!connection.host.trim() || !connection.username.trim()) {
      setSshError("请填写 SSH 主机和用户名");
      return;
    }
    if (connection.authMethod === "password" && !connection.password && !connection.passwordSaved) {
      setSshError("请输入 SSH 密码，或使用已保存的密码连接");
      return;
    }
    if (connection.authMethod === "private_key" && !connection.privateKey.trim() && !connection.passwordSaved) {
      setSshError("请粘贴 SSH 私钥，或使用已保存私钥连接");
      return;
    }
    connection.setConnecting(true);
    setSshError("");
    try {
      const result = await invoke<SshConnectResult>("ssh_connect", {
        input: {
          ...(connection.target.managedHostId ? { managedHostId: connection.target.managedHostId } : connection.target.direct ? { direct: true } : { accountId: connection.target.account.id, assetKey: connection.target.asset.asset_key }),
          host: connection.host.trim(),
          port: connection.port || 22,
          username: connection.username.trim(),
          authMethod: connection.authMethod,
          password: connection.authMethod === "password" ? connection.password || null : null,
          privateKey: connection.authMethod === "private_key" ? connection.privateKey : null,
          keyPassphrase: connection.authMethod === "private_key" ? connection.keyPassphrase || null : null,
          savePassword: connection.authMethod === "password" && !connection.target.direct && connection.savePassword,
          cols: 112,
          rows: 30,
        },
      });
      terminal.setSessionId(result.sessionId);
      if (isTerminalSection) {
        const tab: TerminalWorkspaceTab = {
          id: result.sessionId,
          target: connection.target,
          host: connection.host.trim(),
          port: connection.port || 22,
          username: connection.username.trim(),
          sessionId: result.sessionId,
          output: "",
        };
        terminal.setTabs((current) => [...current.filter((item) => item.id !== tab.id), tab]);
        terminal.setActiveTabId(tab.id);
      } else if (!connection.target.managedHostId && !connection.target.direct) {
        void loadManagedHosts();
        notify("SSH 已连接，并已自动加入终端管理");
      }
      connection.setPassword("");
      connection.setPasswordSaved(connection.target.managedHostId ? (connection.authMethod === "private_key" || connection.savePassword || connection.passwordSaved) : connection.authMethod === "password" && connection.savePassword);
    } catch (error) {
      setSshError(String(error));
    } finally {
      connection.setConnecting(false);
    }
  }

  return {
    selectedHostId,
    setSelectedHostId,
    sshError,
    sessionId: terminal.sessionId,
    setSessionId: terminal.setSessionId,
    tabs: terminal.tabs,
    activeTabId: terminal.activeTabId,
    themeName: terminal.themeName,
    setThemeName: terminal.setThemeName,
    themeMenuOpen: terminal.themeMenuOpen,
    setThemeMenuOpen: terminal.setThemeMenuOpen,
    terminalHostRef: terminal.terminalHostRef,
    clearTerminal: terminal.clear,
    completeCommand: terminal.completeCommand,
    files: sshFiles.files,
    path: sshFiles.path,
    setPath: sshFiles.setPath,
    loadingFiles: sshFiles.loading,
    fileError: sshFiles.error,
    editor: sshFiles.editor,
    setEditor: sshFiles.setEditor,
    savingFile: sshFiles.saving,
    paneWidth: sshFiles.paneWidth,
    paneCollapsed: sshFiles.paneCollapsed,
    setPaneCollapsed: sshFiles.setPaneCollapsed,
    dragActive: sshFiles.dragActive,
    setDragActive: sshFiles.setDragActive,
    uploadInputRef: sshFiles.uploadInputRef,
    workspaceRef: sshFiles.workspaceRef,
    parentPath: sshFiles.parentPath,
    fileSize: sshFiles.fileSize,
    loadFiles: sshFiles.loadFiles,
    startFileResize: sshFiles.startResize,
    openFile: sshFiles.openFile,
    saveFile: sshFiles.saveFile,
    uploadFiles: sshFiles.uploadFiles,
    downloadFile: sshFiles.downloadFile,
    makeDirectory: sshFiles.makeDirectory,
    deleteEntry: sshFiles.deleteEntry,
    target: connection.target,
    host: connection.host,
    setHost: connection.setHost,
    port: connection.port,
    setPort: connection.setPort,
    username: connection.username,
    setUsername: connection.setUsername,
    password: connection.password,
    setPassword: connection.setPassword,
    showPassword: connection.showPassword,
    setShowPassword: connection.setShowPassword,
    platform: connection.platform,
    setPlatform: connection.setPlatform,
    authMethod: connection.authMethod,
    setAuthMethod: connection.setAuthMethod,
    privateKey: connection.privateKey,
    setPrivateKey: connection.setPrivateKey,
    keyPassphrase: connection.keyPassphrase,
    setKeyPassphrase: connection.setKeyPassphrase,
    testing: connection.testing,
    savePassword: connection.savePassword,
    setSavePassword: connection.setSavePassword,
    passwordSaved: connection.passwordSaved,
    setPasswordSaved: connection.setPasswordSaved,
    passwordRevealing: connection.passwordRevealing,
    connecting: connection.connecting,
    maximized: connection.maximized,
    setMaximized: connection.setMaximized,
    changePlatform: connection.changePlatform,
    testConnection: connection.testConnection,
    togglePasswordVisibility: connection.togglePasswordVisibility,
    clearSavedConnection: connection.clearSavedConnection,
    activateTab,
    closeTab,
    openManagedHost,
    openAssetSshClient,
    closeClient,
    connectClient,
  };
}
