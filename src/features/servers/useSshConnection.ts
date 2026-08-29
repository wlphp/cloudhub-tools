import { useState } from "react";
import { invoke, runningInTauri } from "../../platform/api";
import type {
  Account,
  LocalAsset,
  SavedRdpConnection,
  SavedSshConnection,
  SshAuthMethod,
  SshTarget,
} from "../../shared/types";

type UseSshConnectionOptions = {
  onSessionReset: () => void;
  onFilesReset: () => void;
  onTestSuccess?: () => void;
};

export function useSshConnection({ onSessionReset, onFilesReset, onTestSuccess }: UseSshConnectionOptions) {
  const [target, setTarget] = useState<SshTarget | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [platform, setPlatform] = useState<"linux" | "windows">("linux");
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>("password");
  const [privateKey, setPrivateKey] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [testing, setTesting] = useState(false);
  const [savePassword, setSavePassword] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordRevealing, setPasswordRevealing] = useState(false);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [maximized, setMaximized] = useState(false);

  function targetKey(value = target) {
    if (!value || value.direct) return "";
    return value.managedHostId ? `managed:${value.managedHostId}` : `asset:${value.account.id}:${value.asset.asset_key}`;
  }

  async function openAssetTarget(asset: LocalAsset, account: Account, defaultHost: string, nextPlatform: "linux" | "windows") {
    if (!runningInTauri) {
      setError("远程连接仅支持桌面客户端，请从客户端打开资源管理");
      return false;
    }
    const windows = nextPlatform === "windows";
    setTarget({ account, asset });
    setHost(defaultHost);
    setPort(windows ? 3389 : 22);
    setUsername(windows ? "administrator" : "root");
    setPassword("");
    setShowPassword(false);
    setPlatform(nextPlatform);
    setAuthMethod("password");
    setPrivateKey("");
    setKeyPassphrase("");
    setSavePassword(false);
    setPasswordSaved(false);
    setMaximized(false);
    setError("");
    onSessionReset();
    onFilesReset();
    try {
      const saved = windows
        ? await invoke<SavedRdpConnection | null>("get_rdp_connection", { targetKey: `asset:${account.id}:${asset.asset_key}` })
        : await invoke<SavedSshConnection | null>("get_ssh_connection", { accountId: account.id, assetKey: asset.asset_key });
      if (saved) {
        setHost(saved.host || defaultHost);
        setPort(saved.port || (windows ? 3389 : 22));
        setUsername(saved.username || (windows ? "administrator" : "root"));
        setSavePassword(saved.passwordSaved);
        setPasswordSaved(saved.passwordSaved);
      }
    } catch (cause) {
      setError(`读取本地${windows ? "RDP" : "SSH"}配置失败：${String(cause)}`);
    }
    return true;
  }

  async function changePlatform(nextPlatform: "linux" | "windows") {
    setPlatform(nextPlatform);
    setError("");
    setShowPassword(false);
    if (nextPlatform === "linux") {
      setAuthMethod("password");
      setPort((current) => current === 3389 ? 22 : current);
      if (!username || username === "administrator") setUsername("root");
      setPassword("");
      setSavePassword(false);
      setPasswordSaved(false);
      if (!target || target.direct || target.managedHostId) return;
      try {
        const saved = await invoke<SavedSshConnection | null>("get_ssh_connection", { accountId: target.account.id, assetKey: target.asset.asset_key });
        if (!saved) return;
        setHost(saved.host || host);
        setPort(saved.port || 22);
        setUsername(saved.username || "root");
        setSavePassword(saved.passwordSaved);
        setPasswordSaved(saved.passwordSaved);
      } catch (cause) { setError(`读取本地 SSH 配置失败：${String(cause)}`); }
      return;
    }
    setAuthMethod("password");
    setPrivateKey("");
    setKeyPassphrase("");
    setPort(3389);
    if (!username || username === "root") setUsername("administrator");
    setPassword("");
    setSavePassword(false);
    setPasswordSaved(false);
    const key = targetKey();
    if (!key) return;
    try {
      const saved = await invoke<SavedRdpConnection | null>("get_rdp_connection", { targetKey: key });
      if (!saved) return;
      setHost(saved.host || host);
      setPort(saved.port || 3389);
      setUsername(saved.username || "administrator");
      setSavePassword(true);
      setPasswordSaved(saved.passwordSaved);
    } catch (cause) { setError(`读取本地 RDP 配置失败：${String(cause)}`); }
  }

  async function testConnection() {
    if (!target) return;
    if (!host.trim() || !username.trim()) { setError("请填写 SSH 主机和用户名"); return; }
    if (authMethod === "password" && !password && !passwordSaved) { setError("请输入 SSH 密码，或使用已保存的密码测试"); return; }
    if (authMethod === "private_key" && !privateKey.trim() && !passwordSaved) { setError("请粘贴 SSH 私钥，或使用已保存私钥测试"); return; }
    setTesting(true);
    setError("");
    try {
      await invoke("ssh_test_connection", { input: {
        ...(target.managedHostId ? { managedHostId: target.managedHostId } : target.direct ? { direct: true } : { accountId: target.account.id, assetKey: target.asset.asset_key }),
        host: host.trim(), port: port || 22, username: username.trim(), authMethod,
        password: authMethod === "password" ? password || null : null,
        privateKey: authMethod === "private_key" ? privateKey : null,
        keyPassphrase: authMethod === "private_key" ? keyPassphrase || null : null,
        savePassword: false,
      } });
      setError("");
      onTestSuccess?.();
    } catch (cause) { setError(`测试连接失败：${String(cause)}`); }
    finally { setTesting(false); }
  }

  async function clearSavedConnection() {
    if (!target) return;
    try {
      if (platform === "windows") {
        const key = targetKey();
        if (!key) return;
        await invoke("delete_rdp_connection", { targetKey: key });
      } else {
        if (target.managedHostId) return;
        await invoke("delete_ssh_connection", { accountId: target.account.id, assetKey: target.asset.asset_key });
      }
      setPasswordSaved(false);
      setSavePassword(false);
      setPassword("");
      setShowPassword(false);
      setError("");
    } catch (cause) { setError(`清除本地连接配置失败：${String(cause)}`); }
  }

  async function togglePasswordVisibility() {
    if (showPassword) {
      setShowPassword(false);
      return;
    }
    if (passwordSaved && target) {
      setPasswordRevealing(true);
      try {
        const revealed = platform === "windows"
          ? await invoke<string>("reveal_rdp_password", { targetKey: targetKey() })
          : await invoke<string>("reveal_ssh_password", target.managedHostId
            ? { managedHostId: target.managedHostId }
            : { accountId: target.account.id, assetKey: target.asset.asset_key });
        setPassword(revealed);
        setError("");
      } catch (cause) {
        setError(`读取已保存密码失败：${String(cause)}`);
        return;
      } finally { setPasswordRevealing(false); }
    }
    setShowPassword(true);
  }

  return {
    target, setTarget,
    host, setHost,
    port, setPort,
    username, setUsername,
    password, setPassword,
    showPassword, setShowPassword,
    platform, setPlatform,
    authMethod, setAuthMethod,
    privateKey, setPrivateKey,
    keyPassphrase, setKeyPassphrase,
    testing, setTesting,
    savePassword, setSavePassword,
    passwordSaved, setPasswordSaved,
    passwordRevealing, setPasswordRevealing,
    error, setError,
    connecting, setConnecting,
    maximized, setMaximized,
    targetKey,
    openAssetTarget,
    changePlatform,
    testConnection,
    clearSavedConnection,
    togglePasswordVisibility,
  };
}
