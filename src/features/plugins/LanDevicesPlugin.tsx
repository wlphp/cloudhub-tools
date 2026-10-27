import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, ExternalLink, Monitor, Network, Play, RefreshCw, Square, Star } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { runningInTauri } from "../../platform/api";
import { DEFAULT_LAN_PORTS, lanClient, lanDeviceKey, lanService, type LanAnnotation, type LanDevice, type LanInterface, type LanLedger, type LanScan } from "../../platform/clients/lan";
import { SharedDialog } from "../../shared/SharedDialog";
import { PaginationBar } from "../../shared/PaginationBar";
import "./lan-devices.css";

const empty: LanLedger = { devices: [], history: [] };
const stateText = { running: "扫描中", completed: "已完成", cancelled: "已停止", failed: "未完整完成" };
const time = (value: number) => new Date(value).toLocaleString();
const interfaceKey = (i: LanInterface) => `${i.id}:${i.ip}:${i.networkKey}`;
const osText = (d: LanDevice) => d.manualOs ? `${d.manualOs} · 手动标记` : d.os ? `${d.os} · ${d.osStatus === "identified" ? "已识别（本机）" : "推测"}` : "系统未识别";
const vendorText = (d: LanDevice) => d.macKind === "local" ? "本地管理 MAC · 可能为随机地址" : d.vendor || "厂商未识别";
type Connect = (ip: string, platform: "linux" | "windows", name: string) => void;

export function LanDevicesPlugin({ onConnect }: { onConnect?: Connect }) {
  const [interfaces, setInterfaces] = useState<LanInterface[]>([]);
  const [selected, setSelected] = useState("");
  const [range, setRange] = useState("");
  const [portText, setPortText] = useState(DEFAULT_LAN_PORTS);
  const [scan, setScan] = useState<LanScan | null>(null);
  const [ledger, setLedger] = useState<LanLedger>(empty);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState("devices");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<LanDevice | null>(null);
  const [editing, setEditing] = useState<LanAnnotation | null>(null);
  const [historyDetail, setHistoryDetail] = useState<LanScan | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const networkRequest = useRef(0);
  const mounted = useRef(true);
  const operationLock = useRef(false);
  const scanGeneration = useRef(0);
  const network = interfaces.find(i => interfaceKey(i) === selected);
  const networkRef = useRef(network); networkRef.current = network;
  const running = scan?.status === "running";
  const currentScan = scan?.networkKey === network?.networkKey ? scan : null;

  async function loadLedger(key: string) {
    const generation = ++networkRequest.current;
    const result = await lanClient.ledger(key);
    if (mounted.current && generation === networkRequest.current && key === networkRef.current?.networkKey) setLedger(result);
  }
  async function refresh() {
    const rows = await lanClient.interfaces();
    if (!mounted.current) return;
    setInterfaces(rows);
    const next = rows.find(i => interfaceKey(i) === selectedRef.current) ?? rows[0];
    setSelected(next ? interfaceKey(next) : "");
    if (next) setRange(next.suggestedRange);
  }
  async function operate(action: () => Promise<void>) {
    if (operationLock.current) return;
    operationLock.current = true;
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { operationLock.current = false; if (mounted.current) setBusy(false); }
  }

  useEffect(() => {
    mounted.current = true;
    if (!runningInTauri) { setLoading(false); return; }
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    let finishedId = "";
    const poll = async () => {
      try {
        const generation = scanGeneration.current;
        const current = await lanClient.status();
        if (disposed) return;
        if (generation === scanGeneration.current) setScan(current);
        if (generation === scanGeneration.current && current && current.status !== "running" && finishedId !== current.id) {
          if (current.networkKey === networkRef.current?.networkKey) await loadLedger(current.networkKey);
          finishedId = current.id;
        }
      } catch (reason) { if (!disposed) setError(`刷新扫描状态失败：${String(reason)}`); }
      if (!disposed) timer = setTimeout(poll, 900);
    };
    void refresh().catch(reason => { if (!disposed) setError(String(reason)); }).finally(() => { if (!disposed) setLoading(false); });
    void poll();
    return () => { disposed = true; mounted.current = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    setLedger(empty); setPage(1); setDetail(null); setEditing(null); setHistoryDetail(null);
    networkRequest.current++;
    if (network) void loadLedger(network.networkKey).catch(reason => { if (mounted.current && networkRef.current?.networkKey === network.networkKey) setError(String(reason)); });
  }, [network?.networkKey]);
  useEffect(() => setPage(1), [query, filter, tab]);

  const rows = useMemo(() => {
    const map = new Map(ledger.devices.map(d => [lanDeviceKey(d), d]));
    for (const found of currentScan?.devices ?? []) {
      const key = lanDeviceKey(found);
      // During probing MAC may not yet be known; reconcile by IP only for this display.
      const previous = map.get(key) ?? ledger.devices.find(d => d.ip === found.ip && (!found.mac || !d.mac));
      if (previous) map.delete(lanDeviceKey(previous));
      map.set(key, previous ? { ...found, alias: previous.alias, note: previous.note, tags: previous.tags, favorite: previous.favorite, manualKind: previous.manualKind, manualOs: previous.manualOs } : found);
    }
    const seen = new Set((currentScan?.devices ?? []).map(d => d.ip));
    return [...map.values()].map(d => ({ ...d, seen: seen.has(d.ip) && (currentScan?.devices.some(v => v.ip === d.ip && (!v.mac || !d.mac || v.mac === d.mac)) ?? false) })).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  }, [ledger.devices, currentScan]);
  const filtered = rows.filter(d => (filter === "all" || filter === "seen" && d.seen || filter === "unseen" && !d.seen || filter === "favorite" && d.favorite || filter === "services" && d.ports.length > 0) && `${d.ip} ${d.mac} ${d.hostname} ${d.vendor} ${d.kind} ${d.manualKind} ${d.os ?? ""} ${d.manualOs ?? ""} ${d.model ?? ""} ${d.alias} ${d.note} ${d.tags} ${d.ports.map(p => `${p} ${lanService(p)}`).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const shown = filtered.slice((page - 1) * 20, page * 20);

  async function start() {
    if (!network) return;
    const tokens = portText.split(/[,，\s]+/).filter(Boolean);
    if (!tokens.length || tokens.length > 32 || tokens.some(t => !/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 65535)) throw new Error("请输入 1–32 个 TCP 端口，范围 1–65535，用逗号分隔");
    scanGeneration.current++;
    const next = await lanClient.start(network, range.trim(), tokens.map(Number));
    scanGeneration.current++;
    if (mounted.current) { setScan(next); setTab("devices"); setPage(1); }
  }
  function edit(device: LanDevice) {
    setEditing({ networkKey: network!.networkKey, deviceKey: lanDeviceKey(device), alias: device.alias, note: device.note, tags: device.tags, favorite: device.favorite, manualKind: device.manualKind, manualOs: device.manualOs ?? "" });
    setDetail(null);
  }
  function connect(d: LanDevice, platform: "linux" | "windows") { onConnect?.(d.ip, platform, d.alias || d.hostname || d.ip); }
  async function website(d: LanDevice, port: number) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(d.ip) || !d.ports.includes(port)) throw new Error("设备地址或端口无效");
    await openUrl(`${port === 443 || port === 8443 ? "https" : "http"}://${d.ip}:${port}/`);
  }
  function actions(d: LanDevice, showDetail = true) { return <div className="lan-actions">
    {showDetail && <button type="button" className="table-link" onClick={() => setDetail(d)}>详情</button>}
    {d.ports.filter(p => [80,443,8080,8443].includes(p)).slice(0,2).map(p => <button type="button" className="table-link" key={p} title={`打开 ${d.ip}:${p}`} onClick={() => void operate(() => website(d,p))}><ExternalLink size={13} aria-hidden="true" />{lanService(p)}</button>)}
    {onConnect && d.ports.includes(22) && <button type="button" className="table-link" onClick={() => connect(d,"linux")}>SSH</button>}
    {onConnect && d.ports.includes(3389) && <button type="button" className="table-link" onClick={() => connect(d,"windows")}>RDP</button>}
  </div>; }

  if (!runningInTauri) return <section className="lan-devices"><p role="status">局域网设备扫描仅支持 Windows 和 macOS 桌面客户端，浏览器预览与手机端不执行扫描。</p></section>;
  return <section className="lan-devices" aria-label="局域网设备扫描">
    <div className="lan-intro"><Network size={18} aria-hidden="true" /><div><strong>发现设备，连接服务</strong><p>选择本机网络后主动扫描，设备台账仅保存在本地。</p></div></div>
    <form className="lan-scan-form" onSubmit={e => { e.preventDefault(); void operate(start); }}>
      <label>网络接口<select aria-label="网络接口" disabled={busy || running || loading} value={selected} onChange={e => { const next = interfaces.find(i => interfaceKey(i) === e.target.value); setSelected(e.target.value); setRange(next?.suggestedRange ?? ""); }}><option value="" disabled>选择网络接口</option>{interfaces.map(i => <option key={interfaceKey(i)} value={interfaceKey(i)}>{i.name} · {i.ip}/{i.prefix}{i.network ? ` · ${i.network}` : ""}</option>)}</select></label>
      <label>扫描范围<input aria-label="扫描范围" disabled={busy || running} value={range} maxLength={100} onChange={e => setRange(e.target.value)} placeholder="192.168.1.0/24 或完整起止 IP" /></label>
      <label className="lan-ports">TCP 端口<input aria-label="TCP 端口" disabled={busy || running} value={portText} maxLength={200} onChange={e => setPortText(e.target.value)} /></label>
      <div className="lan-actions"><button type="submit" disabled={!network || busy || running || loading}><Play size={14} aria-hidden="true" />开始扫描</button><button type="button" className="secondary" disabled={busy || !running} onClick={() => void operate(async () => { await lanClient.cancel(scan!.id); setNotice("已请求停止，正在整理已发现结果。"); })}><Square size={13} aria-hidden="true" />停止</button><button type="button" className="secondary" disabled={busy || running || loading} onClick={() => void operate(refresh)}><RefreshCw size={14} aria-hidden="true" />刷新网卡</button></div>
    </form>
    {network && <p className="lan-muted">本机 {network.ip} · 网关 {network.gateway || "未获取"} · 单次最多 1024 个地址，仅扫描所选接口的私有子网。VPN / 虚拟网卡请按名称辨别。</p>}
    {loading && <p role="status">正在读取网卡…</p>}
    {!loading && !interfaces.length && <p role="status">未发现可扫描的私有 IPv4 网络，请连接 Wi-Fi / 有线网络后刷新。当前仅支持 Windows、macOS。</p>}
    {scan && <div className="lan-progress" role="status"><span>{currentScan ? "" : "其他网络："}{stateText[scan.status]} · {scan.completed}/{scan.total} 个地址 · 发现 {scan.devices.length} 台</span>{running && <progress aria-label="扫描进度" value={scan.completed} max={scan.total} />}</div>}
    {error && <p className="lan-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {currentScan?.warnings.map(w => <p className="lan-error" role="status" key={w}>{w}</p>)}
    <nav className="lan-tabs" aria-label="设备视图"><button type="button" className={tab === "devices" ? "is-active" : ""} aria-pressed={tab === "devices"} onClick={() => setTab("devices")}>设备台账 · {rows.length}</button><button type="button" className={tab === "history" ? "is-active" : ""} aria-pressed={tab === "history"} onClick={() => setTab("history")}>扫描历史 · {ledger.history.length}</button></nav>
    {tab === "devices" ? <>
      <div className="lan-toolbar"><label>搜索<input aria-label="搜索设备" value={query} onChange={e => setQuery(e.target.value)} placeholder="IP、名称、类型、服务或标签" /></label><label>状态<select aria-label="筛选设备" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部设备</option><option value="seen">本次发现</option><option value="unseen">本次未发现 / 历史</option><option value="favorite">已收藏</option><option value="services">有开放服务</option></select></label><div className="lan-actions">{(["csv","json"] as const).map(format => <button type="button" className="secondary" key={format} disabled={busy || running || !network || !ledger.devices.length} onClick={() => void operate(async () => { const file = await lanClient.export(network!.networkKey,format); if (file) setNotice(`设备台账已导出：${file}`); })}><Download size={13} aria-hidden="true" />{format.toUpperCase()}</button>)}</div></div>
      <div className="lan-table-wrap">
        <table className="lan-table">
          <caption className="store-table-caption">当前网络设备台账</caption>
          <thead><tr><th>设备 / 地址</th><th>类型 / 系统 / 厂商</th><th>本次状态</th><th>TCP 服务</th><th>最近发现</th><th>操作</th></tr></thead>
          <tbody>{shown.map(d => <tr key={lanDeviceKey(d)}>
            <td data-label="设备 / 地址">
              <strong>{d.favorite && <Star size={12} aria-label="已收藏" />}{d.alias || d.hostname || d.ip}</strong>
              {(d.alias || d.hostname) && <small>{d.ip}</small>}
              <small className="lan-mac">{d.mac || "MAC 未获取"}</small>
              {d.tags && <small>{d.tags}</small>}
            </td>
            <td data-label="类型 / 系统 / 厂商">{d.manualKind || d.kind}<small className={`lan-os${d.os || d.manualOs ? " has-os" : ""}`}>{osText(d)}</small><small>{vendorText(d)}</small>{d.model && <small>{d.model}</small>}</td>
            <td data-label="本次状态">
              <span className={`lan-state${d.seen ? " is-seen" : ""}`}><i aria-hidden="true" />{d.seen ? "本次发现" : currentScan?.status === "running" ? "尚未发现" : "历史 / 本次未发现"}</span>
              {d.seen && d.latencyMs !== null && <small>{d.latencyMs} ms</small>}
            </td>
            <td data-label="TCP 服务"><div className="lan-services">{d.ports.length ? d.ports.map(p => <span key={p}>{lanService(p)} <em>{p}</em></span>) : <small>未检测到开放端口</small>}</div></td>
            <td data-label="最近发现" title={time(d.lastSeen)}><span>{new Date(d.lastSeen).toLocaleDateString()}</span><small>{new Date(d.lastSeen).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></td>
            <td data-label="操作">{actions(d)}</td>
          </tr>)}</tbody>
        </table>
        {!filtered.length && <div className="lan-empty" role="status"><Network size={26} aria-hidden="true" /><p>{rows.length ? "没有符合筛选条件的设备。" : "还没有设备记录，选择网络并开始扫描。"}</p></div>}
      </div>
      <PaginationBar page={page} pageSize={20} total={filtered.length} onPageChange={setPage} />
    </> : <div className="lan-history">{ledger.history.map(s => <button type="button" className="secondary" key={s.id} onClick={() => setHistoryDetail(s)}><span>{time(s.startedAt)}</span><span>{s.range} · {stateText[s.status]} · {s.devices.length} 台 · {s.completed}/{s.total} 地址</span></button>)}{!ledger.history.length && <p role="status">暂无扫描历史，每个网络保留最近 20 次。</p>}</div>}
    <details className="lan-help"><summary>扫描说明 · 未响应不代表离线</summary><p>防火墙、休眠和 Wi-Fi 客户端隔离可能影响发现。设备类型为端口推测，厂商使用小型离线 OUI 表，未命中时留空。网络档案按网卡、网关、子网等信息区分；配置相同的不同网络可能共用台账。扫描期间关闭页面仍会在客户端继续，可重新打开查看或停止。</p></details>
    {detail && <SharedDialog title="设备详情" subtitle="设备信息与服务" icon={<Network size={18} aria-hidden="true" />} className="lan-device-dialog" onClose={() => setDetail(null)} footer={<><button type="button" className="secondary" disabled={busy} onClick={() => void operate(async () => { await navigator.clipboard.writeText(detail.ip); setNotice("IP 已复制"); })}><Copy size={14} aria-hidden="true" />复制 IP</button><button type="button" disabled={busy || running || !ledger.devices.some(d => lanDeviceKey(d) === lanDeviceKey(detail))} onClick={() => edit(detail)}>编辑台账</button></>}>
      <div className="lan-device-summary">
        <span className="lan-device-symbol"><Monitor size={24} aria-hidden="true" /></span>
        <div><strong>{detail.alias || detail.hostname || detail.ip}</strong><span className="lan-device-address">{detail.ip}</span></div>
        {detail.favorite && <Star size={16} aria-label="已收藏" />}
      </div>
      <div className="lan-device-columns">
        <section className="lan-device-section" aria-label="基本信息"><h3>基本信息</h3>
          <dl className="lan-details">
            <dt>主机名</dt><dd>{detail.hostname || "未获取"}</dd>
            <dt>MAC 地址</dt><dd className="lan-device-mono">{detail.mac || "未获取"}</dd>
            <dt>设备类型</dt><dd>{detail.manualKind || detail.kind}</dd>
            <dt>厂商</dt><dd>{vendorText(detail)}</dd>
            <dt>设备型号</dt><dd>{detail.model || "未获取"}</dd>
          </dl>
        </section>
        <section className="lan-device-section" aria-label="系统识别"><h3>系统识别</h3>
          <span className={`lan-device-os${detail.os || detail.manualOs ? " has-os" : ""}`}>{osText(detail)}</span>
          <p className="lan-device-hint">{detail.osStatus === "identified" ? "自动识别来自本机平台信息。" : detail.os ? "自动识别来自远端声明，仅供参考。" : "暂无可靠系统信息，支持手动标记。"}</p>
          {detail.manualOs && <p className="lan-device-hint">自动识别：{detail.os || "未识别"}</p>}
          <p className="lan-device-hint">开放 SSH、SMB 或 RDP 端口不代表特定操作系统。</p>
        </section>
      </div>
      <section className="lan-device-section lan-device-services" aria-label="开放服务"><h3>开放服务 <span>{detail.ports.length}</span></h3>
        <div className="lan-device-port-list">{detail.ports.length ? detail.ports.map(p => <span key={p}><strong>{lanService(p)}</strong><code>{p}</code></span>) : <p className="lan-device-hint">未检测到开放的 TCP 端口</p>}</div>
        {actions(detail, false)}
      </section>
      <section className="lan-device-section lan-device-evidence" aria-label="识别依据"><h3>识别依据</h3><ul className="lan-evidence">{detail.evidence.length ? detail.evidence.map((e, i) => <li key={i}>{e}</li>) : <li>暂无识别依据</li>}</ul></section>
      {(detail.note || detail.tags) && <section className="lan-device-section lan-device-notes" aria-label="台账记录"><h3>台账记录</h3>{detail.tags && <p>标签 · {detail.tags}</p>}{detail.note && <p>{detail.note}</p>}</section>}
      <p className="lan-device-updated">最近发现 · {time(detail.lastSeen)}</p>
    </SharedDialog>}
    {editing && <SharedDialog title="编辑设备台账" onClose={() => setEditing(null)} busy={busy} closeDisabled={busy} onSubmit={e => { e.preventDefault(); void operate(async () => { await lanClient.annotate(editing); await loadLedger(editing.networkKey); setEditing(null); setNotice("设备台账已保存"); }); }} footer={<><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</button></>}><div className="lan-edit"><label>设备别名<input maxLength={80} value={editing.alias} onChange={e => setEditing({ ...editing, alias:e.target.value })} /></label><label>设备类型（手动标记）<input maxLength={40} value={editing.manualKind} placeholder="例如 NAS、打印机" onChange={e => setEditing({ ...editing, manualKind:e.target.value })} /></label><label>操作系统（手动标记）<input maxLength={80} value={editing.manualOs ?? ""} placeholder="Windows、macOS、Linux；留空恢复自动识别" onChange={e => setEditing({ ...editing, manualOs:e.target.value })} /></label><label>标签<input maxLength={160} value={editing.tags} placeholder="例如 公司、机房" onChange={e => setEditing({ ...editing, tags:e.target.value })} /></label><label>备注<textarea rows={4} maxLength={1000} value={editing.note} onChange={e => setEditing({ ...editing, note:e.target.value })} /></label><label className="lan-checkbox"><input type="checkbox" checked={editing.favorite} onChange={e => setEditing({ ...editing, favorite:e.target.checked })} />收藏设备</label></div></SharedDialog>}
    {historyDetail && <SharedDialog title="扫描历史详情" subtitle={`${time(historyDetail.startedAt)} · ${stateText[historyDetail.status]}`} onClose={() => setHistoryDetail(null)}><p>{historyDetail.range} · {historyDetail.completed}/{historyDetail.total} 地址 · 发现 {historyDetail.devices.length} 台</p>{historyDetail.warnings.map(w => <p key={w}>{w}</p>)}<ul className="lan-history-devices">{historyDetail.devices.map(d => <li key={lanDeviceKey(d)}><strong>{d.ip}</strong> · {d.mac || "MAC 未获取"} · {d.kind} · {d.ports.map(p => `${lanService(p)} ${p}`).join("、") || "无开放端口"}</li>)}</ul>{!historyDetail.devices.length && <p>本次未发现设备。</p>}</SharedDialog>}
  </section>;
}
