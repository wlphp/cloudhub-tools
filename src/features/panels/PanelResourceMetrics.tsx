import { ArrowDown, ArrowUp, ChevronDown, ChevronUp } from "lucide-react";
import { panelCpuInfo, panelDiskInfo, panelDiskItems, panelLoadText, panelMemoryInfo, panelNetworkInfo } from "./panelMetrics";
import type { PanelConnection } from "../../shared/types";

type PanelResourceMetricsProps = {
  expanded: boolean;
  panel: PanelConnection;
  onExpandedChange: (expanded: boolean) => void;
};

export function PanelResourceMetrics({ expanded, panel, onExpandedChange }: PanelResourceMetricsProps) {
  const summary = panel.summary || {};
  const cpu = panelCpuInfo(summary.cpu);
  const memory = panelMemoryInfo(summary.mem);
  const diskItems = panelDiskItems(summary.disk);
  const disk = panelDiskInfo(summary.disk);
  const network = panelNetworkInfo(summary.network);
  const metrics = [
    { label: "负载", detail: panelLoadText(summary.load), percent: null },
    { label: "网络", detail: <><span className="panel-network-rate up"><ArrowUp size={13} />{network.up}</span><span className="panel-network-rate down"><ArrowDown size={13} />{network.down}</span></>, percent: null },
    { label: "CPU", detail: cpu.detail, percent: cpu.percent },
    { label: "内存", detail: memory.detail, percent: memory.percent },
    { label: "磁盘", detail: disk.detail, percent: disk.percent },
  ];

  return metrics.map((metric) => <div className={`panel-resource-metric ${metric.label === "磁盘" ? "is-disk-metric" : ""}`} key={metric.label}>
    {metric.label === "磁盘" ? <div className="panel-disk-label"><span>磁盘</span>{diskItems.length > 1 && <button type="button" className="panel-disk-toggle" title={expanded ? "收起磁盘分区" : "展开全部磁盘分区"} aria-label={expanded ? "收起磁盘分区" : "展开全部磁盘分区"} aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>}</div> : <span>{metric.label}</span>}
    {metric.label === "磁盘" ? <strong title={`${disk.path} ${metric.detail}`}>{disk.path !== "-" ? `[${disk.path}] ` : ""}{metric.detail}</strong> : typeof metric.detail === "string" ? <strong title={metric.detail}>{metric.detail}</strong> : <strong className="panel-network-detail">{metric.detail}</strong>}
    {metric.percent !== null ? <i title={`${metric.label} ${Math.round(metric.percent)}%`}><b style={{ width: `${metric.percent}%` }} /></i> : <i className="panel-metric-idle" />}
    {metric.label === "磁盘" && expanded && diskItems.slice(1).length > 0 && <div className="panel-disk-volumes">{diskItems.slice(1).map((volume) => <div className="panel-disk-volume" key={`${panel.id}-${volume.path}`}><span>{volume.path}</span><strong title={volume.detail}>{volume.detail}</strong>{volume.percent !== null && <i title={`${volume.path} ${Math.round(volume.percent)}%`}><b style={{ width: `${volume.percent}%` }} /></i>}</div>)}</div>}
  </div>);
}
