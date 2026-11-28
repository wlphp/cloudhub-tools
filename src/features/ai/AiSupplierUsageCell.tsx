import { useEffect, useMemo, useRef, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { aiClient, type AiProfile } from "../../platform/clients/ai";
import type { ProviderUsage } from "../../platform/clients/codex-providers";

type ProviderUsageWindow = ProviderUsage["windows"][number];
import { preferencesClient } from "../../platform/clients/preferences";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { readUsageSelection, type UsageProvider, type UsageSelection } from "../codex/ProviderUsageControl";
import { ProviderUsageDialog } from "../codex/ProviderUsageDialog";
import "../codex/model-providers.css";

export const AI_USAGE_PREFERENCE_PREFIX = "ai.suppliers.usage.";

const USAGE_ADAPTERS = [
  ["auto", "官方 / 自动识别 · DeepSeek / MiniMax / 智谱 / MiMo / Kimi / 硅基 / OpenRouter / Agnes / 云枢"],
  ["sub2api", "Sub2API"],
  ["new_api", "New API"],
  ["one_api", "One API（兼容计费接口）"],
] as const;

const OFFICIAL_USAGE_HOSTS = new Set([
  "api.deepseek.com",
  "api.minimaxi.com",
  "www.minimaxi.com",
  "api.minimax.io",
  "www.minimax.io",
  "open.bigmodel.cn",
  "api.z.ai",
  "api.xiaomimimo.com",
  "api.moonshot.cn",
  "api.moonshot.ai",
  "api.siliconflow.cn",
  "api.siliconflow.com",
  "openrouter.ai",
  "apihub.agnes-ai.com",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLocaleLowerCase();
  } catch {
    return "";
  }
}

function isOfficialUsageHost(baseUrl: string): boolean {
  return OFFICIAL_USAGE_HOSTS.has(hostOf(baseUrl));
}

function isLoopbackUsageHost(baseUrl: string): boolean {
  return LOOPBACK_HOSTS.has(hostOf(baseUrl));
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatResetCountdown(resetsAt?: number | null): string {
  if (!resetsAt) return "";
  const deltaMs = resetsAt * 1000 - Date.now();
  if (deltaMs <= 0) return "即将重置";
  const mins = Math.ceil(deltaMs / 60_000);
  if (mins < 60) return `${mins}m重置`;
  const hours = deltaMs / 3_600_000;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0).replace(/\.0$/, "")}h重置`;
  return `${Math.ceil(deltaMs / 86_400_000)}d重置`;
}

function windowPercent(window: ProviderUsageWindow): number | null {
  if (window.unit.includes("%")) return Math.max(0, Math.min(100, window.remaining));
  if (window.total != null && window.total > 0) return Math.max(0, Math.min(100, (window.remaining / window.total) * 100));
  return null;
}

function barTone(percent: number): string {
  if (percent < 10) return "is-low";
  if (percent < 30) return "is-warn";
  return "is-ok";
}

function windowTooltip(usage: ProviderUsage): string {
  const lines = usage.windows.map(window => {
    const base = window.unit.includes("%")
      ? `${window.name}：剩余 ${formatAmount(window.remaining)}%`
      : window.total != null
        ? `${window.name}：${formatAmount(window.remaining)} / ${formatAmount(window.total)} ${window.unit}`
        : `${window.name}：${formatAmount(window.remaining)} ${window.unit}`;
    const reset = window.resetsAt ? `（重置于 ${new Date(window.resetsAt * 1000).toLocaleString()}）` : "";
    return `${base}${reset}`;
  });
  lines.push(`更新于 ${new Date(usage.fetchedAt).toLocaleString()}`);
  return lines.join("\n");
}

export function AiSupplierUsageCell({
  profile,
  savedRaw,
  preferencesReady,
  refreshRevision,
  disabled,
  onSaved,
}: {
  profile: AiProfile;
  savedRaw?: string;
  preferencesReady: boolean;
  refreshRevision: number;
  disabled: boolean;
  onSaved: (value: string) => void;
}) {
  const usageProvider = useMemo<UsageProvider>(
    () => ({ id: profile.id, name: profile.name, version: profile.updatedAt, keys: [{ id: "primary", name: "供应商 API Key" }] }),
    [profile.id, profile.name, profile.updatedAt],
  );
  const official = useMemo(() => isOfficialUsageHost(profile.baseUrl), [profile.baseUrl]);
  const loopback = useMemo(() => isLoopbackUsageHost(profile.baseUrl), [profile.baseUrl]);
  const explicitSelection = useMemo(() => readUsageSelection(savedRaw, usageProvider), [savedRaw, usageProvider]);
  const savedSelection = useMemo(
    () => explicitSelection ?? (official || loopback ? { adapter: "auto", keyId: "primary" } : null),
    [explicitSelection, official, loopback],
  );

  const [selection, setSelection] = useState<UsageSelection>(savedSelection ?? { adapter: "auto", keyId: "primary" });
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [open, setOpen] = useState(false);
  const active = useRef(false);
  const alive = useRef(true);
  const autoQueriedKey = useRef("");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (savedSelection) setSelection(savedSelection);
  }, [savedSelection?.adapter, savedSelection?.keyId]);

  async function query(next: UsageSelection = selection) {
    if (active.current || !profile.hasKey) return;
    if (!runningInTauri) {
      setError("当前为浏览器预览，查询上游额度需在桌面或手机客户端执行");
      return;
    }
    active.current = true;
    setBusy(true);
    setError("");
    if (next.adapter !== selection.adapter) setUsage(null);
    setSelection(next);
    try {
      const result = await aiClient.usage(profile.id, next.adapter);
      if (alive.current) setUsage(result);
    } catch (reason) {
      if (alive.current) setError(platformErrorMessage(reason));
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!preferencesReady || !runningInTauri || !profile.hasKey || !profile.enabled || !savedSelection) return;
    const key = `${profile.id}:${profile.updatedAt}:${savedSelection.adapter}:${refreshRevision}`;
    if (autoQueriedKey.current === key) return;
    autoQueriedKey.current = key;
    void query(savedSelection);
  }, [preferencesReady, profile.id, profile.updatedAt, profile.hasKey, profile.enabled, savedSelection?.adapter, refreshRevision]);

  async function saveSelection() {
    if (active.current || !selection.keyId) return;
    active.current = true;
    setBusy(true);
    setSaveMessage("");
    try {
      const serialized = JSON.stringify(selection);
      await preferencesClient.save(AI_USAGE_PREFERENCE_PREFIX + profile.id, serialized);
      if (alive.current) {
        onSaved(serialized);
        setSaveMessage("已保存，后续刷新将默认使用此额度接口");
      }
    } catch (reason) {
      if (alive.current) setSaveMessage(platformErrorMessage(reason));
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function openDialog() {
    const next = savedSelection ?? { adapter: "auto", keyId: "primary" };
    if (next.adapter !== selection.adapter || next.keyId !== selection.keyId) {
      setSelection(next);
      setUsage(null);
      setError("");
    }
    setSaveMessage("");
    setOpen(true);
  }

  if (!profile.hasKey) {
    return <div className="ai-usage-cell"><span className="ai-usage-muted">未配密钥</span></div>;
  }

  const showConfigured = Boolean(
    explicitSelection
      || official
      || usage
      || busy
      || (loopback && Boolean(usage)),
  );

  return (
    <>
      <div className="ai-usage-cell" aria-busy={busy}>
        {showConfigured ? (
          <>
            <button
              type="button"
              className="ai-usage-summary-trigger"
              disabled={disabled}
              title={error || (usage ? windowTooltip(usage) : "点击查看或配置额度接口")}
              onClick={openDialog}
            >
              {busy && !usage ? (
                <span className="ai-usage-loading">查询中…</span>
              ) : usage?.windows.length ? (
                <div className="ai-usage-windows">
                  {usage.windows.slice(0, 2).map((window, index) => {
                    const pct = windowPercent(window);
                    const reset = formatResetCountdown(window.resetsAt);
                    if (pct !== null) {
                      return (
                        <div className="ai-usage-window is-quota" key={index}>
                          <div className="ai-usage-window-head">
                            <span className="ai-usage-name">{window.name}</span>
                            <strong className={`ai-usage-value ${barTone(pct)}`}>
                              {window.unit.includes("%")
                                ? `${formatAmount(window.remaining)}%`
                                : `${formatAmount(window.remaining)}/${formatAmount(window.total!)}`}
                            </strong>
                            {reset && <small className="ai-usage-reset">{reset}</small>}
                          </div>
                          <span className="ai-usage-bar" aria-hidden="true">
                            <i className={`ai-usage-bar-fill ${barTone(pct)}`} style={{ width: `${pct}%` }} />
                          </span>
                        </div>
                      );
                    }
                    return (
                      <div className="ai-usage-window is-balance" key={index}>
                        <span className="ai-usage-name">{window.name}</span>
                        <strong className="ai-usage-value is-ok">
                          {formatAmount(window.remaining)} <small>{window.unit}</small>
                        </strong>
                      </div>
                    );
                  })}
                  {error && <span className="ai-usage-sub-error">刷新失败</span>}
                </div>
              ) : error ? (
                <span className="ai-usage-error">查询失败</span>
              ) : (
                <span className="ai-usage-muted">点击查询</span>
              )}
            </button>
            <div className="ai-usage-inline-actions">
              <button
                type="button"
                className="ai-usage-icon-btn"
                title="刷新额度"
                aria-label={`刷新 ${profile.name} 额度`}
                disabled={disabled || busy || !savedSelection}
                onClick={() => { if (savedSelection) void query(savedSelection); }}
              >
                <RefreshCw size={13} className={busy ? "codex-refresh-spinning" : ""} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="ai-usage-icon-btn"
                title="设置额度平台"
                aria-label={`设置 ${profile.name} 额度平台`}
                disabled={disabled || busy}
                onClick={openDialog}
              >
                <Gauge size={13} aria-hidden="true" />
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="ai-usage-setup-btn"
            disabled={disabled}
            title="选择余额或周期限额接口（官方 / Sub2API / New API / One API）"
            aria-label={`查询额度 ${profile.name}`}
            onClick={openDialog}
          >
            <Gauge size={13} aria-hidden="true" />
            <span>查询额度</span>
          </button>
        )}
      </div>
      {open && (
        <ProviderUsageDialog
          provider={usageProvider}
          adapters={USAGE_ADAPTERS}
          selection={selection}
          usage={usage}
          busy={busy}
          error={error}
          saveMessage={saveMessage}
          onChange={next => {
            setSelection(next);
            setUsage(null);
            setError("");
            setSaveMessage("");
          }}
          onSave={() => void saveSelection()}
          onQuery={next => void query(next)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
