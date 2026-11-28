import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Blocks,
  Bot,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Download,
  Globe2,
  FolderOpen,
  Info,
  Layers,
  Link2,
  Loader2,
  Plus,
  Repeat2,
  RotateCcw,
  Shuffle,
  Smartphone,
  Sparkles,
  Tag,
  History,
  Terminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { OverviewDialog } from "../codex/OverviewDialogs";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { antigravityClient, sameAntigravityDeviceProfile } from "../../platform/clients/antigravity";
import type {
  AntigravityAccount,
  AntigravityAccountType,
  AntigravityDeviceProfile,
  AntigravityModelQuota,
  AntigravityQuotaBucket,
  AntigravityQuotaGroup,
  AntigravitySwitchTarget,
} from "../../platform/clients/antigravity";
import { platformErrorMessage, runningInTauri } from "../../platform/api";

export type AddAccountMethod = "oauth" | "token" | "db";
type FeedbackStatus = "idle" | "loading" | "success" | "error";

function StatusBanner({ status, message }: { status: FeedbackStatus; message: string }) {
  if (status === "idle" || !message) return null;
  const cls =
    status === "loading" ? "ag-status-info" : status === "success" ? "ag-status-success" : "ag-status-error";
  const icon =
    status === "loading" ? <Loader2 size={15} className="codex-refresh-spinning" /> :
    status === "success" ? <CheckCircle2 size={15} /> :
    <XCircle size={15} />;
  return (
    <div className={`ag-status-banner ${cls}`} role="status">
      {icon}<span>{message}</span>
    </div>
  );
}

export function AddAntigravityAccountDialog({
  initialMethod = "oauth",
  busy,
  error,
  oauthPending,
  oauthUrl,
  onClose,
  onStartOAuth,
  onCheckOAuth,
  onSubmitOAuthCallback,
  onImportText,
  onScanLocalDb,
  onImportCustomDb,
  onCopy,
}: {
  initialMethod?: AddAccountMethod;
  busy: boolean;
  error: string;
  oauthPending: boolean;
  oauthUrl: string;
  onClose: () => void;
  onStartOAuth: (accountType: AntigravityAccountType) => void;
  onCheckOAuth: () => Promise<void>;
  onSubmitOAuthCallback: (input: string) => Promise<boolean>;
  onImportText: (content: string, force: boolean, accountType: AntigravityAccountType) => Promise<boolean>;
  onScanLocalDb: (accountType: AntigravityAccountType) => Promise<void>;
  onImportCustomDb: (accountType: AntigravityAccountType) => Promise<void>;
  onCopy: (text: string, label: string) => void;
}) {
  const [method, setMethod] = useState<AddAccountMethod>(initialMethod);
  const [accountType, setAccountType] = useState<AntigravityAccountType>("personal");
  const [manualCallback, setManualCallback] = useState("");
  const [tokenContent, setTokenContent] = useState("");
  const [forceImport, setForceImport] = useState(false);
  const [feedback, setFeedback] = useState<{ status: FeedbackStatus; message: string }>({ status: "idle", message: "" });

  function clearFeedback() {
    setFeedback({ status: "idle", message: "" });
  }

  async function handleSubmitTokens() {
    if (!tokenContent.trim() || busy) return;
    setFeedback({ status: "loading", message: "正在识别并导入账号…" });
    const ok = await onImportText(tokenContent, forceImport, accountType);
    if (ok) {
      setTokenContent("");
      setFeedback({ status: "success", message: "账号导入完成" });
    } else {
      setFeedback({ status: "error", message: error || "未识别到有效的 Refresh Token，请检查内容格式" });
    }
  }

  async function handleSubmitManualCode() {
    if (!manualCallback.trim() || busy) return;
    setFeedback({ status: "loading", message: "正在提交回调授权码…" });
    const ok = await onSubmitOAuthCallback(manualCallback.trim());
    if (ok) {
      setManualCallback("");
      setFeedback({ status: "success", message: "OAuth 授权成功，账号已导入" });
    } else {
      setFeedback({ status: "error", message: error || "提交授权码失败，请确认先启动 OAuth 授权并粘贴完整回调链接或 Code" });
    }
  }

  const isGcp = accountType === "gcp";

  return (
    <OverviewDialog
      sizeStorageKey="features/antigravity/add-account-dialog-v2"
      title="添加新账号"
      busy={busy}
      onClose={onClose}
      className="ag-dialog ag-add-modal"
      footer={null}
    >
      {/* ── Primary 3-way segmented tabs (OAuth / Refresh Token / 从数据库导入) ── */}
      <div className="ag-seg-tabs" role="tablist" aria-label="选择账号添加方式">
        <button
          type="button"
          role="tab"
          aria-selected={method === "oauth"}
          disabled={busy}
          onClick={() => { setMethod("oauth"); clearFeedback(); }}
        >
          OAuth 授权
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === "token"}
          disabled={busy}
          onClick={() => { setMethod("token"); clearFeedback(); }}
        >
          Refresh Token
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === "db"}
          disabled={busy}
          onClick={() => { setMethod("db"); clearFeedback(); }}
        >
          从数据库导入
        </button>
      </div>

      {/* ── Account type 2-way toggle (Personal vs Enterprise / GCP Vertex AI) ── */}
      <div className="ag-type-tabs" role="radiogroup" aria-label="账号类型">
        <button
          type="button"
          role="radio"
          aria-checked={accountType === "personal"}
          disabled={busy}
          onClick={() => { setAccountType("personal"); clearFeedback(); }}
        >
          个人账号 (Personal)
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={accountType === "gcp"}
          disabled={busy}
          onClick={() => { setAccountType("gcp"); clearFeedback(); }}
        >
          企业 / GCP (Vertex AI)
        </button>
      </div>

      <StatusBanner status={feedback.status} message={feedback.message} />
      {error && feedback.status === "idle" && <StatusBanner status="error" message={error} />}

      {/* ── Tab 1: OAuth 授权 ── */}
      {method === "oauth" && (
        <section className="ag-add-section" role="tabpanel">
          <div className="ag-oauth-hero">
            <div className="ag-oauth-circle">
              <Globe2 size={26} />
            </div>
            <h4>{isGcp ? "Google Cloud / Vertex AI 企业授权" : "Google OAuth 个人账号授权"}</h4>
            <p>
              {isGcp
                ? "使用官方企业 GCP 专属客户端授权，自动保留企业配额并关联 Vertex AI 项目"
                : "通过 Google 个人账号官方授权登录，自动拉取模型列表并同步配额信息"}
            </p>
          </div>

          <button
            type="button"
            className="ag-primary-cta"
            disabled={busy}
            onClick={() => onStartOAuth(accountType)}
          >
            {oauthPending && <Loader2 size={15} className="codex-refresh-spinning" />}
            {oauthPending ? "重新打开 OAuth 授权" : "开始 OAuth 授权"}
          </button>

          <div className="ag-oauth-link-block">
            <span className="ag-field-caption">授权链接</span>
            <button
              type="button"
              className="ag-dashed-link-btn"
              disabled={!oauthUrl}
              title={oauthUrl ? "点击复制完整授权链接" : "请先点击「开始 OAuth 授权」生成链接"}
              onClick={() => oauthUrl && onCopy(oauthUrl, "授权链接")}
            >
              <Copy size={14} className="ag-dashed-copy-icon" />
              <span className="ag-dashed-url">
                {oauthUrl || "点击上方「开始 OAuth 授权」后将在此生成授权链接…"}
              </span>
              <span className="ag-dashed-action">复制授权链接</span>
            </button>

            <button
              type="button"
              className="ag-outline-cta"
              disabled={busy || !oauthPending}
              onClick={() => void onCheckOAuth()}
            >
              <CheckCircle2 size={15} />
              我已授权，继续
            </button>
          </div>

          <div className="ag-manual-code-block">
            <span className="ag-manual-caption">
              浏览器没有自动跳转？请在此处粘贴回调链接或 AUTHORIZATION CODE:
            </span>
            <div className="ag-manual-row">
              <input
                type="text"
                value={manualCallback}
                disabled={busy}
                placeholder="粘贴回调链接或 Code..."
                aria-label="回调链接或 Authorization Code"
                onChange={event => setManualCallback(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && manualCallback.trim()) {
                    event.preventDefault();
                    void handleSubmitManualCode();
                  }
                }}
              />
              <button
                type="button"
                className="ag-manual-submit"
                disabled={busy || !manualCallback.trim()}
                onClick={() => void handleSubmitManualCode()}
              >
                <Link2 size={13} />
                提交
              </button>
            </div>
          </div>

          {!runningInTauri && (
            <p className="ag-preview-hint">提示：浏览器预览模式不支持本地回环 OAuth 监听，请在桌面客户端中完成授权，或切换至「Refresh Token」导入。</p>
          )}

          <div className="ag-modal-bottom-single">
            <button type="button" className="ag-cancel-wide" disabled={busy} onClick={onClose}>
              取消
            </button>
          </div>
        </section>
      )}

      {/* ── Tab 2: Refresh Token (single unified box for single / JSON / free-text batch) ── */}
      {method === "token" && (
        <section className="ag-add-section" role="tabpanel">
          <div className="ag-token-box">
            <label className="ag-token-label">
              <span>Refresh Token</span>
              <textarea
                value={tokenContent}
                rows={7}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  "在此处粘贴您的 Refresh Token（支持批量）\n\n支持格式：\n1. 单个 Token (1//...)\n2. JSON 数组（含 refresh_token 字段）\n3. 任意包含 Token 的文本（自动提取）"
                }
                onChange={event => setTokenContent(event.target.value)}
              />
            </label>
            <div className="ag-token-foot">
              <span className="ag-token-tip">提示：支持一次性粘贴多个 Token 或 JSON 数组，系统将自动识别并批量导入。</span>
              <label className="ag-inline-check">
                <input
                  type="checkbox"
                  checked={forceImport}
                  disabled={busy}
                  onChange={event => setForceImport(event.target.checked)}
                />
                <span>离线强制导入</span>
              </label>
            </div>
          </div>

          <div className="ag-modal-bottom-dual">
            <button type="button" className="ag-cancel-wide" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="ag-primary-cta"
              disabled={busy || !tokenContent.trim()}
              onClick={() => void handleSubmitTokens()}
            >
              {busy ? <Loader2 size={14} className="codex-refresh-spinning" /> : null}
              确认添加
            </button>
          </div>
        </section>
      )}

      {/* ── Tab 3: 从数据库导入 ── */}
      {method === "db" && (
        <section className="ag-add-section" role="tabpanel">
          <div className="ag-db-intro">
            <div className="ag-db-heading">
              <Database size={16} />
              <h4>自动扫描本地已登录账号</h4>
            </div>
            <p>
              自动对本地系统 Antigravity IDE、经典款及 CLI 目录进行全量扫描并批量导入已登录账号。
            </p>
          </div>

          <div className="ag-db-actions">
            <button
              type="button"
              className="ag-db-action-btn is-primary-outline"
              disabled={busy}
              onClick={() => void onScanLocalDb(accountType)}
            >
              {busy ? <Loader2 size={15} className="codex-refresh-spinning" /> : <CheckCircle2 size={15} />}
              <span>一键扫描并导入所有本地账号</span>
            </button>

            <button
              type="button"
              className="ag-db-action-btn"
              disabled={busy}
              onClick={() => void onImportCustomDb(accountType)}
            >
              <Database size={15} />
              <span>从自定义 DB 导入</span>
            </button>
          </div>

          {!runningInTauri && (
            <p className="ag-preview-hint">提示：浏览器预览模式无法读取本机文件与 SQLite 数据库，请在桌面客户端中使用此功能。</p>
          )}

          <div className="ag-modal-bottom-single">
            <button type="button" className="ag-cancel-wide" disabled={busy} onClick={onClose}>
              取消
            </button>
          </div>
        </section>
      )}
    </OverviewDialog>
  );
}

export function AntigravityExportDialog({
  count,
  exportText,
  busy,
  onClose,
  onCopy,
  onSaveFile,
}: {
  count: number;
  exportText: string;
  busy: boolean;
  onClose: () => void;
  onCopy: () => void;
  onSaveFile: () => void;
}) {
  return (
    <OverviewDialog
      sizeStorageKey="features/antigravity/export-dialog"
      title={`导出 Antigravity 账号 (${count} 个)`}
      busy={busy}
      onClose={onClose}
      className="ag-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>关闭</button>
          <button type="button" onClick={onCopy} disabled={busy || !exportText}><Copy size={14} />复制 JSON</button>
          <button type="button" className="ag-dialog-primary" onClick={onSaveFile} disabled={busy}><Download size={14} />保存为文件</button>
        </>
      }
    >
      <p className="ag-dialog-note">
        导出格式与 <code>lbjlaq/Antigravity-Manager</code> 兼容（<code>[{"{"}email, refresh_token{"}"}, ...]</code>）。请妥善保管导出文件中的 Refresh Token。
      </p>
      <textarea
        className="ag-export-textarea"
        readOnly
        rows={10}
        value={exportText}
      />
    </OverviewDialog>
  );
}

export function AntigravityEditDialog({
  account,
  busy,
  onClose,
  onSave,
}: {
  account: AntigravityAccount;
  busy: boolean;
  onClose: () => void;
  onSave: (input: { id: number; priority: number; customLabel: string; note: string; tags: string[] }) => Promise<void>;
}) {
  const [priority, setPriority] = useState(String(account.priority));
  const [customLabel, setCustomLabel] = useState(account.customLabel);
  const [note, setNote] = useState(account.note);
  const [tagsText, setTagsText] = useState(account.tags.join(", "));

  return (
    <OverviewDialog
      sizeStorageKey="features/antigravity/edit-dialog"
      title="编辑账号信息"
      layout="form"
      busy={busy}
      onClose={onClose}
      className="ag-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button
            type="button"
            className="ag-dialog-primary"
            disabled={busy}
            onClick={() => {
              const prio = Number.parseInt(priority, 10);
              const tags = tagsText
                .split(/[,，]/)
                .map(s => s.trim())
                .filter(Boolean);
              void onSave({
                id: account.id,
                priority: Number.isFinite(prio) ? Math.max(1, Math.min(100, prio)) : 50,
                customLabel: customLabel.trim(),
                note: note.trim(),
                tags,
              });
            }}
          >
            保存
          </button>
        </>
      }
    >
      <div className="ag-edit-email">{account.email}</div>
      <div className="ag-edit-grid">
        <label>
          调度优先级 (1–100，越小越优先)
          <input type="number" min={1} max={100} value={priority} disabled={busy} onChange={e => setPriority(e.target.value)} />
        </label>
        <label>
          自定义标签
          <input type="text" value={customLabel} disabled={busy} placeholder="例如：CLI / 主力" onChange={e => setCustomLabel(e.target.value)} />
        </label>
      </div>
      <label>
        分组标签（英文逗号分隔）
        <input type="text" value={tagsText} disabled={busy} placeholder="pro, team-a" onChange={e => setTagsText(e.target.value)} />
      </label>
      <label>
        备注
        <textarea rows={3} value={note} disabled={busy} onChange={e => setNote(e.target.value)} />
      </label>
    </OverviewDialog>
  );
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomUuidV4(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = randomHex(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function AntigravityActionsDialog({
  account,
  privacy,
  activeTargets,
  busy,
  onClose,
  onSwitchTarget,
  onOpenTags,
  onOpenLogs,
  onWarmup,
  onOpenDeviceProfile,
  onOpenDetails,
  onExportJson,
  onDelete,
}: {
  account: AntigravityAccount;
  privacy: boolean;
  activeTargets: AntigravitySwitchTarget[];
  busy: boolean;
  onClose: () => void;
  onSwitchTarget: (target: AntigravitySwitchTarget) => Promise<void>;
  onOpenTags: () => void;
  onOpenLogs: () => void;
  onWarmup: () => Promise<string>;
  onOpenDeviceProfile: () => void;
  onOpenDetails: () => void;
  onExportJson: () => void;
  onDelete: () => void;
}) {
  const [switchingTarget, setSwitchingTarget] = useState<AntigravitySwitchTarget | null>(null);
  const [warming, setWarming] = useState(false);
  const [feedback, setFeedback] = useState<{ status: FeedbackStatus; message: string }>({ status: "idle", message: "" });
  const displayEmail = privacy ? account.email.replace(/(^.).*(@.*$)/, "$1***$2") : account.email;
  const anyBusy = busy || switchingTarget != null || warming;

  const quickTargets: {
    id: AntigravitySwitchTarget;
    title: string;
    desc: string;
    tone: "blue" | "purple" | "emerald" | "amber";
    icon: ReactNode;
  }[] = [
    {
      id: "ide",
      title: "Antigravity IDE (VS Code 版)",
      desc: "一键切换此账号到 IDE 客户端登录",
      tone: "blue",
      icon: <Repeat2 size={17} />,
    },
    {
      id: "jeb",
      title: "Antigravity IDE 插件 (ACP - JetBrains)",
      desc: "一键切换此账号到 JetBrains / Android Studio 插件",
      tone: "purple",
      icon: <Blocks size={17} />,
    },
    {
      id: "cli",
      title: "Antigravity CLI (agy)",
      desc: "一键切换此账号到命令行工具登录",
      tone: "emerald",
      icon: <Terminal size={17} />,
    },
    {
      id: "antigravity",
      title: "Antigravity",
      desc: "一键切换此账号到 Antigravity 客户端",
      tone: "amber",
      icon: <ArrowLeftRight size={17} />,
    },
  ];

  async function handleQuickSwitch(target: AntigravitySwitchTarget) {
    if (anyBusy) return;
    setSwitchingTarget(target);
    setFeedback({ status: "idle", message: "" });
    try {
      await onSwitchTarget(target);
      setFeedback({ status: "success", message: "切换指令已执行" });
    } catch (reason) {
      setFeedback({ status: "error", message: platformErrorMessage(reason, "切换账号失败") });
    } finally {
      setSwitchingTarget(null);
    }
  }

  async function handleWarmup() {
    if (anyBusy) return;
    setWarming(true);
    setFeedback({ status: "loading", message: "正在触发连通性探测并预热配额周期…" });
    try {
      const detail = await onWarmup();
      setFeedback({ status: "success", message: detail });
    } catch (reason) {
      setFeedback({ status: "error", message: platformErrorMessage(reason, "账号预热失败") });
    } finally {
      setWarming(false);
    }
  }

  const hasDeviceProfile = Boolean(
    account.deviceProfile &&
      (account.deviceProfile.machineId ||
        account.deviceProfile.macMachineId ||
        account.deviceProfile.devDeviceId ||
        account.deviceProfile.sqmId),
  );

  return (
    <OverviewDialog
      sizeStorageKey="features/antigravity/actions-dialog-v1"
      title="账号操作总览"
      busy={anyBusy}
      onClose={onClose}
      className="ag-dialog ag-actions-modal"
      footer={<button type="button" onClick={onClose} disabled={anyBusy}>关闭</button>}
    >
      <div className="ag-actions-subtitle" title={privacy ? undefined : account.email}>
        {displayEmail}
      </div>

      <StatusBanner status={feedback.status} message={feedback.message} />

      {/* ── Section 1: Client Quick Switch (2x2) ── */}
      <section className="ag-actions-section" aria-label="客户端快速切换">
        <h4 className="ag-actions-heading">客户端快速切换</h4>
        <div className="ag-quick-switch-grid">
          {quickTargets.map(item => {
            const isActive = activeTargets.includes(item.id);
            const isSwitching = switchingTarget === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`ag-quick-switch-card${isActive ? " is-active" : ""}`}
                disabled={anyBusy}
                onClick={() => void handleQuickSwitch(item.id)}
              >
                <span className={`ag-action-icon-box is-${item.tone}`}>
                  {isSwitching ? <Loader2 size={17} className="codex-refresh-spinning" /> : item.icon}
                </span>
                <span className="ag-action-card-copy">
                  <span className="ag-action-card-title-row">
                    <strong>{item.title}</strong>
                    {isActive && <span className="ag-quick-active-tag">当前</span>}
                  </span>
                  <small>{item.desc}</small>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Section 2: Maintenance & Tools ── */}
      <section className="ag-actions-section" aria-label="账号维护与工具">
        <h4 className="ag-actions-heading">账号维护与工具</h4>
        <div className="ag-tool-rows">
          <button type="button" className="ag-tool-row-card" disabled={anyBusy} onClick={onOpenLogs}>
            <span className="ag-action-icon-box is-indigo"><History size={16} /></span>
            <span className="ag-action-card-copy">
              <strong>查看日志</strong>
              <small>查看配额刷新结果、查询地址与请求参数</small>
            </span>
          </button>
          <button type="button" className="ag-tool-row-card" disabled={anyBusy} onClick={onOpenTags}>
            <span className="ag-action-icon-box is-indigo"><Tag size={16} /></span>
            <span className="ag-action-card-copy">
              <strong>标签管理</strong>
              <small>为此账号添加、删除或重新排序标签</small>
            </span>
            <span className="ag-tool-row-trailing">
              {account.tags.length > 0 ? (
                <span className="ag-tool-tags-preview">
                  {account.tags.slice(0, 3).map(tag => (
                    <span key={tag} className="ag-tag-custom">{tag}</span>
                  ))}
                  {account.tags.length > 3 && <span className="ag-tool-muted-label">+{account.tags.length - 3}</span>}
                </span>
              ) : (
                <span className="ag-tool-empty-val">无</span>
              )}
            </span>
          </button>

          <button type="button" className="ag-tool-row-card" disabled={anyBusy} onClick={() => void handleWarmup()}>
            <span className="ag-action-icon-box is-cyan">
              {warming ? <Loader2 size={16} className="codex-refresh-spinning" /> : <Sparkles size={16} />}
            </span>
            <span className="ag-action-card-copy">
              <strong>账号预热</strong>
              <small>触发连通性探测并预热配额周期</small>
            </span>
            {warming && <span className="ag-tool-row-trailing"><span className="ag-tool-muted-label">探测中…</span></span>}
          </button>

          <button type="button" className="ag-tool-row-card" disabled={anyBusy} onClick={onOpenDeviceProfile}>
            <span className="ag-action-icon-box is-teal"><Smartphone size={16} /></span>
            <span className="ag-action-card-copy">
              <strong>设备指纹配置</strong>
              <small>查看或修改 machineId、devDeviceId 等硬件指纹</small>
            </span>
            <span className="ag-tool-row-trailing">
              {hasDeviceProfile ? (
                <span className="ag-tool-badge-ok">已配置</span>
              ) : (
                <span className="ag-tool-empty-val">默认</span>
              )}
            </span>
          </button>

          <button type="button" className="ag-tool-row-card" disabled={anyBusy} onClick={onOpenDetails}>
            <span className="ag-action-icon-box is-blue"><Info size={16} /></span>
            <span className="ag-action-card-copy">
              <strong>账号详细信息</strong>
              <small>查看详细配额、模型状态与原始凭据数据</small>
            </span>
          </button>

          <button type="button" className="ag-tool-row-card" disabled={anyBusy} onClick={onExportJson}>
            <span className="ag-action-icon-box is-blue"><Download size={16} /></span>
            <span className="ag-action-card-copy">
              <strong>导出凭据 JSON</strong>
              <small>导出此账号的完整授权凭据配置文件</small>
            </span>
          </button>
        </div>
      </section>

      {/* ── Section 3: Danger Zone ── */}
      <section className="ag-actions-section" aria-label="危险操作区">
        <h4 className="ag-actions-heading is-danger">危险操作区</h4>
        <button type="button" className="ag-danger-action-card" disabled={anyBusy} onClick={onDelete}>
          <span className="ag-action-icon-box is-danger"><Trash2 size={16} /></span>
          <span className="ag-action-card-copy">
            <strong>从管理器删除该账号</strong>
            <small>永久移除此账号记录（不影响上游 Google 账号本身）</small>
          </span>
          <span className="ag-danger-action-label">删除</span>
        </button>
      </section>
    </OverviewDialog>
  );
}

export function AntigravityTagsDialog({
  account,
  privacy,
  onClose,
  onSave,
}: {
  account: AntigravityAccount;
  privacy: boolean;
  onClose: () => void;
  onSave: (tags: string[]) => Promise<void>;
}) {
  const [tags, setTags] = useState<string[]>(account.tags);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const displayEmail = privacy ? account.email.replace(/(^.).*(@.*$)/, "$1***$2") : account.email;

  function addTag() {
    const cleaned = draft.trim();
    if (!cleaned) return;
    if (cleaned.length > 40) {
      setError("单个标签长度不能超过 40 个字符");
      return;
    }
    if (tags.some(t => t.toLowerCase() === cleaned.toLowerCase())) {
      setError("该标签已存在");
      return;
    }
    setTags(prev => [...prev, cleaned]);
    setDraft("");
    setError("");
  }

  function moveTag(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= tags.length) return;
    setTags(prev => {
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }

  function removeTag(index: number) {
    setTags(prev => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(tags);
      onClose();
    } catch (reason) {
      setError(platformErrorMessage(reason, "保存标签失败"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <OverviewDialog
      sizeStorageKey="features/antigravity/tags-dialog-v1"
      title="标签管理"
      busy={saving}
      onClose={onClose}
      className="ag-dialog ag-sub-modal"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="ag-dialog-primary" onClick={() => void handleSave()} disabled={saving}>
            {saving && <Loader2 size={13} className="codex-refresh-spinning" />}
            保存标签
          </button>
        </>
      }
    >
      <div className="ag-edit-email">{displayEmail}</div>
      {error && <StatusBanner status="error" message={error} />}

      <div className="ag-tag-add-row">
        <input
          type="text"
          value={draft}
          disabled={saving}
          placeholder="输入新标签名称，按回车添加…"
          aria-label="新增标签"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
        />
        <button type="button" className="ag-setting-action-btn" disabled={saving || !draft.trim()} onClick={addTag}>
          <Plus size={13} />
          添加
        </button>
      </div>

      {tags.length > 0 ? (
        <ul className="ag-tag-manage-list" aria-label="当前账号标签列表">
          {tags.map((tag, idx) => (
            <li key={`${tag}-${idx}`} className="ag-tag-manage-item">
              <span className="ag-tag-manage-name">
                <Tag size={12} aria-hidden="true" />
                {tag}
              </span>
              <span className="ag-tag-manage-ops">
                <button
                  type="button"
                  className="ag-inline-icon-btn"
                  title="上移"
                  aria-label={`上移标签 ${tag}`}
                  disabled={saving || idx === 0}
                  onClick={() => moveTag(idx, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="ag-inline-icon-btn"
                  title="下移"
                  aria-label={`下移标签 ${tag}`}
                  disabled={saving || idx === tags.length - 1}
                  onClick={() => moveTag(idx, 1)}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  type="button"
                  className="ag-inline-icon-btn is-danger"
                  title="删除"
                  aria-label={`删除标签 ${tag}`}
                  disabled={saving}
                  onClick={() => removeTag(idx)}
                >
                  <X size={13} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ag-muted-text">当前账号暂无标签，可在上方输入并添加，支持调整展示顺序。</p>
      )}
    </OverviewDialog>
  );
}

const deviceFields = ["machineId", "macMachineId", "devDeviceId", "sqmId"] as const;
const emptyDeviceProfile: AntigravityDeviceProfile = { machineId: "", macMachineId: "", devDeviceId: "", sqmId: "" };

function DeviceProfileValues({ profile }: { profile: AntigravityDeviceProfile }) {
  return <dl className="ag-device-values">{deviceFields.map(key => <div key={key}>
    <dt>{key}</dt><dd>{profile[key] || "—"}</dd>
  </div>)}</dl>;
}

export function AntigravityDeviceProfileDialog({ account, privacy, onClose, onSave }: {
  account: AntigravityAccount;
  privacy: boolean;
  onClose: () => void;
  onSave: (profile: AntigravityDeviceProfile, deleteHistoryId?: string) => Promise<void>;
}) {
  const [local, setLocal] = useState<AntigravityDeviceProfile | null>(null);
  const [target, setTarget] = useState<"antigravity" | "ide">("antigravity");
  const [storageMessage, setStorageMessage] = useState("正在读取本机存储…");
  const [draft, setDraft] = useState(account.deviceProfile ?? emptyDeviceProfile);
  const [busy, setBusy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [feedback, setFeedback] = useState<{ status: FeedbackStatus; message: string }>({ status: "idle", message: "" });
  const binding = account.deviceProfile;
  const applied = !!local && !!binding && deviceFields.every(key => !binding[key] || local[key] === binding[key]);
  const label = privacy ? account.email.replace(/(^.).*(@.*$)/, "$1***$2") : account.email;

  useEffect(() => {
    let active = true;
    setLocal(null);
    setStorageMessage("正在读取本机存储…");
    void antigravityClient.readLocalDeviceProfile(target).then(profile => {
      if (active) { setLocal(profile); setStorageMessage(""); }
    }).catch(error => {
      if (active) setStorageMessage(platformErrorMessage(error, "读取本机指纹失败"));
    });
    return () => { active = false; };
  }, [target]);

  async function run(action: () => Promise<void>, message?: string) {
    if (busy) return;
    setBusy(true);
    setFeedback({ status: "idle", message: "" });
    try {
      await action();
      if (message) setFeedback({ status: "success", message });
    } catch (reason) {
      setFeedback({ status: "error", message: platformErrorMessage(reason, "设备指纹操作失败") });
    } finally {
      setBusy(false);
    }
  }

  function bind(profile: AntigravityDeviceProfile) {
    return run(async () => {
      await onSave(profile);
      setDraft(profile);
    }, Object.values(profile).some(value => value.trim()) ? "设备指纹已绑定" : "设备指纹绑定已清除");
  }

  return <>
    <OverviewDialog sizeStorageKey="features/antigravity/device-profile-dialog-v2"
      title="设备指纹配置" layout="form" busy={busy} onClose={onClose} className="ag-dialog ag-device-modal"
      footer={<button type="button" onClick={onClose} disabled={busy}>关闭</button>}>
      <div className="ag-edit-email">{label}</div>
      <div className="ag-device-toolbar">
        <select aria-label="设备指纹存储目标" value={target} disabled={busy}
          onChange={event => setTarget(event.target.value === "ide" ? "ide" : "antigravity")}>
          <option value="antigravity">Antigravity</option>
          <option value="ide">Antigravity IDE</option>
        </select>
        <button type="button" disabled={busy} onClick={() => void bind({
          machineId: `auth0|user_${randomHex(32)}`, macMachineId: randomUuidV4(),
          devDeviceId: randomUuidV4(), sqmId: `{${randomUuidV4().toUpperCase()}}`,
        })}><Shuffle size={14} />生成并绑定</button>
        <button type="button" disabled={busy} onClick={() => setConfirmRestore(true)}><RotateCcw size={14} />恢复原始</button>
        <button type="button" disabled={busy} onClick={() => void run(() => antigravityClient.deviceStorageAction("open", target))}><FolderOpen size={14} />打开存储目录</button>
      </div>
      <StatusBanner status={feedback.status} message={feedback.message} />
      <div className="ag-device-comparison">
        <section className="ag-device-card">
          <h3>当前存储 <small>{local ? (Object.values(local).some(Boolean) ? "已读取" : "无指纹字段") : ""}</small></h3>
          {local ? <DeviceProfileValues profile={local} /> : <p role="status">{storageMessage}</p>}
        </section>
        <section className="ag-device-card">
          <h3>账号绑定 <small>{binding ? (applied ? "已生效" : local ? "待应用" : "已绑定") : "未绑定"}</small></h3>
          {binding ? <DeviceProfileValues profile={binding} /> : <p>此账号还没有绑定设备指纹。</p>}
          <p>切换至 Antigravity 或 IDE 时应用到对应客户端。</p>
        </section>
      </div>
      <section className="ag-device-card">
        <h3>历史指纹</h3>
        {account.deviceHistory?.length ? <ul className="ag-device-history">{account.deviceHistory.map(entry => {
          const current = sameAntigravityDeviceProfile(entry.profile, binding);
          return <li key={entry.fingerprintId}>
            <div className="ag-device-history-heading">
              <span>{new Date(entry.createdAt).toLocaleString("zh-CN")}{current && " · 当前绑定"}</span>
              <div>
                <button type="button" disabled={busy || current} onClick={() => void bind(entry.profile)}>恢复绑定</button>
                {!current && <button type="button" disabled={busy} aria-label="删除此历史指纹"
                  onClick={() => void run(() => onSave(emptyDeviceProfile, entry.fingerprintId), "历史指纹已删除")}><Trash2 size={14} /></button>}
              </div>
            </div>
            <DeviceProfileValues profile={entry.profile} />
          </li>;
        })}</ul> : <p>暂无历史指纹。</p>}
      </section>
      <details className="ag-device-card">
        <summary>手动编辑绑定</summary>
        <div className="ag-device-fields">{deviceFields.map(key => <label key={key}>{key}
          <input value={draft[key]} disabled={busy} maxLength={160}
            onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />
        </label>)}</div>
        <div className="ag-device-toolbar">
          <button type="button" disabled={busy || !local} onClick={() => local && setDraft(local)}>填入当前存储</button>
          <button type="button" disabled={busy || !binding} onClick={() => void bind(emptyDeviceProfile)}>清除绑定</button>
          <button type="button" disabled={busy} onClick={() => void bind(draft)}>保存绑定</button>
        </div>
      </details>
    </OverviewDialog>
    {confirmRestore && <ConfirmDialog title="恢复原始设备指纹"
      message="将本机设备指纹恢复至 CloudHub 首次写入前的备份。"
      detail="建议先退出 Antigravity 客户端。账号绑定与历史记录会继续保留。"
      confirmLabel="恢复原始" onResolve={confirmed => {
        setConfirmRestore(false);
        if (confirmed) void run(async () => {
          await antigravityClient.deviceStorageAction("restore", target);
          setLocal(await antigravityClient.readLocalDeviceProfile(target));
          setStorageMessage("");
        }, "本机原始设备指纹已恢复");
      }} />}
  </>;
}

type ModelFamilyKey = "claude" | "gemini" | "gpt";
type DetailTab = "models" | "groups";

function classifyModelFamily(name: string, displayName?: string | null): ModelFamilyKey | "other" {
  const hay = `${name} ${displayName ?? ""}`.toLowerCase();
  if (hay.includes("claude")) return "claude";
  if (hay.includes("gemini")) return "gemini";
  if (hay.includes("gpt")) return "gpt";
  return "other";
}

function modelQuotaTone(pct: number): "good" | "warn" | "zero" {
  if (pct <= 0) return "zero";
  if (pct <= 50) return "warn";
  return "good";
}

function formatDetailResetDate(resetIso: string | undefined): string {
  if (!resetIso) return "";
  const ms = Date.parse(resetIso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDetailCountdown(resetIso: string | undefined): string {
  if (!resetIso) return "";
  const ms = Date.parse(resetIso);
  if (!Number.isFinite(ms)) return "";
  const diffMs = ms - Date.now();
  if (diffMs <= 0) return "0h 0m";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}

function ModelFamilyIcon({ family }: { family: ModelFamilyKey | "other" }) {
  if (family === "gemini") {
    return (
      <svg className="ag-detail-gemini-star" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <defs>
          <linearGradient id="ag-detail-gemini-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#4285F4" />
            <stop offset="52%" stopColor="#8B5CF6" />
            <stop offset="100%" stopColor="#EC4899" />
          </linearGradient>
        </defs>
        <path
          fill="url(#ag-detail-gemini-grad)"
          d="M8 0.8C8.4 4.5 11.5 7.6 15.2 8C11.5 8.4 8.4 11.5 8 15.2C7.6 11.5 4.5 8.4 0.8 8C4.5 7.6 7.6 4.5 8 0.8Z"
        />
      </svg>
    );
  }
  if (family === "claude") {
    return <Sparkles size={15} className="ag-detail-claude-icon" aria-hidden="true" />;
  }
  if (family === "gpt") {
    return <Bot size={15} className="ag-detail-gpt-icon" aria-hidden="true" />;
  }
  return <Bot size={15} className="ag-detail-other-icon" aria-hidden="true" />;
}

function formatGroupDisplayTitle(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return "配额分组";
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed;
  const hasGemini = lower.includes("gemini");
  const hasClaude = lower.includes("claude") || lower.includes("anthropic");
  const hasGpt = lower.includes("gpt") || lower.includes("openai");
  if (hasGemini && !hasClaude && !hasGpt) return "Gemini 模型";
  if (hasClaude && hasGpt) return "Claude 与 GPT 模型";
  if (hasClaude) return "Claude 模型";
  if (hasGpt) return "GPT 模型";
  return trimmed;
}

function formatBucketWindowTitle(bucket: AntigravityQuotaBucket): string {
  const hay = `${bucket.window} ${bucket.bucketId} ${bucket.displayName ?? ""}`.toLowerCase();
  if (hay.includes("week") || hay.includes("7d") || hay.includes("168h")) {
    return "7天周配额 (WEEKLY)";
  }
  if (hay.includes("5h") || hay.includes("five")) {
    return "5小时配额 (5H)";
  }
  if (hay.includes("day") || hay.includes("daily") || hay.includes("24h")) {
    return "24小时日配额 (DAILY)";
  }
  const base = (bucket.displayName || bucket.window || bucket.bucketId || "配额窗口").trim();
  const suffix = bucket.window?.trim();
  if (suffix && !base.toUpperCase().includes(suffix.toUpperCase())) {
    return `${base} (${suffix.toUpperCase()})`;
  }
  return base;
}

function stripVariantSuffix(name: string): string {
  return name.replace(/\s*\((High|Medium|Low|XHigh|Thinking)\)\s*$/i, "").trim();
}

function resolveGroupIncludedModels(
  group: AntigravityQuotaGroup,
  allModels: AntigravityModelQuota[],
): string[] {
  const idToDisplay = new Map(allModels.map(m => [m.name.toLowerCase(), m.displayName || m.name]));
  let rawLabels: string[] = [];
  if (group.models && group.models.length > 0) {
    rawLabels = group.models.map(item => idToDisplay.get(item.toLowerCase()) || item);
  } else if (allModels.length > 0) {
    const gLower = group.displayName.toLowerCase();
    const wantsGemini = gLower.includes("gemini");
    const wantsClaudeOrGpt =
      gLower.includes("claude") || gLower.includes("gpt") || gLower.includes("anthropic") || gLower.includes("openai");
    const matched = allModels.filter(m => {
      const fam = classifyModelFamily(m.name, m.displayName);
      if (wantsGemini && !wantsClaudeOrGpt) return fam === "gemini";
      if (wantsClaudeOrGpt && !wantsGemini) return fam === "claude" || fam === "gpt";
      return true;
    });
    rawLabels = matched.map(m => m.displayName || m.name);
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawLabels) {
    const clean = stripVariantSuffix(raw);
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) {
      seen.add(key);
      deduped.push(clean);
    }
  }
  return deduped;
}

function pickGroupBottleneck(
  group: AntigravityQuotaGroup | undefined,
): { percentage: number; resetTime: string } | null {
  const buckets = group?.buckets ?? [];
  if (!buckets.length) return null;
  let best = buckets[0];
  let bestPct = Math.round(Math.max(0, Math.min(1, best.remainingFraction)) * 100);
  for (const b of buckets.slice(1)) {
    const pct = Math.round(Math.max(0, Math.min(1, b.remainingFraction)) * 100);
    if (pct < bestPct || (pct === bestPct && Boolean(b.resetTime) && !best.resetTime)) {
      best = b;
      bestPct = pct;
    }
  }
  return { percentage: bestPct, resetTime: best.resetTime || "" };
}

function reconcileModelsWithGroups(
  rawModels: AntigravityModelQuota[],
  quotaGroups: AntigravityQuotaGroup[],
): AntigravityModelQuota[] {
  if (!rawModels.length || !quotaGroups.length) return rawModels;
  const geminiBottleneck = pickGroupBottleneck(
    quotaGroups.find(g => /gemini/i.test(g.displayName)),
  );
  const claudeGptBottleneck = pickGroupBottleneck(
    quotaGroups.find(g => /claude|gpt|anthropic|openai|3p/i.test(g.displayName)),
  );
  return rawModels.map(model => {
    const family = classifyModelFamily(model.name, model.displayName);
    if ((family === "claude" || family === "gpt") && claudeGptBottleneck) {
      if (
        claudeGptBottleneck.percentage < model.percentage ||
        (model.percentage === 100 && Boolean(claudeGptBottleneck.resetTime))
      ) {
        return {
          ...model,
          percentage: claudeGptBottleneck.percentage,
          resetTime: claudeGptBottleneck.resetTime || model.resetTime,
        };
      }
    } else if (family === "gemini" && geminiBottleneck && geminiBottleneck.percentage < model.percentage) {
      return {
        ...model,
        percentage: geminiBottleneck.percentage,
        resetTime: geminiBottleneck.resetTime || model.resetTime,
      };
    }
    return model;
  });
}

function parseOptionalPriority(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < 1 || value > 100) return "invalid";
  return value;
}

export function AntigravityDetailsDialog({
  account,
  privacy,
  onClose,
  onSavePriorities,
  onSaveProjectId,
  onFetchProjectId,
}: {
  account: AntigravityAccount;
  privacy: boolean;
  onClose: () => void;
  onSavePriorities: (input: {
    id: number;
    priority: number;
    geminiPriority: number | null;
    claudePriority: number | null;
  }) => Promise<void>;
  onSaveProjectId: (id: number, projectId: string) => Promise<void>;
  onFetchProjectId: (id: number) => Promise<void>;
}) {
  const [detailTab, setDetailTab] = useState<DetailTab>("models");
  const [activeFamily, setActiveFamily] = useState<ModelFamilyKey | null>(null);

  const [defaultPrioDraft, setDefaultPrioDraft] = useState(String(account.priority));
  const [geminiPrioDraft, setGeminiPrioDraft] = useState(account.geminiPriority == null ? "" : String(account.geminiPriority));
  const [claudePrioDraft, setClaudePrioDraft] = useState(account.claudePriority == null ? "" : String(account.claudePriority));
  const [savingPrio, setSavingPrio] = useState(false);

  const [projectIdDraft, setProjectIdDraft] = useState(account.projectId ?? "");
  const [savingProject, setSavingProject] = useState(false);
  const [fetchingProject, setFetchingProject] = useState(false);

  const [inlineFeedback, setInlineFeedback] = useState<{ status: FeedbackStatus; message: string }>({
    status: "idle",
    message: "",
  });

  useEffect(() => {
    setDefaultPrioDraft(String(account.priority));
    setGeminiPrioDraft(account.geminiPriority == null ? "" : String(account.geminiPriority));
    setClaudePrioDraft(account.claudePriority == null ? "" : String(account.claudePriority));
  }, [account.id, account.priority, account.geminiPriority, account.claudePriority]);

  useEffect(() => {
    setProjectIdDraft(account.projectId ?? "");
  }, [account.id, account.projectId]);

  const displayEmail = privacy ? account.email.replace(/(^.).*(@.*$)/, "$1***$2") : account.email;
  const quotaGroups = account.quota.quotaGroups ?? [];
  const models = reconcileModelsWithGroups(account.quota.models, quotaGroups);
  const totalBuckets = quotaGroups.reduce((sum, g) => sum + (g.buckets?.length ?? 0), 0);

  const familyTabs: {
    key: ModelFamilyKey;
    label: string;
    count: number;
    pct: number | null;
    rangeTip: string;
  }[] = (
    [
      { key: "claude", label: "Claude" },
      { key: "gemini", label: "Gemini" },
      { key: "gpt", label: "GPT" },
    ] as const
  ).map(def => {
    const matched = models.filter(m => classifyModelFamily(m.name, m.displayName) === def.key);
    if (!matched.length) {
      return { key: def.key, label: def.label, count: 0, pct: null, rangeTip: `${def.label}：暂无模型数据` };
    }
    const minPct = Math.min(...matched.map(m => m.percentage));
    const maxPct = Math.max(...matched.map(m => m.percentage));
    const rangeTip =
      minPct === maxPct
        ? `${def.label}（${matched.length} 个模型）：剩余 ${minPct}%`
        : `${def.label}（${matched.length} 个模型）：剩余 ${minPct}% ~ ${maxPct}%`;
    return { key: def.key, label: def.label, count: matched.length, pct: minPct, rangeTip };
  });

  const filteredModels = activeFamily
    ? models.filter(m => classifyModelFamily(m.name, m.displayName) === activeFamily)
    : models;

  async function handleSavePriorities() {
    if (savingPrio) return;
    const defVal = parseOptionalPriority(defaultPrioDraft);
    const gemVal = parseOptionalPriority(geminiPrioDraft);
    const claudeVal = parseOptionalPriority(claudePrioDraft);
    if (defVal === null || defVal === "invalid") {
      setInlineFeedback({ status: "error", message: "默认优先级必须为 1 到 100 之间的整数" });
      return;
    }
    if (gemVal === "invalid") {
      setInlineFeedback({ status: "error", message: "Gemini 优先级留空或输入 1 到 100 之间的整数" });
      return;
    }
    if (claudeVal === "invalid") {
      setInlineFeedback({ status: "error", message: "Claude 优先级留空或输入 1 到 100 之间的整数" });
      return;
    }
    setSavingPrio(true);
    setInlineFeedback({ status: "idle", message: "" });
    try {
      await onSavePriorities({
        id: account.id,
        priority: defVal,
        geminiPriority: gemVal,
        claudePriority: claudeVal,
      });
      setInlineFeedback({ status: "success", message: "优先级设置已保存" });
    } catch (reason) {
      setInlineFeedback({ status: "error", message: platformErrorMessage(reason, "保存优先级失败") });
    } finally {
      setSavingPrio(false);
    }
  }

  async function handleSaveProjectId() {
    if (savingProject || fetchingProject) return;
    setSavingProject(true);
    setInlineFeedback({ status: "idle", message: "" });
    try {
      await onSaveProjectId(account.id, projectIdDraft);
      setInlineFeedback({ status: "success", message: projectIdDraft.trim() ? "GCP Project ID 已保存" : "已清空 GCP Project ID" });
    } catch (reason) {
      setInlineFeedback({ status: "error", message: platformErrorMessage(reason, "保存 GCP Project ID 失败") });
    } finally {
      setSavingProject(false);
    }
  }

  async function handleFetchProjectId() {
    if (savingProject || fetchingProject) return;
    setFetchingProject(true);
    setInlineFeedback({ status: "idle", message: "" });
    try {
      await onFetchProjectId(account.id);
      setInlineFeedback({ status: "success", message: "已从 Google Code Assist 自动获取并保存 GCP Project ID" });
    } catch (reason) {
      setInlineFeedback({ status: "error", message: platformErrorMessage(reason, "自动获取 GCP Project ID 失败") });
    } finally {
      setFetchingProject(false);
    }
  }

  const defaultPlaceholder = /^\d+$/.test(defaultPrioDraft.trim()) ? defaultPrioDraft.trim() : String(account.priority);

  return (
    <OverviewDialog
      sizeStorageKey="features/antigravity/details-dialog-v3"
      title="配额详情"
      busy={savingPrio || savingProject || fetchingProject}
      onClose={onClose}
      className="ag-dialog ag-details-modal"
      footer={<button type="button" onClick={onClose}>关闭</button>}
    >
      {/* ── Account identity strip ── */}
      <div className="ag-detail-identity-bar">
        <span className="ag-detail-email-pill" title={privacy ? undefined : account.email}>
          {displayEmail}
        </span>
        <span className="ag-tier-badge" data-tier={account.subscriptionTier.toUpperCase()}>
          {account.subscriptionTier.toUpperCase()}
        </span>
      </div>

      {account.lastError && <p className="ag-card-error ag-detail-error">{account.lastError}</p>}
      <StatusBanner status={inlineFeedback.status} message={inlineFeedback.message} />

      {/* ── Settings Card 1: Priority (Default / Gemini / Claude) ── */}
      <section className="ag-detail-setting-card" aria-label="调度优先级设置">
        <div className="ag-setting-card-head">
          <div className="ag-setting-card-copy">
            <div className="ag-setting-card-title">
              <strong>优先级</strong>
              <span className="ag-setting-pill is-blue">{account.priority}</span>
            </div>
            <p className="ag-setting-card-desc">
              1–100，数字越小越优先。支持按模型族（Gemini / Claude）设置独立优先级，未设置时跟随账号默认优先级。
            </p>
          </div>
          <button
            type="button"
            className="ag-setting-save-btn"
            disabled={savingPrio}
            onClick={() => void handleSavePriorities()}
          >
            {savingPrio && <Loader2 size={12} className="codex-refresh-spinning" />}
            保存
          </button>
        </div>

        <div className="ag-priority-cards">
          <label className="ag-prio-subcard">
            <span className="ag-prio-subcard-copy">
              <strong>默认优先级</strong>
              <small>全模型兜底基准</small>
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={defaultPrioDraft}
              disabled={savingPrio}
              aria-label="默认优先级"
              onChange={e => setDefaultPrioDraft(e.target.value)}
            />
          </label>

          <label className="ag-prio-subcard">
            <span className="ag-prio-subcard-copy">
              <strong className="is-gemini">Gemini 优先级</strong>
              <small>留空则跟随默认</small>
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={geminiPrioDraft}
              placeholder={defaultPlaceholder}
              disabled={savingPrio}
              aria-label="Gemini 优先级"
              onChange={e => setGeminiPrioDraft(e.target.value)}
            />
          </label>

          <label className="ag-prio-subcard">
            <span className="ag-prio-subcard-copy">
              <strong className="is-claude">Claude 优先级</strong>
              <small>留空则跟随默认</small>
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={claudePrioDraft}
              placeholder={defaultPlaceholder}
              disabled={savingPrio}
              aria-label="Claude 优先级"
              onChange={e => setClaudePrioDraft(e.target.value)}
            />
          </label>
        </div>
      </section>

      {/* ── Settings Card 2: GCP Project ID ── */}
      <section className="ag-detail-setting-card ag-project-card" aria-label="GCP Project ID 设置">
        <div className="ag-project-card-row">
          <div className="ag-setting-card-copy">
            <div className="ag-setting-card-title">
              <strong>GCP Project ID</strong>
              {account.projectId && (
                <code className="ag-setting-pill is-green" title={privacy ? undefined : account.projectId}>
                  {privacy ? "***" : account.projectId}
                </code>
              )}
            </div>
            <p className="ag-setting-card-desc">
              企业/GCP 账号关联的 Google Cloud 项目 ID。原生 Antigravity 在登录后会自动关联或使用缺省项目。
            </p>
          </div>
          <div className="ag-project-controls">
            <input
              type="text"
              className="ag-project-input"
              value={privacy && projectIdDraft === (account.projectId ?? "") && projectIdDraft ? "***" : projectIdDraft}
              readOnly={privacy && projectIdDraft === (account.projectId ?? "") && Boolean(projectIdDraft)}
              disabled={savingProject || fetchingProject}
              placeholder="输入 Project ID"
              aria-label="GCP Project ID"
              onChange={e => setProjectIdDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveProjectId();
                }
              }}
            />
            <button
              type="button"
              className="ag-setting-action-btn"
              disabled={savingProject || fetchingProject}
              onClick={() => void handleFetchProjectId()}
            >
              {fetchingProject && <Loader2 size={12} className="codex-refresh-spinning" />}
              自动获取
            </button>
            <button
              type="button"
              className="ag-setting-save-btn"
              disabled={savingProject || fetchingProject}
              onClick={() => void handleSaveProjectId()}
            >
              {savingProject && <Loader2 size={12} className="codex-refresh-spinning" />}
              保存
            </button>
          </div>
        </div>
      </section>

      {/* ── Sub-tabs + 3 color-block model family tabs ── */}
      <div className="ag-detail-nav-row">
        <div className="ag-detail-subtabs" role="tablist" aria-label="配额视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={detailTab === "models"}
            onClick={() => setDetailTab("models")}
          >
            具体模型配额 ({activeFamily ? `${filteredModels.length}/${models.length}` : models.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={detailTab === "groups"}
            onClick={() => setDetailTab("groups")}
          >
            <Layers size={13} />
            配额分组窗口{totalBuckets > 0 ? ` (${totalBuckets})` : ""}
          </button>
        </div>

        {detailTab === "models" && (
          <div className="ag-detail-family-tabs" role="group" aria-label="按模型类型筛选">
            {familyTabs.map(tab => {
              const selected = activeFamily === tab.key;
              const pctValue = tab.pct;
              return (
                <button
                  key={tab.key}
                  type="button"
                  className={`ag-family-chip is-${tab.key}${selected ? " is-active" : ""}${tab.count === 0 ? " is-empty" : ""}`}
                  aria-pressed={selected}
                  disabled={tab.count === 0}
                  title={`${tab.rangeTip}${selected ? "（再次点击显示全部）" : "（点击仅看此类模型）"}`}
                  onClick={() => setActiveFamily(prev => (prev === tab.key ? null : tab.key))}
                >
                  <span className="ag-family-chip-top">
                    <span className="ag-family-chip-name">{tab.label}</span>
                    <small className="ag-family-chip-count">{tab.count}</small>
                    <strong className="ag-family-chip-pct">
                      {pctValue == null ? "--" : `${pctValue}%`}
                    </strong>
                  </span>
                  <span className="ag-family-chip-bar" aria-hidden="true">
                    <span style={{ width: `${pctValue == null ? 0 : Math.max(0, Math.min(100, pctValue))}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Tab 1: 2-column Model Quota Cards ── */}
      {detailTab === "models" ? (
        <div className="ag-detail-panel-body">
          {filteredModels.length ? (
            <div className="ag-model-card-grid">
              {filteredModels.map(model => {
                const family = classifyModelFamily(model.name, model.displayName);
                const tone = modelQuotaTone(model.percentage);
                const resetDate = formatDetailResetDate(model.resetTime);
                const countdown = formatDetailCountdown(model.resetTime);
                return (
                  <article className="ag-model-card" key={model.name}>
                    <div className="ag-model-card-top">
                      <div className="ag-model-card-title">
                        <ModelFamilyIcon family={family} />
                        <strong title={model.displayName || model.name}>
                          {model.displayName || model.name}
                        </strong>
                      </div>
                      <span className="ag-model-pct-pill" data-tone={tone}>
                        {model.percentage}%
                      </span>
                    </div>

                    <div className="ag-model-id-row">
                      <code className="ag-model-id-pill">{model.name}</code>
                    </div>

                    <div
                      className="ag-model-progress-track"
                      role="progressbar"
                      aria-label={`${model.displayName || model.name} 剩余额度`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={model.percentage}
                    >
                      <div
                        className="ag-model-progress-fill"
                        data-tone={tone}
                        style={{ width: `${Math.max(0, Math.min(100, model.percentage))}%` }}
                      />
                    </div>

                    <div className="ag-model-card-foot">
                      <span className="ag-model-reset-date">
                        <Clock size={11} aria-hidden="true" />
                        {resetDate || "未知"}
                      </span>
                      {countdown && <span className="ag-model-reset-cd">{countdown}</span>}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="ag-muted-text">
              {models.length ? "当前模型分类下暂无配额记录，点击上方色块可切回全部。" : "暂无模型配额数据，请先点击刷新。"}
            </p>
          )}
        </div>
      ) : (
        /* ── Tab 2: Quota Group Windows (grouped blue-bordered cards with included models + 2-column window cards) ── */
        <div className="ag-detail-panel-body">
          {quotaGroups.length ? (
            <div className="ag-group-window-sections">
              {quotaGroups.map(group => {
                const groupTitle = formatGroupDisplayTitle(group.displayName);
                const includedModels = resolveGroupIncludedModels(group, models);
                const includedText = includedModels.slice(0, 6).join(", ") + (includedModels.length > 6 ? " 等" : "");
                const fullIncludedText = includedModels.join(", ");
                return (
                  <section className="ag-group-box" key={group.displayName}>
                    <div className="ag-group-box-head">
                      <h4 className="ag-group-box-title">{groupTitle}</h4>
                      {includedModels.length > 0 && (
                        <span className="ag-group-box-models" title={`组内包含模型: ${fullIncludedText}`}>
                          组内包含模型: {includedText}
                        </span>
                      )}
                    </div>

                    <div className="ag-group-window-grid">
                      {(group.buckets ?? []).map(bucket => {
                        const pct = Math.round(Math.max(0, Math.min(1, bucket.remainingFraction)) * 100);
                        const tone = modelQuotaTone(pct);
                        const resetDate = formatDetailResetDate(bucket.resetTime);
                        const countdown = formatDetailCountdown(bucket.resetTime);
                        const windowTitle = formatBucketWindowTitle(bucket);
                        return (
                          <article className="ag-window-card" key={`${group.displayName}-${bucket.bucketId || bucket.window}`}>
                            <div className="ag-window-card-top">
                              <strong className="ag-window-title" title={bucket.displayName || windowTitle}>
                                {windowTitle}
                              </strong>
                              <span className="ag-model-pct-pill" data-tone={tone}>{pct}%</span>
                            </div>

                            <div
                              className="ag-model-progress-track"
                              role="progressbar"
                              aria-label={`${groupTitle} ${windowTitle} 剩余额度`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={pct}
                            >
                              <div
                                className="ag-model-progress-fill"
                                data-tone={tone}
                                style={{ width: `${pct}%` }}
                              />
                            </div>

                            <div className="ag-model-card-foot">
                              <span className="ag-model-reset-date">
                                <Clock size={11} aria-hidden="true" />
                                {resetDate || "未知"}
                              </span>
                              {countdown && <span className="ag-model-reset-cd">{countdown}</span>}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <p className="ag-muted-text">暂无配额分组窗口数据，请先点击刷新。</p>
          )}
        </div>
      )}
    </OverviewDialog>
  );
}
