import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, runningInTauri } from "../../platform/api";
import { AppWindow, Check, Eye, FileKey2, FileType, Loader2, Monitor, MonitorCog, Network, RefreshCw, RotateCcw, RotateCw, ShieldAlert, X } from "lucide-react";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import "./windows-toolbox.css";

type Action = "desktop-icons" | "installed-apps" | "system-proxy" | "hosts" | "hosts-folder" | "flush-dns" | "display" | "restart-explorer";
type CredSspStatus = { currentValue: number | null; backupAvailable: boolean };
type CredSspConfirmation = "repair" | "restore";
type ExplorerPreferences = { showFileExtensions: boolean; showHiddenFiles: boolean };
type ExplorerSetting = "file-extensions" | "hidden-files";
const actions: { id: Action; title: string; detail: string; icon: typeof Monitor; extraAction?: Action; extraLabel?: string }[] = [
  { id: "desktop-icons", title: "桌面图标设置", detail: "打开系统桌面图标配置", icon: MonitorCog },
  { id: "installed-apps", title: "已安装的应用", detail: "查看、卸载或修改本机应用", icon: AppWindow },
  { id: "system-proxy", title: "系统代理", detail: "打开 Windows 网络代理设置", icon: Network },
  { id: "hosts", title: "Hosts 文件", detail: "先备份，再以管理员身份打开", icon: FileKey2, extraAction: "hosts-folder", extraLabel: "打开文件夹" },
  { id: "flush-dns", title: "清理 DNS 缓存", detail: "需要确认 Windows 管理员授权", icon: RotateCw },
  { id: "display", title: "显示设置", detail: "打开屏幕与多显示器设置", icon: Monitor },
  { id: "restart-explorer", title: "重启 Windows 资源管理器", detail: "重启桌面、任务栏和文件管理器外壳", icon: RotateCw },
];

function WindowsToolboxToast({ message }: { message: string }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
    const timer = window.setTimeout(() => setDismissed(true), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);
  if (!message || dismissed) return null;
  return createPortal(<div className="toast-notice windows-toolbox-toast" role="status" aria-live="polite" aria-atomic="true">
    <Check size={16} aria-hidden="true" />
    <span>{message}</span>
    <button type="button" aria-label="关闭提示" title="关闭提示" onClick={() => setDismissed(true)}><X size={14} aria-hidden="true" /></button>
  </div>, document.body);
}

function errorText(reason: unknown) {
  if (typeof reason === "string" && reason.trim()) return reason;
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "无法完成 Windows 工具箱操作，请检查权限或系统设置。";
}

export function WindowsToolboxPlugin() {
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [credSsp, setCredSsp] = useState<CredSspStatus | null>(null);
  const [credSspLoading, setCredSspLoading] = useState(runningInTauri);
  const [credSspBusy, setCredSspBusy] = useState(false);
  const [credSspConfirmation, setCredSspConfirmation] = useState<CredSspConfirmation | null>(null);
  const [credSspPhase, setCredSspPhase] = useState("");
  const [credSspError, setCredSspError] = useState("");
  const [credSspMessage, setCredSspMessage] = useState("");
  const [credSspStatusError, setCredSspStatusError] = useState("");
  const [explorerConfirmation, setExplorerConfirmation] = useState(false);
  const [explorerPhase, setExplorerPhase] = useState("");
  const [explorerPreferences, setExplorerPreferences] = useState<ExplorerPreferences | null>(null);
  const [explorerPreferencesLoading, setExplorerPreferencesLoading] = useState(runningInTauri);
  const [explorerPreferencesError, setExplorerPreferencesError] = useState("");
  const [explorerPreferencesBusy, setExplorerPreferencesBusy] = useState(false);
  const [explorerPreferencesMessage, setExplorerPreferencesMessage] = useState("");
  const [explorerSettingConfirmation, setExplorerSettingConfirmation] = useState<{ setting: ExplorerSetting; enabled: boolean } | null>(null);
  const [explorerSettingError, setExplorerSettingError] = useState("");

  async function refreshCredSsp() {
    if (!runningInTauri) return;
    setCredSspLoading(true); setCredSspStatusError("");
    try { setCredSsp(await invoke<CredSspStatus>("windows_toolbox_credssp_status")); }
    catch (reason) { setCredSspStatusError(errorText(reason)); }
    finally { setCredSspLoading(false); }
  }

  async function refreshExplorerPreferences() {
    if (!runningInTauri) return;
    setExplorerPreferencesLoading(true); setExplorerPreferencesError("");
    try { setExplorerPreferences(await invoke<ExplorerPreferences>("windows_toolbox_explorer_preferences")); }
    catch (reason) { setExplorerPreferencesError(errorText(reason)); }
    finally { setExplorerPreferencesLoading(false); }
  }

  useEffect(() => { void refreshCredSsp(); void refreshExplorerPreferences(); }, []);

  async function applyExplorerPreference(setting: ExplorerSetting, enabled: boolean) {
    setExplorerPreferencesBusy(true); setExplorerSettingError(""); setExplorerPreferencesMessage(""); setError(""); setMessage("");
    try {
      const next = await invoke<ExplorerPreferences>("windows_toolbox_set_explorer_preference", { setting, enabled });
      setExplorerPreferences(next); setExplorerSettingConfirmation(null);
      setExplorerPreferencesMessage("设置已写入并复查成功；如果已有文件窗口未更新，请重新打开该窗口。隐藏系统文件的选项未作修改。");
    } catch (reason) { setExplorerSettingError(errorText(reason)); }
    finally { setExplorerPreferencesBusy(false); }
  }

  async function applyCredSsp(confirmation: CredSspConfirmation) {
    setCredSspBusy(true); setCredSspError(""); setCredSspMessage("");
    setCredSspPhase(confirmation === "repair"
      ? "已确认方案。正在请求 Windows 管理员授权并应用策略；请在系统授权提示中选择“是”，之后会自动复查设置。"
      : "已确认恢复。正在请求 Windows 管理员授权并还原修复前保存的策略；之后会自动复查设置。");
    try {
      const next = await invoke<CredSspStatus>("windows_toolbox_credssp_apply", { restore: confirmation === "restore" });
      setCredSsp(next);
      setCredSspConfirmation(null);
      setCredSspPhase("");
      setCredSspMessage(confirmation === "restore"
        ? "已恢复修复前保存的 CredSSP 设置，并确认系统当前值一致。"
        : next.currentValue === 2
          ? next.backupAvailable
            ? "兼容策略已应用并复查成功。原始设置已保存，可随时恢复。请重新尝试远程桌面连接。"
            : "系统当前已处于兼容策略（易受攻击）状态；本工具没有修复前的备份，因此不能自动恢复。"
          : "系统当前值已复查；没有检测到需要应用的策略变更。");
    } catch (reason) {
      setCredSspError(errorText(reason));
      setCredSspPhase("");
      try { setCredSsp(await invoke<CredSspStatus>("windows_toolbox_credssp_status")); } catch { /* 保留原错误，并允许用户稍后重试读取 */ }
    } finally { setCredSspBusy(false); }
  }

  async function open(action: Action) {
    if (!runningInTauri || busy || credSspBusy || explorerPreferencesBusy) return;
    if (action === "restart-explorer") {
      setExplorerConfirmation(true); setError(""); setMessage(""); setExplorerPreferencesMessage(""); setExplorerSettingError("");
      return;
    }
    setBusy(action); setError(""); setExplorerPreferencesMessage(""); setExplorerSettingError("");
    setMessage(action === "flush-dns" ? "正在清理 DNS 缓存…" : "");
    try {
      const backupPath = await invoke<string>("windows_toolbox_open", { action });
      setMessage(action === "hosts"
        ? "Hosts 备份已保存：" + backupPath + "。记事本已请求管理员权限打开原文件。"
        : action === "hosts-folder"
          ? "已打开 Windows hosts 文件所在文件夹。"
        : action === "flush-dns"
          ? backupPath || "DNS 缓存清理完成。"
          : "已向 Windows 请求打开对应设置。");
    } catch (reason) { setMessage(""); setError(errorText(reason)); }
    finally { setBusy(null); }
  }

  const credSspStatusText = !runningInTauri ? "仅支持 Windows 桌面端" : credSspLoading ? "正在读取本机策略…" : credSspStatusError ? "读取失败" : credSsp?.currentValue === 2 ? "易受攻击（兼容模式）" : credSsp?.currentValue === 0 ? "强制更新客户端" : credSsp?.currentValue === 1 ? "已缓解" : credSsp ? "未显式配置（采用系统默认策略）" : "状态未知";
  const toastMessage = credSspMessage || explorerPreferencesMessage || (message && busy !== "flush-dns" ? message : "");

  return <section className="windows-toolbox" aria-busy={Boolean(busy) || credSspBusy}>
    <WindowsToolboxToast message={toastMessage} />
    <details className="windows-toolbox-help">
      <summary>说明</summary>
      <div className="windows-toolbox-help-content">
        <p>这些按钮由桌面端调用 Windows 系统功能，不会执行任意命令；浏览器预览不支持本机操作。</p>
        <ul>
          <li><strong>桌面图标设置：</strong>打开 Windows 桌面图标配置面板。</li>
          <li><strong>已安装的应用、系统代理、显示设置：</strong>跳转到对应的 Windows 设置页面。</li>
          <li><strong>Hosts 文件：</strong>“打开文件夹”定位到 Hosts 所在目录；“打开”会先在应用本地数据目录创建备份，再请求管理员权限用记事本打开原文件。</li>
          <li><strong>清理 DNS 缓存：</strong>请求管理员授权后运行 Windows 的 <code>ipconfig /flushdns</code>。</li>
          <li><strong>重启 Windows 资源管理器：</strong>确认后重启桌面外壳进程，桌面和任务栏可能短暂消失；通常数秒后恢复。</li>
        </ul>
      </div>
    </details>
    {!runningInTauri && <p className="windows-toolbox-notice" role="status">Windows 工具箱仅支持 Windows 桌面端；浏览器预览不会执行本机操作。</p>}
    {error && <p className="windows-toolbox-feedback is-error" role="alert">{error}</p>}
    {busy === "flush-dns" && <div className="windows-toolbox-feedback is-pending windows-toolbox-progress" role="status" aria-live="polite">
      <strong>{message}</strong>
      <ol aria-label="DNS 缓存清理过程">
        <li className="is-active">请求 Windows 管理员授权</li>
        <li>运行 <code>ipconfig /flushdns</code> 刷新本机 DNS 缓存</li>
        <li>等待 Windows 返回清理结果</li>
      </ol>
      <span className="windows-toolbox-progress-indicator" aria-hidden="true" />
    </div>}
    {busy === "restart-explorer" && <div className="windows-toolbox-feedback is-pending windows-toolbox-progress" role="status" aria-live="polite">
      <strong>正在重新启动 Windows 资源管理器…</strong>
      <ol aria-label="资源管理器重启过程">
        <li className="is-active">关闭当前桌面外壳进程</li>
        <li>重新启动 explorer.exe</li>
        <li>Windows 桌面和任务栏重新出现</li>
      </ol>
      <span className="windows-toolbox-progress-indicator" aria-hidden="true" />
    </div>}
    {explorerPreferencesBusy && <p className="windows-toolbox-feedback is-pending" role="status" aria-live="polite">正在更新文件资源管理器显示设置并复查结果…</p>}
    {explorerPreferencesError && <p className="windows-toolbox-feedback is-error" role="alert">读取文件资源管理器设置失败：{explorerPreferencesError}</p>}
    {explorerSettingError && explorerSettingConfirmation && <p className="windows-toolbox-feedback is-error" role="alert">{explorerSettingError}</p>}
    <div className="windows-toolbox-grid">
      {actions.map(({ id, title, detail, icon: Icon, extraAction, extraLabel }) => <article className="windows-toolbox-card" key={id}>
        <span className="windows-toolbox-icon" aria-hidden="true"><Icon size={18} /></span>
        <div className="windows-toolbox-card-copy"><strong>{title}</strong><span>{detail}</span></div>
        <div className="windows-toolbox-card-actions">
          {extraAction && <button type="button" className="secondary" disabled={!runningInTauri || Boolean(busy) || credSspBusy || explorerPreferencesBusy} onClick={() => void open(extraAction)}>{busy === extraAction ? "正在打开…" : extraLabel}</button>}
          <button type="button" className="secondary" disabled={!runningInTauri || Boolean(busy) || credSspBusy || explorerPreferencesBusy} onClick={() => void open(id)}>{busy === id ? id === "flush-dns" ? "正在清理…" : id === "restart-explorer" ? "正在重启…" : "正在打开…" : id === "restart-explorer" ? "重启" : "打开"}</button>
        </div>
      </article>)}
      {([
        { setting: "file-extensions" as const, title: "显示文件扩展名", detail: "显示或隐藏文件名后缀，如 .txt、.jpg", icon: FileType, enabled: explorerPreferences?.showFileExtensions },
        { setting: "hidden-files" as const, title: "显示隐藏文件和文件夹", detail: "不影响受保护的操作系统文件设置", icon: Eye, enabled: explorerPreferences?.showHiddenFiles },
      ]).map(({ setting, title, detail, icon: Icon, enabled }) => <article className="windows-toolbox-card" key={setting}>
        <span className="windows-toolbox-icon" aria-hidden="true"><Icon size={18} /></span>
        <div className="windows-toolbox-card-copy"><strong>{title}</strong><span>当前状态：{!runningInTauri ? "仅支持 Windows 桌面端" : explorerPreferencesLoading ? "正在读取…" : explorerPreferencesError ? "读取失败" : enabled ? "已开启" : "已关闭"}</span><span>{detail}</span></div>
        <div className="windows-toolbox-card-actions">
          {explorerPreferencesError
            ? <button type="button" className="secondary" disabled={!runningInTauri || explorerPreferencesLoading || explorerPreferencesBusy || Boolean(busy) || credSspBusy} onClick={() => void refreshExplorerPreferences()}><RefreshCw size={13} aria-hidden="true" />重试读取</button>
            : <button type="button" className="secondary" disabled={!runningInTauri || explorerPreferencesLoading || explorerPreferencesBusy || Boolean(busy) || credSspBusy || enabled === undefined} onClick={() => { setExplorerSettingError(""); setExplorerSettingConfirmation({ setting, enabled: !enabled }); }}>{enabled ? "关闭" : "开启"}</button>}
        </div>
      </article>)}
      <article className="windows-toolbox-card windows-toolbox-credssp-card">
        <span className="windows-toolbox-icon" aria-hidden="true"><ShieldAlert size={18} /></span>
        <div className="windows-toolbox-card-copy"><strong>远程桌面身份验证修复</strong><span>CredSSP 策略：{credSspStatusText}</span><span>兼容旧服务器可能降低本机认证保护</span></div>
        <div className="windows-toolbox-card-actions windows-toolbox-credssp-actions">
          {credSsp && credSsp.currentValue === 2
            ? <button type="button" className="secondary" disabled title="CredSSP 已处于兼容模式，无需重复应用。">方案已生效</button>
            : credSsp && <button type="button" className="secondary" disabled={!runningInTauri || credSspBusy || busy !== null || explorerPreferencesBusy || credSspLoading || Boolean(credSspStatusError)} onClick={() => { setCredSspError(""); setCredSspConfirmation("repair"); }}>按方案修复</button>}
          {credSsp?.backupAvailable && <button type="button" className="secondary" disabled={!runningInTauri || credSspBusy || busy !== null || explorerPreferencesBusy} onClick={() => { setCredSspError(""); setCredSspConfirmation("restore"); }}><RotateCcw size={13} aria-hidden="true" />恢复原设置</button>}
          {credSspStatusError && <button type="button" className="secondary" disabled={!runningInTauri || credSspBusy || busy !== null} onClick={() => void refreshCredSsp()}><RefreshCw size={13} aria-hidden="true" />重试读取</button>}
          {credSspBusy && <span className="windows-toolbox-credssp-working"><Loader2 size={14} aria-hidden="true" />处理中…</span>}
        </div>
      </article>
    </div>
    {credSspStatusError && <p className="windows-toolbox-feedback is-error" role="alert">读取远程桌面策略失败：{credSspStatusError}</p>}
    {credSspError && !credSspConfirmation && <p className="windows-toolbox-feedback is-error" role="alert">{credSspError}</p>}
    {explorerSettingConfirmation && <ConfirmDialog
      title={`确认${explorerSettingConfirmation.enabled ? "开启" : "关闭"}${explorerSettingConfirmation.setting === "file-extensions" ? "文件扩展名显示" : "显示隐藏文件和文件夹"}`}
      message={explorerSettingConfirmation.setting === "file-extensions"
        ? `确认${explorerSettingConfirmation.enabled ? "显示" : "隐藏"}常见文件扩展名？这只改变文件资源管理器的显示方式，不会重命名或修改文件。`
        : `确认${explorerSettingConfirmation.enabled ? "显示" : "隐藏"}具有隐藏属性的文件和文件夹？此操作不会更改文件内容，也不会显示受保护的操作系统文件。`}
      confirmLabel={`确认${explorerSettingConfirmation.enabled ? "开启" : "关闭"}`}
      busy={explorerPreferencesBusy}
      error={explorerSettingError}
      onResolve={confirmed => {
        if (confirmed) void applyExplorerPreference(explorerSettingConfirmation.setting, explorerSettingConfirmation.enabled);
        else if (!explorerPreferencesBusy) { setExplorerSettingConfirmation(null); setExplorerSettingError(""); }
      }}
    >
      <div className="windows-toolbox-credssp-confirm-note">
        <strong><ShieldAlert size={15} aria-hidden="true" />操作说明</strong>
        <p>确认后仅修改当前 Windows 用户的文件资源管理器首选项，不需要管理员权限；完成后会重新读取系统值进行验证。</p>
      </div>
    </ConfirmDialog>}
    {explorerConfirmation && <ConfirmDialog
      title="确认重启 Windows 资源管理器"
      message="此操作会关闭并重新启动 explorer.exe。桌面、任务栏和文件管理器窗口可能短暂消失或关闭，通常数秒后会自动恢复。"
      confirmLabel="确认重启"
      busy={busy === "restart-explorer"}
      error={error}
      onResolve={confirmed => {
        if (!confirmed || busy === "restart-explorer") { if (!busy) setExplorerConfirmation(false); return; }
        setBusy("restart-explorer"); setError(""); setMessage("");
        setExplorerPhase("正在关闭资源管理器并重新启动 Windows 桌面外壳…");
        void invoke<string>("windows_toolbox_open", { action: "restart-explorer" })
          .then(result => { setMessage(result || "已请求重新启动 Windows 资源管理器；桌面和任务栏应很快恢复。"); setExplorerConfirmation(false); })
          .catch(reason => setError(errorText(reason)))
          .finally(() => { setBusy(null); setExplorerPhase(""); });
      }}
    >
      <div className="windows-toolbox-credssp-confirm-note">
        <strong><RotateCw size={15} aria-hidden="true" />执行步骤</strong>
        <ol><li>结束当前用户的 Windows 资源管理器进程。</li><li>重新启动系统自带的 <code>explorer.exe</code>。</li></ol>
        <p>不需要管理员权限。建议先保存正在进行的文件操作；此功能不会重启 Windows，也不会删除文件。</p>
      </div>
      {explorerPhase && <p className="windows-toolbox-credssp-phase" role="status"><Loader2 size={14} aria-hidden="true" />{explorerPhase}</p>}
    </ConfirmDialog>}
    {credSspConfirmation && <ConfirmDialog
      title={credSspConfirmation === "repair" ? "确认远程桌面兼容修复" : "确认恢复 CredSSP 原设置"}
      message={credSspConfirmation === "repair"
        ? "此操作会修改本机 Windows CredSSP 策略，以兼容文章所述的旧版远程桌面服务器。"
        : "此操作会将 CredSSP 策略恢复到本工具首次修复前保存的状态。"}
      confirmLabel={credSspConfirmation === "repair" ? "确认并继续" : "确认恢复"}
      busy={credSspBusy}
      error={credSspError}
      onResolve={confirmed => {
        if (confirmed) void applyCredSsp(credSspConfirmation);
        else if (!credSspBusy) { setCredSspConfirmation(null); setCredSspError(""); setCredSspPhase(""); }
      }}
    >
      {credSspConfirmation === "repair" ? <div className="windows-toolbox-credssp-confirm-note">
        <strong><ShieldAlert size={15} aria-hidden="true" />安全影响与执行步骤</strong>
        <ol><li>先把当前原始策略保存在本机，供之后恢复。</li><li>请求 Windows 管理员授权。</li><li>仅将 <code>AllowEncryptionOracle</code> 设置为 2（易受攻击），然后重新读取策略验证结果。</li></ol>
        <p>该设置会降低 CredSSP 的认证保护。仅在确实需要连接可信的旧服务器时使用；确认后请在 Windows 管理员授权提示中选择“是”。</p>
      </div> : <div className="windows-toolbox-credssp-confirm-note">
        <strong><RotateCcw size={15} aria-hidden="true" />恢复过程</strong>
        <p>将请求 Windows 管理员授权，把该策略恢复为首次修复前的 DWORD 值；如果当时未显式配置，则移除本工具添加的策略值。只处理此项，不删除同一注册表位置的其他设置。</p>
      </div>}
      {credSspPhase && <p className="windows-toolbox-credssp-phase" role="status"><Loader2 size={14} aria-hidden="true" />{credSspPhase}</p>}
    </ConfirmDialog>}
  </section>;
}
