import { ToastNotice } from "../../shared/ToastNotice";
import { useEffect, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowUp, Clock3, Gauge, History, Info, MapPin, Play, RefreshCw, Square } from "lucide-react";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { speedTestClient, type SpeedNetworkInfo, type SpeedTestConfig, type SpeedRun } from "../../platform/clients/speed-test";
import "./network-speed.css";
import { estimateBandwidth } from "./bandwidth-estimate";

const phaseText = { connecting: "检测节点", latency: "HTTP 延迟", download: "下载测速", upload: "上传测速" };
const statusText = { running: "测速中", completed: "已完成", cancelled: "已停止 · 部分结果", failed: "未完成 · 部分结果" };
const nodeNames: Record<string, string> = { "cn-qiniu": "七牛 CDN", "cn-alipay": "支付宝 CDN", cloudflare: "Cloudflare", custom: "自建节点" };
const number = (value: number | null | undefined) => value == null ? "—" : value.toFixed(1);
const traffic = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

function SpeedChart({ run }: { run: SpeedRun | null }) {
  const points = run?.points ?? [];
  const max = Math.max(1, ...points.map(p => p.mbps));
  const end = Math.max(1, run?.elapsedSecs ?? 1);
  const path = (direction: string) => points.filter(p => p.direction === direction).map((p, i) => `${i ? "L" : "M"}${p.seconds / end * 1000},${160 - p.mbps / max * 160}`).join(" ");
  if (!points.length) return <div className="speed-chart-idle" role="img" aria-label="速度曲线，开始测速后显示">开始测速后显示实时曲线</div>;
  return <figure className="speed-chart">
    <figcaption><strong><Activity size={15} aria-hidden="true" />实时速度</strong><span><i className="speed-download" />下载（实线）{!((run?.node ?? "cn-qiniu").startsWith("cn-")) && <><i className="speed-upload" />上传（虚线）</>}<small>Mbps</small></span></figcaption>
    <div className={`speed-plot${points.length ? "" : " is-empty"}`}>
      <div className="speed-axis-y" aria-hidden="true">{[1, .5, 0].map(ratio => <span key={ratio}>{points.length ? number(max * ratio) : "—"}</span>)}</div>
      <svg viewBox="0 0 1000 160" preserveAspectRatio="none" role="img" aria-label={points.length ? `速度曲线，当前纵轴上限 ${number(max)} Mbps，横轴 ${number(end)} 秒` : "速度曲线，开始测速后显示"}>
        {[0, 80, 160].map(y => <line key={y} x1="0" x2="1000" y1={y} y2={y} className="speed-grid" />)}
        <path d={path("download")} className="speed-line speed-download" />
        <path d={path("upload")} className="speed-line speed-upload" strokeDasharray="6 4" />
      </svg>
      <div className="speed-axis-x" aria-hidden="true"><span>0 s</span><span>{points.length ? `${number(end)} s` : "时间 / 秒"}</span></div>
    </div>
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
  const resultDownloadOnly = (run?.node ?? config.node).startsWith("cn-");
  const bandwidth = estimateBandwidth(run);

  async function refreshNetworkInfo() {
    if (!runningInTauri) return;
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
    catch (reason) { if (mounted.current) setError(platformErrorMessage(reason)); }
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

  return <section className="network-speed" aria-label="网络测速工具">
    {!runningInTauri && <p className="speed-preview-notice" role="status">可选择节点和参数预览界面；实际测速由 App 执行。</p>}
    <div className="speed-tabs" role="group" aria-label="测速视图">{([['test', '测速'], ['history', '历史记录']] as const).map(([value, label]) => <button type="button" key={value} className={tab === value ? "is-active" : ""} aria-pressed={tab === value} onClick={() => setTab(value)}>{value === "test" ? <Gauge size={14} aria-hidden="true" /> : <History size={14} aria-hidden="true" />}{label}</button>)}</div>
    {error && <ToastNotice message={error} tone="error" />}
    {tab === "test" ? <>
      <form className="speed-form" onSubmit={event => { event.preventDefault(); void operate(start); }}>
        <label>测速节点<select aria-label="测速节点" value={config.node} disabled={busy || running} onChange={e => setConfig(c => ({ ...c, node: e.target.value as SpeedTestConfig["node"] }))}><option value="cn-qiniu">国内 · 七牛 CDN（仅下载）</option><option value="cn-alipay">国内 · 支付宝 CDN（仅下载）</option><option value="cloudflare">Cloudflare · 自动边缘节点（下载 / 上传）</option><option value="custom">自建兼容节点</option></select></label>
        <label>每方向时长<select aria-label="每方向时长" value={config.durationSecs} disabled={busy || running} onChange={e => setConfig(c => ({ ...c, durationSecs: Number(e.target.value) }))}>{[5, 10, 15].map(v => <option key={v} value={v}>{v} 秒</option>)}</select></label>
        <label>总载荷上限<select aria-label="总载荷上限" value={config.limitMib} disabled={busy || running} onChange={e => setConfig(c => ({ ...c, limitMib: Number(e.target.value) }))}>{[50, 200, 500].map(v => <option key={v} value={v}>{v} MiB</option>)}</select></label>
        <div className="speed-actions">{running ? <button type="button" className="secondary speed-stop" disabled={!runningInTauri || busy || stopping} onClick={() => void operate(async () => { await speedTestClient.cancel(run!.id); if (mounted.current) setStopping(true); })}><Square size={14} aria-hidden="true" />{stopping ? "正在停止…" : "停止测速"}</button> : <button type="submit" className="primary" disabled={busy || loading}><Play size={15} aria-hidden="true" />开始测速</button>}</div>
        {config.node === "custom" && <label className="speed-custom">节点基础地址<input type="url" required maxLength={512} placeholder="https://speed.example.com/" value={config.baseUrl} disabled={busy || running} onChange={e => setConfig(c => ({ ...c, baseUrl: e.target.value }))} /><small>需支持 Cloudflare 兼容的 __down?bytes=N 和 __up 接口，仅接受公网 HTTPS。</small></label>}
      </form>
      <div className="speed-status" role="status" aria-live="polite"><strong>{loading ? "正在读取测速状态…" : running ? `${stopping ? "正在停止" : phaseText[run.phase]}` : run ? statusText[run.status] : "准备就绪"}</strong><span>{run ? `${number(run.elapsedSecs)} 秒 · ${traffic(run.trafficBytes)} / ${run.limitMib} MiB${run.colo ? ` · 节点 ${run.colo}` : ""}` : `每方向 ${config.durationSecs} 秒 · 上限 ${config.limitMib} MiB`}</span></div>
      <div className={`speed-metrics${resultDownloadOnly ? " is-download-only" : ""}`}>
        <div className="speed-metric-download"><span><ArrowDown size={15} aria-hidden="true" />下载速度</span><strong>{number(run?.downloadMbps)}<small>Mbps</small></strong><small>{number(run?.downloadMbps == null ? null : run.downloadMbps / 8)} MB/s</small></div>
        {!resultDownloadOnly && <div className="speed-metric-upload"><span><ArrowUp size={15} aria-hidden="true" />上传速度</span><strong>{number(run?.uploadMbps)}<small>Mbps</small></strong><small>{number(run?.uploadMbps == null ? null : run.uploadMbps / 8)} MB/s</small></div>}
        <div className="speed-metric-bandwidth" title="下载速度换算：Mbps 除以 8 得到 MB/s"><span><Gauge size={15} aria-hidden="true" />下载速度换算</span><strong>{bandwidth ?? "—"}</strong><small>{bandwidth ? "Mbps ÷ 8 = MB/s" : running ? "测速完成后换算" : run ? "需完成下载测速" : "测速后换算"}</small></div>
        <div title="预热后 6 次请求耗时的中位数"><span><Clock3 size={15} aria-hidden="true" />HTTP 延迟</span><strong>{number(run?.latencyMs)}<small>ms</small></strong></div>
        <div title="相邻请求耗时差的均值"><span><Activity size={15} aria-hidden="true" />HTTP 波动</span><strong>{number(run?.jitterMs)}<small>ms</small></strong></div>
      </div>
      {run?.error && <p className="notes-error" role="alert">{run.error}</p>}
      {!!run?.warnings.length && <details className="speed-run-notes"><summary>测速提示（{run.warnings.length}）</summary><ul className="speed-warnings">{run.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <SpeedChart run={run} />
    <section className="speed-network" aria-label="本机网络信息" aria-busy={networkLoading}>
      <details><summary><MapPin size={13} aria-hidden="true" />本机网络信息{networkError && <span> · 获取异常，可展开重试</span>}</summary>
      <div className="speed-network-head"><button type="button" className="secondary" disabled={!runningInTauri || networkLoading} onClick={() => void refreshNetworkInfo()}><RefreshCw size={13} aria-hidden="true" />{networkLoading ? "正在获取…" : "刷新网络信息"}</button></div>
      <dl><div><dt>公网 IP（出口）</dt><dd>{networkInfo?.publicIp ?? (networkLoading ? "获取中…" : runningInTauri ? "未获取" : "网页端不读取")}</dd></div><div><dt>本机内网 IP（默认 IPv4 接口）</dt><dd>{networkInfo?.localIp ?? (networkLoading ? "获取中…" : runningInTauri ? "未获取" : "网页端不读取")}</dd></div><div className="speed-network-location"><dt>IP 归属地 / 运营商</dt><dd>{networkInfo?.location ?? (networkLoading ? "获取中…" : runningInTauri ? "未获取" : "网页端不读取")}</dd></div></dl>
      {networkError && <p role="status" className="speed-network-error">{networkError}。可刷新重试，测速仍可正常使用。</p>}
      {runningInTauri && <p className="speed-network-note">IPIP.NET 归属地参考{networkInfo && ` · 更新于 ${new Date(networkInfo.checkedAt).toLocaleTimeString()}`}。归属地为大致位置；VPN / TUN 可能改变出口。网络信息不写入测速历史。</p>}
      </details>
    </section>
      <details className="speed-method"><summary><Info size={13} aria-hidden="true" />测速说明</summary><p className="speed-muted">应用直连，四连接并发，历史仅保存在本机。国内 CDN 仅测试下载与延迟，测试上传请选择 Cloudflare 或自建节点。下载速度换算将完成测速的下载 Mbps 除以 8，显示约多少 MB/s；Mbps（兆比特/秒）与 MB/s（兆字节/秒）相差 8 倍：MB/s 乘以 8 得到 Mbps，Mbps 除以 8 得到 MB/s。例如 34.5 MB/s 约等于 276 Mbps，300 Mbps 的理论下载速度为 37.5 MB/s。参考值仅反映当前节点下的有效吞吐，不能确定运营商套餐档位。延迟与波动单位为 ms。下载与上传各使用一半预算，国内 CDN 使用全部预算下载。结果表示到所选节点的 HTTP 应用层吞吐，包含请求开销；VPN / TUN、跨境路径、节点负载和流量上限会影响结果。HTTP 延迟取预热后 6 次请求耗时的中位数，波动为相邻请求耗时差的均值。HTTP 延迟包含服务端处理时间，不代表 ICMP Ping 或签约带宽。流量为下载接收量加已提交上传载荷的保守估算，不含协议开销。测速节点可看到来源 IP，应用不向节点上报测速摘要。关闭页面后测速会继续，可重新打开查看并停止。</p></details>
    </> : <>
      <div className="speed-history-heading"><strong>最近 20 次测速</strong><span>记录仅保存在本机</span></div>
      {!history.length ? <p role="status">{runningInTauri ? "暂无测速历史，完成一次测速后会自动保存在本机。" : "网页预览不读取本机测速历史；在 CloudHub App 中完成的记录仅保存在对应设备。"}</p> : <div className="speed-history-wrap">
        <table className="speed-history">
          <caption className="sr-only">本机网络测速历史</caption>
          <thead><tr><th>时间 / 节点</th><th>下载 / 上传<small>Mbps</small></th><th>下载换算<small>MB/s</small></th><th>延迟 / 波动<small>ms</small></th><th>载荷</th><th>状态</th></tr></thead>
          <tbody>{history.map(item => <tr key={item.id}>
            <td data-label="时间 / 节点">{new Date(item.startedAt).toLocaleString()}<small>{nodeNames[item.node] ?? "测速节点"}{item.colo ? ` · ${item.colo}` : ""}</small></td>
            <td data-label="下载 / 上传 Mbps">{number(item.downloadMbps)} / {number(item.uploadMbps)}</td>
            <td data-label="下载换算 MB/s">{estimateBandwidth(item) ?? "—"}</td>
            <td data-label="延迟 / 波动 ms">{number(item.latencyMs)} / {number(item.jitterMs)}</td>
            <td data-label="载荷">{traffic(item.trafficBytes)}</td>
            <td data-label="状态">{statusText[item.status]}<details className="speed-history-details"><summary>详情{item.warnings.length ? `（${item.warnings.length} 条提示）` : ""}</summary><div><p>{item.endpoint}</p>{item.error && <p>{item.error}</p>}{item.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></details></td>
          </tr>)}</tbody>
        </table>
      </div>}

    </>}
  </section>;
}
