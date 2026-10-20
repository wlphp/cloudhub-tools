import { useEffect, useRef, useState } from "react";
import { CalendarDays, Download, FileText, Link2, Play, RefreshCw, RotateCcw, Tag, Terminal, UserRound } from "lucide-react";
import { codexClient, isCodexDefaultProcessBusy, type CodexAccount, type CodexAuthMetadata, type CodexGatewayState, type CodexInstance, type CodexState } from "../../platform/clients/codex";
import { OverviewDialog } from "./OverviewDialogs";
import { LaunchConfigRows } from "./LaunchConfigRows";
import { AccountRefreshError } from "./AccountRefreshError";
import { quotaResetTime, remainingPercent, useQuotaClock, windowName } from "./quotaPresentation";

const date = (value: number | null | undefined) => value ? new Date(value * 1000).toLocaleString("zh-CN") : "未获取";

export function LaunchPreviewDialog({ account, state, instances, gateway, onClose, onState, onInstances, onAccount, onEdit, onExport, onPool, onApi, onDefaultBusy }: {
  account: CodexAccount; state: CodexState; instances: CodexInstance[]; gateway: CodexGatewayState | null;
  onClose: () => void; onState: (value: CodexState) => void; onInstances: (value: CodexInstance[]) => void;
  onAccount: (value: CodexAccount) => void; onEdit: () => void; onExport: () => void;
  onPool: () => Promise<void>; onApi: () => void; onDefaultBusy: (retry: () => Promise<void>) => void;
}) {
  const [target, setTarget] = useState("");
  const [density, setDensity] = useState("standard");
  const [metadata, setMetadata] = useState<CodexAuthMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resetConfirm, setResetConfirm] = useState(false);
  const [configEditing, setConfigEditing] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const now = useQuotaClock();
  const selected = instances.find(value => value.id === target);
  const inPool = (gateway?.startupAccountIds ?? gateway?.accountIds ?? []).includes(account.id);
  const launchTarget = selected
    ? selected.kind === "desktop" ? `桌面实例「${selected.name}」` : `CLI 实例「${selected.name}」`
    : "Codex 桌面客户端";
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    setMetadata(null); setMetadataLoading(true);
    void codexClient.authMetadata(account.id).then(value => { if (!cancelled) setMetadata(value); })
      .catch(() => { if (!cancelled) setError("读取 Token 状态失败，请重试"); })
      .finally(() => { if (!cancelled) setMetadataLoading(false); });
    return () => { cancelled = true; alive.current = false; };
  }, [account.id]);
  async function run(label: string, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(label); setError(""); setNotice("");
    try { await action(); }
    catch (reason) { if (alive.current) setError(label + "失败：" + (reason instanceof Error ? reason.message : "请重试")); }
    finally { pending.current = false; if (alive.current) setBusy(""); }
  }
  async function execute(start: boolean, cli = false, retryLaunchOnly = false) {
    await run(start ? "切换并启动" : "切换", async () => {
      if (target) {
        const next = await codexClient.bindInstance(target, account.id);
        if (alive.current) { onInstances(next); setNotice("目标实例已切换账号"); }
        if (start && alive.current) {
          try { const running = await codexClient.startInstance(target); if (alive.current) onInstances(running); }
          catch (reason) { throw new Error("账号已切换，启动失败。" + (reason instanceof Error ? reason.message : "请重试启动")); }
        }
      } else {
        if (!retryLaunchOnly) {
          let preview: Awaited<ReturnType<typeof codexClient.prepareSwitch>>;
          try { preview = await codexClient.prepareSwitch(account.id); }
          catch (reason) {
            if (isCodexDefaultProcessBusy(reason)) { onDefaultBusy(() => execute(start, cli)); return; }
            throw reason;
          }
          if (!alive.current) return;
          let next: CodexState;
          try { next = await codexClient.confirmSwitch(preview.token); }
          catch (reason) {
            if (isCodexDefaultProcessBusy(reason)) { onDefaultBusy(() => execute(start, cli)); return; }
            throw reason;
          }
          if (alive.current) { onState(next); setNotice("默认实例已切换账号"); }
        }
        if (start && alive.current) {
          try { if (cli) await codexClient.openDefaultCli(); else await codexClient.openDefault(); }
          catch (reason) {
            if (isCodexDefaultProcessBusy(reason)) {
              onDefaultBusy(async () => {
                if (cli) await codexClient.openDefaultCli();
                else await codexClient.openDefault();
                if (alive.current) onClose();
              });
              return;
            }
            throw new Error("账号已切换，启动失败。" + (reason instanceof Error ? reason.message : "请重试启动"));
          }
        }
      }
      if (alive.current) { if (start) onClose(); else setNotice("账号切换完成，尚未启动客户端"); }
    });
  }
  const tools = <div className="codex-launch-tools">
    {!account.isWebSession && <button disabled={!!busy || account.authMode !== "chatgpt"} onClick={() => void run("刷新订阅", async () => { onAccount(await codexClient.refreshBenefits(account.id)); setNotice("订阅权益已更新"); })}><CalendarDays size={14} />订阅到期</button>}
    {!account.isWebSession && <button disabled={!!busy || !gateway?.supportsPoolPersistence || gateway.running} onClick={() => void run("更新 API 账号池", async () => { await onPool(); setNotice("API 服务账号池已更新"); })}><Link2 size={14} />{inPool ? "移除 API 服务" : "添加至 API 服务"}</button>}
    {!account.isWebSession && <button disabled={!!busy || account.authMode !== "chatgpt"} onClick={() => setResetConfirm(true)}><RotateCcw size={14} />重置次数 {account.benefits?.resetCredits ?? 0}</button>}
    {!account.isWebSession && <button disabled={!!busy || configEditing || !state.cliAvailable || (selected != null && (selected.kind !== "cli" || selected.running))} title="切换所选账号后启动 CLI" onClick={() => void execute(true, true)}><Terminal size={14} />CLI 启动</button>}
    {!account.isWebSession && <button disabled={!!busy} onClick={onEdit}><Tag size={14} />标签</button>}
    {!account.isWebSession && <button disabled={!!busy} onClick={onEdit}><FileText size={14} />备注</button>}
    <button disabled={!!busy || account.authMode !== "chatgpt"} onClick={() => void run("刷新额度", async () => { onAccount(await codexClient.refreshQuota(account.id)); setMetadata(await codexClient.authMetadata(account.id)); setNotice("额度查询已完成"); })}><RefreshCw size={14} />刷新额度</button>
    {!account.isWebSession && <button disabled={!!busy || !!gateway?.running || instances.some(value => value.running)} onClick={onExport}><Download size={14} />导出</button>}
  </div>;
  return <OverviewDialog footerLayout="stacked" title="Codex 启动预览" className={"codex-launch-preview is-" + density} busy={!!busy} dismissWhileBusy onClose={onClose} footer={<>{tools}<div className="codex-launch-bottom"><span>更新于 {account.quota.fetchedAt ? new Date(account.quota.fetchedAt).toLocaleString("zh-CN") : "尚未刷新"}</span><button onClick={onClose}>关闭</button><div><button disabled={!!busy || configEditing || !!selected?.running} onClick={() => void execute(false)}>切换</button><button className="primary" disabled={!!busy || configEditing || !!selected?.running || (!target && !state.canOpenDefault)} onClick={() => void execute(true)}><Play size={14} />切换并启动</button></div></div></>}>
    <div className="codex-launch-account-row"><div className="codex-launch-summary"><span className="codex-launch-avatar"><UserRound size={23} /></span><div className="codex-launch-account-copy"><div className="codex-launch-account-headline"><strong>{account.email ?? account.label}</strong><div className="codex-launch-badges"><span>{(account.plan ?? account.authMode).toUpperCase()}</span>{state.currentAccountId === account.id && <span>当前</span>}</div></div><small className="codex-launch-account-kind">{account.authMode === "chatgpt" ? "个人账户 · ChatGPT 登录" : "API Key 账户"}</small></div></div>
    <label className="codex-launch-density">密度<select value={density} disabled={!!busy} onChange={event => setDensity(event.target.value)}><option value="standard">标准</option><option value="compact">紧凑</option></select></label>
    <label className="codex-launch-target">目标实例<select aria-label="目标实例" value={target} disabled={!!busy || configEditing} onChange={event => { setTarget(event.target.value); setError(""); setNotice(""); }}><option value="">默认实例</option>{instances.map(value => <option key={value.id} value={value.id} disabled={value.running}>{value.name} · {value.kind === "cli" ? "CLI" : "桌面"}{value.running ? "（运行中）" : ""}</option>)}</select></label>
    </div><p className="codex-launch-description">{account.isWebSession ? "Web Session 账号仅支持查看和刷新额度，不能切换账号、启动客户端或用于 API 服务。" : `切换会将所选账号应用到${selected ? "「" + selected.name + "」" : "默认实例"}。“切换并启动”将打开${launchTarget}；“CLI 启动”才会打开命令行客户端。请先结束客户端中的任务并关闭客户端。${account.authMode === "chatgpt" ? "access_token 用于 API 请求，id_token 用于账号身份；下方展示有效期。" : "此账号使用 API Key 计费，无 ChatGPT 订阅额度。"}`}</p>
    <dl className="codex-launch-facts" aria-busy={metadataLoading}>
      <div><dt>用户 ID</dt><dd>{metadata?.userId ?? account.userId ?? (metadataLoading ? "读取中…" : "未获取")}</dd></div>
      <div><dt>账号 ID</dt><dd>{account.accountId ?? "—"}</dd></div>
      {!account.isWebSession && <div><dt>订阅到期</dt><dd>{date(account.benefits?.expiresAt)}</dd></div>}
      {account.authMode === "chatgpt" && <><div><dt>Access Token 到期</dt><dd>{metadataLoading ? "读取中…" : date(metadata?.accessExpiresAt)}</dd></div><div><dt>ID Token 到期</dt><dd>{metadataLoading ? "读取中…" : date(metadata?.idExpiresAt)}</dd></div></>}
    </dl>
    <section className="codex-launch-quota" aria-label="账号额度"><h3>额度使用情况</h3>{account.quota.windows.length ? account.quota.windows.map((value, index) => { const remaining = remainingPercent(value); return <div className="codex-launch-window" key={value.name + index}><div><strong>{windowName(value.windowMinutes)}</strong><span>{remaining == null ? "未知" : Math.round(remaining) + "% 剩余"}</span></div><progress value={remaining ?? 0} max={100} aria-label={windowName(value.windowMinutes) + "剩余额度"} /><small>重置于 {quotaResetTime(value.resetsAt, now)}</small></div>; }) : <p>尚未获取额度，请点击下方“刷新额度”。</p>}{account.lastError && <AccountRefreshError reason={account.lastError} accountLabel={account.email ?? account.label} />}</section>
    {!account.isWebSession && <div className="codex-launch-settings"><div><div><strong><Link2 size={15} />第三方 API 路由</strong><small>在 API 服务中配置端口、账号池与模型。</small></div><button disabled={!!busy} onClick={onApi}>配置</button></div><div><div><strong><RefreshCw size={15} />强制刷新 Token</strong><small>{metadataLoading ? "正在读取 Token 状态…" : metadata?.hasRefreshToken ? "通过官方 CLI 刷新并保存轮换后的凭据。" : "没有 Refresh Token，需要重新授权。"}</small></div><button disabled={!!busy || !metadata?.hasRefreshToken} onClick={() => void run("刷新 Token", async () => { setMetadata(await codexClient.forceRefresh(account.id)); onState(await codexClient.state()); setNotice("官方 CLI 已完成认证刷新检查"); })}>刷新</button></div></div>}
    {!account.isWebSession && <LaunchConfigRows target={target} cliAvailable={state.cliAvailable} busy={!!busy} onRun={run} onEditing={setConfigEditing} />}
    {resetConfirm && <div className="codex-launch-confirm" role="group" aria-label="确认消耗额度重置次数"><p>确认消耗一次额度重置？此操作无法撤销。</p><button disabled={!!busy} onClick={() => setResetConfirm(false)}>取消重置</button><button disabled={!!busy} onClick={() => void run("重置额度", async () => { onAccount(await codexClient.consumeReset(account.id)); setResetConfirm(false); setNotice("已提交额度重置，请刷新额度确认"); })}>确认消耗一次</button></div>}
    <p className="codex-launch-path"><Terminal size={13} />{selected?.workDir ?? state.profileHome}</p>
    {busy && <p role="status">正在{busy}…</p>}{notice && <p role="status" className="codex-feedback">{notice}</p>}{error && <p role="alert" className="codex-card-error">{error}</p>}
    <p className="codex-launch-caption">Token 日期来自本机凭据中的身份声明，仅作为状态提示。</p>
  </OverviewDialog>;
}
