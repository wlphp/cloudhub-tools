import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Gauge, MapPin, Play, RefreshCw, Square } from "lucide-react";
import { runningInTauri } from "../../platform/api";
import { speedTestClient, type SpeedNetworkInfo, type SpeedTestConfig, type SpeedRun } from "../../platform/clients/speed-test";
import "./network-speed.css";

const phaseText = { connecting: "检测节点", latency: "HTTP 延迟", download: "下载测速", upload: "上传测速" };
const statusText = { running: "测速中", completed: "已完成", cancelled: "已停止 · 部分结果", failed: "未完成 · 部分结果" };
const number = (value: number | null | undefined) => value == null ? "—" : value.toFixed(1);
const traffic = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

function SpeedChart({ run }: { run: SpeedRun | null }) {
  const points = run?.points ?? [];
  const max = Math.max(1, ...points.map(p => p.mbps));
  const end = Math.max(1, run?.elapsedSecs ?? 1);
  const path = (direction: string) => points.filter(p => p.direction === direction).map((p, i) => `${i ? "L" : "M"}${48 + p.seconds / end * 728},${158 - p.mbps / max * 132}`).join(" ");
  return <figure className="speed-chart">
    <figcaption><strong>实时速度</strong><span><i className="speed-download" />下载（实线）<i className="speed-upload" />上传（虚线） · Mbps</span></figcaption>
    <svg viewBox="0 0 800 192" role="img" aria-label={points.length ? `速度曲线，当前纵轴上限 ${number(max)} Mbps，横轴 ${number(end)} 秒` : "速度曲线，开始测速后显示"}>
      {[0, 1, 2].map(i => <g key={i}><line x1="48" x2="776" y1={26 + i * 66} y2={26 + i * 66} className="speed-grid" /><text x="4" y={30 + i * 66}>{number(max * (1 - i / 2))}</text></g>)}
      <text x="48" y="183">0 s</text><text x="725" y="183">{number(end)} s</text>
      <path d={path("download")} className="speed-line speed-download" />
      <path d={path("upload")} className="speed-line speed-upload" strokeDasharray="6 4" />
      {!points.length && <text x="400" y="95" textAnchor="middle">开始测速后显示实时曲线</text>}
    </svg>
  </figure>;
}

export function NetworkSpeedPlugin() {
  const [config, setConfig] = useState<SpeedTestConfig>({ node: "cn-qiniu", baseUrl: "", durationSecs: 10, limitMib: 200 });
  const [networkInfo, setNetworkInfo] = useState<SpeedNetworkInfo | null>(null);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkError, setNetworkError] = useState("");
  const networkRequest = useRef(0);
  const [run, setRun] = useState<SpeedRun | null>(null);
  const [history, setHistory] = useState<SpeedRun[]>([]);
  const [tab, setTab] = useState<"test" | "history">("test");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(runningInTauri);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const running = run?.status === "running";
  const selectedDownloadOnly = config.node.startsWith("cn-");
  const resultDownloadOnly = (run?.node ?? config.node).startsWith("cn-");

  async function refreshNetworkInfo() {
    const request = ++networkRequest.current;
    setNetworkLoading(true); setNetworkError("");
    try {
      const info = await speedTestClient.networkInfo();
      if (mounted.current && request === networkRequest.current) { setNetworkInfo(info); setNetworkError(info.warning ?? ""); }
    } catch (reason) {
      if (mounted.current && request === networkRequest.current) setNetworkError(`网络信息获取失败：${String(reason)}`);
    } finally {
      if (mounted.current && request === networkRequest.current) setNetworkLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (!runningInTauri) return () => { mounted.current = false; };
    void refreshNetworkInfo();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let finishedId = "";
    let historyLoaded = false;
    const poll = async () => {
      try {
        const request = generation.current;
        const next = await speedTestClient.status();
        if (disposed || request !== generation.current) return;
        setRun(next);
        if (!historyLoaded || next && next.status !== "running" && finishedId !== next.id) {
          const rows = await speedTestClient.history();
          if (!disposed && request === generation.current) { setHistory(rows); finishedId = next?.id ?? ""; historyLoaded = true; }
        }
        if (next?.status !== "running") setStopping(false);
      } catch (reason) { if (!disposed) setError(`刷新测速状态失败：${String(reason)}`); }
      finally {
        if (!disposed) { setLoading(false); timer = setTimeout(poll, 500); }
      }
    };
    void poll();
    return () => { disposed = true; mounted.current = false; clearTimeout(timer); };
  }, []);

  async function operate(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function start() {
    if (config.node === "custom") {
      let url: URL;
      try { url = new URL(config.baseUrl); } catch { throw new Error("请输入有效的公网 HTTPS 节点地址"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("节点只接受不含凭据、查询参数与片段的公网 HTTPS 地址");
    }
    generation.current++;
    try {
      const next = await speedTestClient.start(config);
      if (mounted.current) { setRun(next); setStopping(false); setTab("test"); }
    } finally { generation.current++; }
  }

  if (!runningInTauri) return <section className="network-speed"><p role="status">网络测速仅支持桌面客户端。浏览器预览和手机端不执行测速。</p></section>;
  return <section className="network-speed" aria-label="网络测速工具">
    <div className="speed-intro"><Gauge size={20} aria-hidden="true" /><div><strong>测试本机到测速节点的网络表现</strong><p>应用直连 · 四连接并发 · 历史仅保存在本机。VPN / TUN 仍会影响路径和结果。</p></div></div>
    <section className="speed-network" aria-label="本机网络信息" aria-busy={networkLoading}>
      <div className="speed-network-head"><strong><MapPin size={15} aria-hidden="true" />本机网络信息</strong><button type="button" className="secondary" disabled={networkLoading} onClick={() => void refreshNetworkInfo()}><RefreshCw size={13} aria-hidden="true" />{networkLoading ? "正在获取…" : "刷新网络信息"}</button></div>
      <dl><div><dt>公网 IP（出口）</dt><dd>{networkInfo?.publicIp ?? (networkLoading ? "获取中…" : "未获取")}</dd></div><div><dt>本机内网 IP（默认 IPv4 接口）</dt><dd>{networkInfo?.localIp ?? (networkLoading ? "获取中…" : "未获取")}</dd></div><div className="speed-network-location"><dt>IP 归属地 / 运营商</dt><dd>{networkInfo?.location ?? (networkLoading ? "获取中…" : "未获取")}</dd></div></dl>
      {networkError && <p role="status" className="speed-network-error">{networkError}。可刷新重试，测速仍可正常使用。</p>}
      <small>归属地由 IPIP.NET 提供，为出口 IP 的大致位置，非精确定位；VPN / TUN 可能改变出口。网络信息不写入测速历史。{networkInfo && ` 查询于 ${new Date(networkInfo.checkedAt).toLocaleTimeString()}`}</small>
    </section>
    <div className="store-tabs speed-tabs" role="group" aria-label="测速视图">{([['test', '测速'], ['history', '历史记录']] as const).map(([value, label]) => <button type="button" key={value} className={tab === value ? "is-active" : ""} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>
    {error && <p className="notes-error" role="alert">{error}</p>}
    {tab === "test" ? <>
      <form className="speed-form" onSubmit={event => { event.preventDefault(); void operate(start); }}>
        <label>测速节点<select value={config.node} disabled={busy || running} onChange={e => setConfig(c => ({ ...c, node: e.target.value as SpeedTestConfig["node"] }))}><option value="cn-qiniu">国内 · 七牛 CDN（仅下载）</option><option value="cn-alipay">国内 · 支付宝 CDN（仅下载）</option><option value="cloudflare">Cloudflare · 自动边缘节点（下载 / 上传）</option><option value="custom">自建兼容节点</option></select></label>
        <label>每方向时长<select value={config.durationSecs} disabled={busy || running} onChange={e => setConfig(c => ({ ...c, durationSecs: Number(e.target.value) }))}>{[5, 10, 15].map(v => <option key={v} value={v}>{v} 秒</option>)}</select></label>
        <label>总载荷上限<select value={config.limitMib} disabled={busy || running} onChange={e => setConfig(c => ({ ...c, limitMib: Number(e.target.value) }))}>{[50, 200, 500].map(v => <option key={v} value={v}>{v} MiB</option>)}</select></label>
        <div className="speed-actions"><button type="submit" disabled={busy || running || loading}><Play size={14} aria-hidden="true" />开始测速</button><button type="button" className="secondary" disabled={!running || busy || stopping} onClick={() => void operate(async () => { await speedTestClient.cancel(run!.id); if (mounted.current) setStopping(true); })}><Square size={13} aria-hidden="true" />{stopping ? "正在停止…" : "停止"}</button></div>
        {config.node === "custom" && <label className="speed-custom">节点基础地址<input type="url" required maxLength={512} placeholder="https://speed.example.com/" value={config.baseUrl} disabled={busy || running} onChange={e => setConfig(c => ({ ...c, baseUrl: e.target.value }))} /><small>需支持 Cloudflare 兼容的 __down?bytes=N 和 __up 接口，仅接受公网 HTTPS。</small></label>}
      </form>
      <p className="speed-muted">{selectedDownloadOnly ? "国内 CDN 节点测试下载和 HTTP 延迟，总预算用于下载；上传请切换 Cloudflare 或自建兼容节点。" : "点击开始会消耗网络流量，下载与上传各分配一半预算。"}流量为下载接收量加已提交上传载荷的保守估算，不含协议开销。测速节点可看到来源 IP，应用不向节点上报测速摘要。</p>
      <div className="speed-status" role="status" aria-live="polite"><strong>{loading ? "正在读取测速状态…" : running ? `${stopping ? "正在停止" : phaseText[run.phase]}` : run ? statusText[run.status] : "准备就绪"}</strong><span>{run ? `${number(run.elapsedSecs)} 秒 · ${traffic(run.trafficBytes)} / ${run.limitMib} MiB${run.colo ? ` · 节点 ${run.colo}` : ""}` : "选择节点后开始"}</span></div>
      <ol className="speed-steps" aria-label="测速阶段">{Object.entries(phaseText).map(([key, text]) => <li key={key} aria-current={running && run.phase === key ? "step" : undefined}>{key === "upload" && resultDownloadOnly ? "上传不支持" : text}</li>)}</ol>
      <div className="speed-metrics">
        <div><span><ArrowDown size={15} aria-hidden="true" />下载速度</span><strong>{number(run?.downloadMbps)}<small>Mbps</small></strong><small>{number(run?.downloadMbps == null ? null : run.downloadMbps / 8)} MB/s</small></div>
        <div><span><ArrowUp size={15} aria-hidden="true" />上传速度</span><strong>{number(run?.uploadMbps)}<small>Mbps</small></strong><small>{resultDownloadOnly ? "此节点仅测下载" : `${number(run?.uploadMbps == null ? null : run.uploadMbps / 8)} MB/s`}</small></div>
        <div><span>HTTP 延迟</span><strong>{number(run?.latencyMs)}<small>ms</small></strong><small>六次请求的中位数（预热后）</small></div>
        <div><span>HTTP 波动</span><strong>{number(run?.jitterMs)}<small>ms</small></strong><small>相邻请求耗时差的均值</small></div>
      </div>
      {run?.error && <p className="notes-error" role="alert">{run.error}</p>}
      {!!run?.warnings.length && <ul className="speed-warnings">{run.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <SpeedChart run={run} />
      <p className="speed-muted">结果表示到所选节点的 HTTP 应用层吞吐，包含请求开销；跨境路径、节点负载和流量上限会影响结果。HTTP 延迟包含服务端处理时间，不代表 ICMP Ping 或签约带宽。关闭页面后测速会继续，可重新打开查看并停止。</p>
    </> : <>
      <div className="speed-history-heading"><strong>最近 20 次测速</strong><span>完成、停止和失败均保留，部分结果不可作为完整测速结论。</span></div>
      {!history.length ? <p role="status">暂无测速历史，完成一次测速后会自动保存在本机。</p> : <div className="speed-history-wrap"><table className="speed-history"><caption className="sr-only">本机网络测速历史</caption><thead><tr><th>时间 / 节点</th><th>下载 / 上传 Mbps</th><th>HTTP 延迟 / 波动 ms</th><th>载荷估算</th><th>状态</th></tr></thead><tbody>{history.map(item => <tr key={item.id}><td>{new Date(item.startedAt).toLocaleString()}<small>{item.endpoint}{item.colo ? ` · ${item.colo}` : ""}</small></td><td>{number(item.downloadMbps)} / {number(item.uploadMbps)}</td><td>{number(item.latencyMs)} / {number(item.jitterMs)}</td><td>{traffic(item.trafficBytes)}</td><td>{statusText[item.status]}{item.error && <small>{item.error}</small>}{item.warnings.map((w, i) => <small key={i}>{w}</small>)}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
