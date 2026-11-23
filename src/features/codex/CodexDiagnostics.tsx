import { useEffect, useRef, useState } from "react";
import { Copy, Network, RefreshCw } from "lucide-react";
import { codexClient, type CodexDiagnosticsReport, type CodexDiagnosticsRoute, type CodexDiagnosticsModelSource } from "../../platform/clients/codex";
import { platformErrorMessage, runningInTauri, runningOnPhone } from "../../platform/api";
import { OverviewDialog } from "./OverviewDialogs";
import { ToastNotice } from "../../shared/ToastNotice";
import "./codex-diagnostics.css";

const POLL_MS = 5000;

/** 连接诊断弹层：实时采集当前 Codex 配置的请求出口、模型来源与本机网络事实。 */
export function CodexDiagnosticsDialog({ onClose }: { onClose: () => void }) {
  return <ConnectionDiagnosticsDialog client="Codex" collect={codexClient.diagnostics} onClose={onClose} />;
}

export function ConnectionDiagnosticsDialog({ client, collect, onClose }: {
  client: "Codex" | "Claude Code";
  collect: () => Promise<CodexDiagnosticsReport>;
  onClose: () => void;
}) {
  const isClaude = client === "Claude Code";
  const canCollect = runningInTauri && (!isClaude || !runningOnPhone);
  const configName = isClaude ? "Claude Code 配置文件" : "config.toml";
  const [report, setReport] = useState<CodexDiagnosticsReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [paused, setPaused] = useState(false);
  const alive = useRef(true);
  const working = useRef(false);
  const unmounted = useRef(false);

  async function read() {
    if (working.current || unmounted.current) return;
    working.current = true;
    try {
      const next = await collect();
      if (alive.current) { setReport(next); setError(""); }
    } catch (reason) {
      if (alive.current) setError(platformErrorMessage(reason, `读取 ${client} 诊断失败，请重试`));
    } finally {
      working.current = false;
      if (alive.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    unmounted.current = false;
    if (!canCollect) { setLoading(false); return () => { alive.current = false; unmounted.current = true; }; }
    void read();
    return () => { alive.current = false; unmounted.current = true; };
  }, [canCollect]);

  useEffect(() => {
    if (paused || !canCollect) return;
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [canCollect, paused]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const routes = report?.routes ?? [];
  const ordered = [...routes].filter(route => route.effective).concat(routes.filter(route => !route.effective));

  return <OverviewDialog
    sizeStorageKey={isClaude ? "features/claude/connection-diagnostics/dialog" : "features/codex/codex-diagnostics/dialog"}
    title={`${client} 连接诊断`}
    description={isClaude ? "查看当前文件的连接地址、模型配置和本机网络状态" : "实时采集当前配置的请求出口、模型来源与本机网络事实；只读，不上传"}
    className="codex-diagnostics-dialog"
    busy={false}
    onClose={onClose}
    footer={<button type="button" onClick={onClose}>关闭</button>}
  >
    <div className="codex-diagnostics-toolbar">
      <button type="button" disabled={loading || !canCollect} onClick={() => { setLoading(true); void read(); }}><RefreshCw size={13} className={loading ? "codex-diagnostics-spin" : ""} />{loading ? "正在采集…" : "立即刷新"}</button>
      <button type="button" disabled={!canCollect} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? "已暂停自动刷新" : "每 5 秒自动刷新"}</button>
      {report && <span className="codex-diagnostics-meta" role="status">采集于 {new Date(report.collectedAt * 1000).toLocaleTimeString("zh-CN")} · 耗时 {report.durationMs} ms</span>}
    </div>

    {!canCollect && <p className="codex-hint">请在 CloudHub 桌面客户端采集本机 {client} 配置与网络状态。</p>}
    {error && <p role="alert" className="codex-card-error">{error}</p>}

    {report && <>
      {report.warnings.length > 0 && <section className="codex-diagnostics-warnings" aria-label="接管提示">
        <h3>接管与风险提示（{report.warnings.length}）</h3>
        <ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </section>}

      <section aria-label="实际请求出口">
        <h3>{isClaude ? "配置中的请求目标" : "实际请求出口"}</h3>
        <p className="codex-diagnostics-caption">{isClaude ? "探测当前配置文件中的主机和端口，地址仅展示协议、主机和端口。启动参数、其他作用域和进程环境可能改变实际请求目标。" : "按配置推断的客户端实际请求目标；“生效”的地址才会被使用。本机地址直接探测端口，外部地址只做 TCP 连通性测试。"}</p>
        <div className="codex-diagnostics-routes">
          {ordered.length === 0 ? <p role="status">当前配置没有可解析的接口地址。</p> : ordered.map(route => <RouteCard key={route.key} route={route} showEffective={!isClaude} />)}
        </div>
      </section>

      <section aria-label="网络拓扑">
        <h3><Network size={14} aria-hidden="true" />本机网络实时拓扑</h3>
        <p className="codex-diagnostics-caption">客户端流量先匹配路由表；“默认”适配器是当前 metric 最小的出网口。若 TUN/代理网卡成为默认，所有请求会先进代理。</p>
        <NetworkMap report={report} client={client} />
      </section>

      <section aria-label="关键配置">
        <h3>{configName}关键项</h3>
        <dl className="codex-diagnostics-settings">
          {report.settings.map(row => <div key={row.key} className={row.value ? undefined : "is-empty"}>
            <dt><code>{row.key}</code></dt>
            <dd>{row.value ? <><span>{row.value}</span><button type="button" aria-label={`复制 ${row.key}`} title={`复制 ${row.key}`} onClick={() => void navigator.clipboard.writeText(row.value ?? "").then(() => setNotice(`${row.key} 已复制`), () => setNotice("复制失败"))}><Copy size={12} /></button></> : "未设置"}</dd>
          </div>)}
        </dl>
        <p className="codex-diagnostics-path" title={report.configPath}>{report.configExists ? report.configPath : `${report.configPath}（尚未创建）`}{report.configModified ? ` · 文件修改于 ${new Date(report.configModified * 1000).toLocaleString("zh-CN")}` : ""}</p>
      </section>

      {!isClaude && <section aria-label="模型来源">
        <h3>模型列表来源{report.currentModel ? ` · 当前模型 ${report.currentModel}` : ""}</h3>
        <p className="codex-diagnostics-caption">客户端按 model_catalog_json 与内置缓存决定模型选择器内容；同名文件会分别列出。</p>
        <div className="codex-diagnostics-models">
          {report.modelSources.map(source => <ModelSourceCard key={source.path} source={source} />)}
        </div>
      </section>}
    </>}
    <ToastNotice message={notice} />
  </OverviewDialog>;
}

function RouteCard({ route, showEffective }: { route: CodexDiagnosticsRoute; showEffective: boolean }) {
  const status = routeStatus(route);
  return <article className={"codex-diagnostics-route " + (route.effective ? "is-effective" : "is-shadowed")}>
    <header>
      <strong>{route.label}</strong>
      <span className={`codex-diagnostics-state tone-${status.tone}`}>{status.label}</span>
      {showEffective && (route.effective ? <span className="codex-diagnostics-flag">生效</span> : <span className="codex-diagnostics-flag is-muted">未生效</span>)}
    </header>
    <code className="codex-diagnostics-url" title={route.url}>{route.url || "（无地址）"}</code>
    <dl>
      <div><dt>类型</dt><dd>{routeKindLabel(route.kind)}</dd></div>
      <div><dt>主机</dt><dd>{route.host ?? "—"}{route.port ? `:${route.port}` : ""}</dd></div>
      <div><dt>延迟</dt><dd>{route.latencyMs == null ? "—" : `${route.latencyMs} ms`}</dd></div>
      <div><dt>本机监听</dt><dd>{route.listenerProcess ? `${route.listenerProcess}${route.listenerPid ? ` (PID ${route.listenerPid})` : ""}` : "无"}</dd></div>
      {route.resolved.length > 0 && <div className="is-wide"><dt>解析</dt><dd>{route.resolved.join("、")}</dd></div>}
      {route.note && <div className="is-wide"><dt>说明</dt><dd>{route.note}</dd></div>}
    </dl>
  </article>;
}

function routeStatus(route: CodexDiagnosticsRoute): { label: string; tone: string } {
  switch (route.status) {
    case "listening": return { label: "本机端口已监听", tone: "ok" };
    case "refused": return { label: "端口拒绝连接 10061", tone: "danger" };
    case "reachable": return { label: "TCP 可连通", tone: "ok" };
    case "unreachable": return { label: "无法连通", tone: "warn" };
    case "invalid": return { label: "地址无效", tone: "warn" };
    default: return { label: "未配置", tone: "muted" };
  }
}

function routeKindLabel(kind: CodexDiagnosticsRoute["kind"]) {
  return kind === "loopback" ? "本机回环" : kind === "lan" ? "局域网" : kind === "public" ? "公网" : "未知";
}

const adapterKindLabel: Record<string, string> = { tun: "TUN 代理", wsl: "WSL 虚拟网卡", wifi: "无线网卡", ethernet: "有线网卡" };

function NetworkMap({ report, client }: { report: CodexDiagnosticsReport; client: string }) {
  const { network } = report;
  const adapters = network.adapters.slice(0, 6);
  const loopbacks = report.routes.filter(route => route.kind === "loopback");
  const externals = report.routes.filter(route => route.kind !== "loopback");
  if (!network.available) {
    return <p role="status" className="codex-diagnostics-caption">{network.error ?? "本机网络采集不可用。"}</p>;
  }
  return <div className="codex-diagnostics-topology">
    <div className="codex-diagnostics-node is-local">
      <strong>{client === "Codex" ? "默认 Codex 客户端" : "Claude Code 客户端"}</strong>
      <span>{report.currentModel ?? "未设置模型"}</span>
    </div>
    <div className="codex-diagnostics-links">
      {loopbacks.length ? loopbacks.map(route => <span key={route.key} className={"codex-diagnostics-link " + (route.status === "listening" ? "is-ok" : route.status === "refused" ? "is-danger" : "")}>
        {route.listenerProcess ? `${route.listenerProcess} :${route.port}` : `127.0.0.1:${route.port ?? "?"}`}
      </span>) : <span className="codex-diagnostics-link is-muted">无本机中转</span>}
    </div>
    <div className="codex-diagnostics-hop">适配器与路由</div>
    <ul className="codex-diagnostics-adapters">
      {adapters.length === 0 ? <li className="is-muted">未读取到活动网卡</li> : adapters.map(adapter => <li key={adapter.name} className={adapter.name === network.defaultAdapter ? "is-default" : undefined}>
        <strong>{adapter.name}</strong>
        <span>{adapterKindLabel[adapter.kind] ?? adapter.kind}{adapter.ip ? ` · ${adapter.ip}` : ""}{adapter.gateway ? ` → ${adapter.gateway}` : ""}{adapter.metric != null ? ` · metric ${adapter.metric}` : ""}</span>
        {adapter.name === network.defaultAdapter && <em>默认出口</em>}
      </li>)}
    </ul>
    <div className="codex-diagnostics-hop">外部目标</div>
    <ul className="codex-diagnostics-externals">
      {externals.length === 0 ? <li className="is-muted">没有外部目标</li> : externals.map(route => <li key={route.key}>
        <strong>{route.host}{route.port ? `:${route.port}` : ""}</strong>
        <span>{routeKindLabel(route.kind)} · {route.resolved[0] ?? "未解析"}</span>
      </li>)}
    </ul>
    <div className="codex-diagnostics-facts">
      <div><dt>系统代理</dt><dd>{network.systemProxyEnabled ? network.systemProxyServer ?? "已启用（地址未读取）" : "未启用"}</dd></div>
      {network.envProxies.map(proxy => <div key={proxy.name}><dt>{proxy.name}</dt><dd>{proxy.value}</dd></div>)}
      <div><dt>相关进程</dt><dd>{network.processes.length ? network.processes.map(process => `${process.name}${process.count > 1 ? ` ×${process.count}` : `(${process.pid})`}`).join("、") : "未发现代理进程"}</dd></div>
      {network.hosts.length > 0 && <div className="is-wide"><dt>hosts 记录</dt><dd>{network.hosts.slice(0, 12).map(entry => `${entry.ip} ${entry.host}`).join("；")}{network.hosts.length > 12 ? ` 等 ${network.hosts.length} 条` : ""}</dd></div>}
    </div>
  </div>;
}

function ModelSourceCard({ source }: { source: CodexDiagnosticsModelSource }) {
  return <article className={"codex-diagnostics-model-source" + (source.exists ? "" : " is-missing")}>
    <header><strong>{source.name}</strong><span>{source.exists ? `${source.count} 个模型` : "文件不存在"}</span></header>
    <code title={source.path}>{source.path}</code>
    {(source.fetchedAt || source.clientVersion || source.etag) && <p className="codex-diagnostics-model-meta">
      {source.fetchedAt && <span>获取于 {source.fetchedAt}</span>}
      {source.clientVersion && <span>客户端 {source.clientVersion}</span>}
      {source.etag && <span>etag {source.etag}</span>}
    </p>}
    {source.models.length > 0 && <details>
      <summary>展开模型（{source.models.length}）</summary>
      <ul>{source.models.map(model => <li key={model.id}>
        <code>{model.id}</code>
        {model.name && model.name !== model.id && <span>{model.name}</span>}
        {model.contextWindow && <span>{model.contextWindow.toLocaleString("zh-CN")} tokens</span>}
      </li>)}</ul>
    </details>}
  </article>;
}
