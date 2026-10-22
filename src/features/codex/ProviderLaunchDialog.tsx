import { useEffect, useRef, useState } from "react";
import { Play, RotateCcw, ShieldCheck, CircleAlert } from "lucide-react";
import { OverviewDialog } from "./OverviewDialogs";
import { codexProviders, defaultModel, effectiveModels, keysForModel, type CodexProvider, type ProviderAggregate, type ProviderConfigPreview } from "../../platform/clients/codex-providers";
import { codexClient, type CodexInstance, type CodexAccount } from "../../platform/clients/codex";

export type ProviderLaunchTarget =
  | { kind: "provider"; value: CodexProvider }
  | { kind: "aggregate"; value: ProviderAggregate };

export function ProviderLaunchDialog({ target: launchTarget, switchEnabled, onEnableSwitch, onClose }: { target: ProviderLaunchTarget; switchEnabled: boolean; onEnableSwitch: () => Promise<boolean>; onClose: () => void }) {
  const aggregate = launchTarget.kind === "aggregate" ? launchTarget.value : null;
  const provider = launchTarget.kind === "provider" ? launchTarget.value : null;
  const title = aggregate?.name ?? provider!.name;
  const models = aggregate?.models ?? provider!.models;
  const [instances, setInstances] = useState<CodexInstance[]>([]);
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [oauthId, setOauthId] = useState("");
  const [target, setTarget] = useState("");
  const [keyId, setKeyId] = useState(provider?.keys[0]?.id ?? "aggregate");
  const [model, setModel] = useState(provider ? defaultModel(provider, provider.keys[0]?.id ?? "") : aggregate?.models[0] ?? "");
  const [preview, setPreview] = useState<ProviderConfigPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [phase, setPhase] = useState("");
  const [appliedSelection, setAppliedSelection] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const pending = useRef(false);
  const alive = useRef(true);
  const availableModels = provider ? [...new Set(provider.keys.flatMap(key => effectiveModels(provider, key.id)))] : models;
  const modelKeys = provider && model ? keysForModel(provider, model) : [];
  const matchedKey = provider?.keys.find(key => key.id === keyId);
  const selection = JSON.stringify([target, keyId, model, oauthId]);
  const configured = appliedSelection === selection && !!preview?.hasBackup;
  const validSelection = availableModels.includes(model) && (!provider || modelKeys.some(key => key.id === keyId));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { let cancelled = false; void codexClient.instances().then(v => { if (!cancelled) setInstances(v); }).catch(() => { if (!cancelled) setError("读取实例失败"); }); return () => { cancelled = true; }; }, []);
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    void codexClient.state().then(v => { if (!cancelled) setAccounts(v.accounts.filter(a => a.authMode === "chatgpt" && !a.isWebSession)); }).catch(() => { if (!cancelled) setError("读取 OAuth 账号失败"); });
    return () => { cancelled = true; };
  }, [provider]);
  useEffect(() => {
    let cancelled = false; setPreview(null); setLoading(true); setError(""); setNotice("");
    void codexProviders.preview(target || null).then(v => { if (!cancelled) setPreview(v); }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "读取配置预览失败"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [target, previewRevision]);
  async function execute(restore: boolean, start = false) {
    if (pending.current || loading || !preview || (restore ? !preview.hasBackup : !validSelection)) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    let restored = false;
    try {
      let current = preview;
      if (!restore && !switchEnabled) {
        setPhase("正在启用配置切换…");
        if (!await onEnableSwitch()) throw new Error("启用配置切换失败，未修改目标配置，请重试");
      }
      if (restore || current.hasBackup) {
        setPhase("正在恢复原配置与登录…");
        current = await codexProviders.restore(target || null);
        restored = true;
        if (!alive.current) return;
        setPreview(current); setAppliedSelection(null);
      }
      if (restore) {
        setNotice("已恢复应用前的配置与登录");
        return;
      }
      setPhase("正在备份并应用供应商配置…");
      const next = await codexProviders.apply(target || null, {
        providerId: aggregate ? `aggregate:${aggregate.id}` : provider!.id,
        keyId: aggregate ? "aggregate" : keyId,
        providerVersion: launchTarget.value.version,
        model,
        version: current.version,
        oauthAccountId: provider && oauthId ? Number(oauthId) : null,
      });
      if (!alive.current) return;
      setPreview(next); setAppliedSelection(selection); setNotice("供应商配置已应用，原配置与登录已备份");
      if (start) {
        setPhase("正在启动 Codex…");
        try { await launch(); }
        catch (e) { if (alive.current) setError(`配置已应用，但启动失败：${e instanceof Error ? e.message : "未知启动错误"}；可重试启动，或恢复配置与登录`); }
      }
    } catch (e) {
      if (alive.current) setError(`${restored && !restore ? "已先恢复原配置，应用新配置时失败；请刷新预览确认状态。" : ""}${e instanceof Error ? e.message : "操作失败"}`);
    }
    finally { pending.current = false; if (alive.current) { setBusy(false); setPhase(""); } }
  }
  async function launch() {
    if (target) {
      await codexClient.startInstance(target);
      if (alive.current) setNotice("供应商配置已应用，已请求启动 Codex");
      return;
    }
    const result = await codexClient.openDefault();
    if (alive.current) setNotice(`供应商配置已应用。${result}`);
  }
  async function startApplied() {
    if (pending.current || loading || !configured) return;
    pending.current = true; setBusy(true); setError(""); setNotice(""); setPhase("正在启动 Codex…");
    try { await launch(); }
    catch (e) { if (alive.current) setError(`启动失败，当前配置已保留：${e instanceof Error ? e.message : "未知启动错误"}；可重试启动或恢复配置与登录`); }
    finally { pending.current = false; if (alive.current) { setBusy(false); setPhase(""); } }
  }
  // 目标配置被外部改动时，普通恢复会拒绝覆盖；用户可显式选择强制恢复。
  async function forceRestore() {
    if (pending.current || loading) return;
    pending.current = true; setBusy(true); setError(""); setNotice(""); setPhase("正在强制恢复原配置与登录…");
    try {
      const current = await codexProviders.restore(target || null, true);
      if (!alive.current) return;
      setPreview(current); setAppliedSelection(null);
      setNotice("已强制恢复应用前的配置与登录，外部修改已被覆盖");
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "强制恢复失败");
    } finally { pending.current = false; if (alive.current) { setBusy(false); setPhase(""); } }
  }
  const disabled = busy || loading || !preview;
  const applyLabel = configured ? "配置已应用" : !switchEnabled ? "启用并应用" : preview?.hasBackup ? "恢复并应用" : "应用配置";
  const launchLabel = configured ? "启动 Codex" : !switchEnabled ? "启用并启动" : preview?.hasBackup ? "切换并启动" : "应用并启动";
  return <OverviewDialog title={title + " · 启动预览"} busy={busy} onClose={onClose} layout="form" className="codex-provider-launch-dialog" footer={<>
    <button disabled={busy} onClick={onClose}>关闭</button>
    <button disabled={disabled || !preview?.hasBackup} onClick={() => void execute(true)}><RotateCcw size={14} />恢复配置与登录</button>
    <button disabled={disabled || !validSelection || configured} onClick={() => void execute(false)}>{applyLabel}</button>
    <button className="codex-dialog-primary" disabled={disabled || !validSelection} onClick={() => void (configured ? startApplied() : execute(false, true))}><Play size={14} />{busy ? "处理中…" : launchLabel}</button>
  </>}>
    <div className="codex-provider-launch-content">
      <section className="codex-provider-form codex-provider-launch-fields" aria-label="启动设置">
      <label>目标实例<select disabled={busy} value={target} onChange={e => { setPreview(null); setLoading(true); setAppliedSelection(null); setTarget(e.target.value); }}><option value="">默认 Codex 桌面客户端</option>{instances.map(v => <option key={v.id} value={v.id} disabled={v.running}>{v.name}{v.running ? "（运行中）" : ""}</option>)}</select></label>
      {provider && <label>匹配密钥<select disabled={busy} value={keyId} onChange={e => { setKeyId(e.target.value); if (!effectiveModels(provider, e.target.value).includes(model)) setModel(defaultModel(provider, e.target.value)); }}>{provider.keys.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
      <label>模型<select aria-label="模型" disabled={busy} value={model} onChange={e => {
        const nextModel = e.target.value;
        setModel(nextModel);
        if (provider) {
          const candidates = keysForModel(provider, nextModel);
          if (candidates.length && !candidates.some(key => key.id === keyId)) setKeyId(candidates[0].id);
        }
      }}>{availableModels.map(value => {
        const candidates = provider ? keysForModel(provider, value) : [];
        return <option key={value} value={value}>{value}{candidates.length ? ` · ${candidates.map(key => key.name).join("、")}` : ""}</option>;
      })}</select>{provider && !availableModels.length && <small role="status">该供应商没有模型目录，请先在供应商编辑中补充配置模型或密钥模型目录后再应用。</small>}{provider && <small role="status">匹配：{modelKeys.map(key => key.name).join("、") || "无"} · 使用：{matchedKey?.name ?? "无"}</small>}</label>
      {provider && <label>OAuth 登录身份<select disabled={busy} value={oauthId} onChange={e => setOauthId(e.target.value)}><option value="">不绑定 · 纯 API 模式</option>{accounts.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>}
      </section>
      <section className="codex-provider-launch-summary" aria-label="配置摘要">
        <h3>配置摘要</h3>
        <dl className="codex-launch-facts">
          {provider && <><div><dt>上游地址</dt><dd><code>{provider.baseUrl}</code></dd></div><div><dt>协议</dt><dd>{provider.wireApi === "responses" ? "Responses API" : "Chat Completions"}</dd></div></>}
          {aggregate && <><div><dt>聚合成员</dt><dd>{aggregate.members.map(member => `${member.providerName} · ${member.keyName}`).join(" / ")}</dd></div><div><dt>调度策略</dt><dd>{aggregate.strategy === "failover" ? "故障切换" : aggregate.strategy === "roundRobin" ? "请求轮询" : "加权轮询"}</dd></div></>}
          <div><dt>配置目录</dt><dd><code>{preview?.path ?? (loading ? "正在读取…" : "不可用")}</code></dd></div>
        </dl>
      </section>
      {(!switchEnabled || preview?.hasBackup || preview?.catalogStale) && <div className="codex-provider-launch-warning" role="status"><CircleAlert size={16} aria-hidden="true" /><div>
        {!switchEnabled && <p>配置切换已关闭。“启用并应用”会启用此设置并写入配置；“启用并启动”还会启动 Codex。</p>}
        {preview?.hasBackup && <p>{configured ? "当前选择已应用，可直接启动 Codex，或恢复应用前的配置与登录。" : "目标已有供应商备份。应用时将先恢复原配置，再备份并应用当前选择。"}</p>}
        {preview?.catalogStale && <p>模型目录由旧版本生成或已被外部修改，客户端可能拒绝加载。重新应用配置即可按当前字段重建。</p>}
      </div></div>}
      <div className="codex-provider-launch-note"><ShieldCheck size={16} aria-hidden="true" /><div>
        <p>应用后更新 config.toml 与 auth.json，原配置和登录凭据会在本机加密备份，支持恢复。</p>
        {provider && oauthId && <p>OAuth 账号由目标实例独占，登录续期由官方客户端处理；推理使用供应商凭据。</p>}
        {(aggregate || provider?.wireApi !== "responses") && <p>通过本机网关转换 Responses 协议，使用期间请保持 CloudHub 运行。</p>}
      </div></div>
      {phase && <p role="status">{phase}</p>}{notice && <p role="status">{notice}</p>}{error && <div className="codex-provider-launch-error"><p role="alert" className="codex-card-error">{error}</p>{error.includes("外部修改") && <button type="button" disabled={busy || loading} onClick={() => void forceRestore()}>强制恢复</button>}<button type="button" disabled={busy || loading} onClick={() => { setPreview(null); setLoading(true); setAppliedSelection(null); setPreviewRevision(value => value + 1); }}>刷新预览</button></div>}
    </div>
  </OverviewDialog>;
}
