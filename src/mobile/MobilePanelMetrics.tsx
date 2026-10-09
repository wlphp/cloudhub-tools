import { ArrowDown, ArrowUp, ArrowUpDown, Cpu, HardDrive, MemoryStick } from "lucide-react";
import type { PanelConnection } from "../shared/types";
import { panelCpuInfo, panelDiskItems, panelLoadText, panelMemoryInfo, panelNetworkInfo, type PanelDiskInfo } from "../features/panels/panelMetrics";

function Usage({ label, detail, percent }: { label: string; detail: string; percent: number | null }) {
  const Icon = label === "CPU" ? Cpu : label === "内存" ? MemoryStick : HardDrive;
  return <div className={`mobile-panel-metric ${label === "CPU" ? "is-cpu" : label === "内存" ? "is-memory" : "is-disk"}`}>
    <dt><span className="mobile-panel-metric-icon" aria-hidden="true"><Icon size={22} /></span><span>{label}</span><strong>{percent === null ? "—" : `${Number(percent.toFixed(1))}%`}</strong></dt>
    <dd><span>{detail === "-" ? "尚无数据" : detail.replace(/\s*\([\d.]+%\)$/, "")}</span>{percent !== null && <div className={`mobile-panel-meter ${percent >= 90 ? "is-high" : ""}`} role="meter" aria-label={`${label}占用率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent.toFixed(1)}%`}><i style={{ width: `${percent}%` }} /></div>}</dd>
  </div>;
}

function Disk({ disk }: { disk: PanelDiskInfo }) {
  return <Usage label="磁盘" detail={`${disk.path !== "-" ? `[${disk.path}] ` : ""}${disk.detail === "-" ? "—" : disk.detail}`} percent={disk.percent} />;
}

export function MobilePanelMetrics({ panel }: { panel: PanelConnection }) {
  const summary = panel.summary ?? {};
  const cpu = panelCpuInfo(summary.cpu);
  const memory = panelMemoryInfo(summary.mem ?? summary.memory);
  const disks = panelDiskItems(summary.disk);
  const network = panelNetworkInfo(summary.network);
  const version = typeof summary.version === "string" || typeof summary.version === "number" ? String(summary.version) : null;
  const checkedAt = panel.last_checked_at ? new Date(panel.last_checked_at) : null;
  const time = checkedAt && Number.isFinite(checkedAt.getTime()) ? checkedAt.toLocaleString() : null;
  return <section className="mobile-panel-monitor" aria-label={`${panel.name} 的缓存监控`}>
    <dl className="mobile-panel-traffic">
      <div><span className="mobile-panel-traffic-icon" aria-hidden="true"><Cpu size={25} /></span><dt>系统负载</dt><dd>{panelLoadText(summary.load).replace(/^-$/, "—")}</dd><small>1 / 5 / 15 分钟</small></div>
      <div><span className="mobile-panel-traffic-icon" aria-hidden="true"><ArrowUpDown size={25} /></span><dt>网络速率</dt><dd className="mobile-panel-network"><span className="is-up"><ArrowUp size={15} aria-hidden="true" /><span className="mobile-sr-only">上行 </span>{network.up === "-" ? "—" : network.up}</span><span className="is-down"><ArrowDown size={15} aria-hidden="true" /><span className="mobile-sr-only">下行 </span>{network.down === "-" ? "—" : network.down}</span></dd></div>
    </dl>
    <dl className="mobile-panel-metrics">
      <Usage label="CPU" detail={cpu.detail} percent={cpu.percent} />
      <Usage label="内存" detail={memory.detail} percent={memory.percent} />
      <Disk disk={disks[0] ?? { path: "-", detail: "-", percent: null }} />
    </dl>
    {disks.length > 1 && <details className="mobile-panel-more-disks"><summary>其他磁盘分区（{disks.length - 1}）</summary><dl className="mobile-panel-metrics">{disks.slice(1).map((disk, index) => <Disk key={`${disk.path}:${index}`} disk={disk} />)}</dl></details>}
    <div className="mobile-panel-monitor-heading"><span>{version ? `面板 v${version}` : "监控缓存"}</span><small>{time ? `更新于 ${time}` : "尚未获取监控数据"}</small></div>
  </section>;
}
