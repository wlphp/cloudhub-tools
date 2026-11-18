import { useMemo, useState } from "react";
import { Network, Pause, Play } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import type { WslNetworkTopology, WslTopologyAdapter } from "../../platform/clients/plugins";

interface Props {
  open: boolean;
  topology: WslNetworkTopology;
  /** 浏览器/H5 下为 true：数据是本地调试样例，不是真实巡检结果。 */
  isPreview: boolean;
  onClose: () => void;
}

type Focus = "all" | "main" | "dns" | "direct";
type Tone = "main" | "dir" | "dns" | "back";

function modeLabel(mode: string): string {
  switch (mode.trim().toLowerCase()) {
    case "nat": return "NAT";
    case "mirrored": return "镜像";
    case "bridged": return "桥接";
    case "virtioproxy": return "VirtioProxy";
    case "virt": return "Virt";
    default: return mode.trim() || "未知";
  }
}

function isSharedStackMode(mode: string): boolean {
  const value = mode.trim().toLowerCase();
  return value === "mirrored" || value === "bridged" || value === "virtioproxy" || value === "virt";
}

function shortName(value: string, max = 18): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function ipText(adapter: WslTopologyAdapter | null): string {
  if (!adapter?.ip) return "未分配 IPv4";
  return adapter.prefix === null || adapter.prefix === undefined ? adapter.ip : `${adapter.ip}/${adapter.prefix}`;
}

/** 选中要在图上展示的关键网卡：物理出口、代理 TUN、WSL 虚拟交换机。 */
function pickAdapters(adapters: WslTopologyAdapter[]) {
  const score = (a: WslTopologyAdapter) => (a.active ? 100 : 0) + (a.ip ? 30 : 0)
    + (a.kind === "tun" ? 20 : 0) + (a.kind === "vswitch" ? 15 : 0);
  const sorted = [...adapters].sort((a, b) => score(b) - score(a));
  return {
    physical: sorted.find(a => (a.kind === "wifi" || a.kind === "ethernet") && a.ip)
      ?? sorted.find(a => a.ip && a.kind !== "tun" && a.kind !== "vswitch")
      ?? null,
    // Teredo / Not Present / 无 IPv4 的伪 TUN 不进入拓扑，避免画出虚假链路。
    tun: sorted.find(a => a.kind === "tun" && (a.active || a.ip)) ?? null,
    vswitch: sorted.find(a => a.kind === "vswitch" && a.ip) ?? null,
  };
}

/**
 * 参考 HTML 的画法：
 * - d 是卡片背后的“连续通道”，只供数据包 animateMotion 使用；
 * - links 是卡片之间真正可见的短连线，不穿卡片；
 * - 两者坐标一致，因此视觉上是端到端一条链路，而不是零散短线。
 */
function FlowPath({ id, d, links, tone, dim, active, duration = 5.2, count = 2 }: {
  id: string;
  d: string;
  links: string[];
  tone: Exclude<Tone, "back">;
  dim: boolean;
  active: boolean;
  duration?: number;
  count?: number;
}) {
  const marker = `url(#wt-arw-${tone})`;
  return (
    <g className={`wt-flow wt-flow-${tone} ${dim ? "wt-dim" : ""}`}>
      <path id={id} className="wt-channel" d={d} />
      {links.map((link, index) => <path key={`${id}-link-${index}`} className="wt-link" d={link} markerEnd={marker} />)}
      {active && !dim && Array.from({ length: count }, (_, index) => (
        <circle key={`${id}-pkt-${index}`} className="wt-pkt" r={index === 0 ? 5 : 4.5}>
          <animateMotion dur={`${duration}s`} repeatCount="indefinite" begin={index === 0 ? undefined : `-${(duration / count) * index}s`}>
            <mpath href={`#${id}`} />
          </animateMotion>
        </circle>
      ))}
    </g>
  );
}

/** 只画可见连线、不附加数据包，用于出口段与回程段。 */
function PlainLinks({ links, tone, dim }: { links: string[]; tone: Tone; dim: boolean }) {
  if (!links.length) return null;
  return (
    <g className={`wt-plain wt-plain-${tone} ${dim ? "wt-dim" : ""}`}>
      {links.map((link, index) => (
        <path
          key={`${tone}-${index}`}
          className={tone === "back" ? "wt-back-link" : "wt-link"}
          d={link}
          markerEnd={tone === "back" ? undefined : `url(#wt-arw-${tone})`}
        />
      ))}
    </g>
  );
}

/**
 * 网络拓扑画布：外网（顶）→ Windows（中）→ WSL（底）。
 * 路径与参考 HTML 一致：本机程序和 WSL 发行版都先汇入 Windows 路由表，
 * 再按当前默认路由走 TUN/代理或物理网卡直出。
 */
function TopologyCanvas({ topology, focus, paused }: { topology: WslNetworkTopology; focus: Focus; paused: boolean }) {
  const { adapters, distributions, defaultRoutes, activeGateway, activeAdapter, dnsServers, proxyActive, sharedNetworkStack } = topology;
  const { physical, tun, vswitch } = useMemo(() => pickAdapters(adapters), [adapters]);

  const activeRoute = defaultRoutes.find(route => route.adapter === activeAdapter && route.nextHop === activeGateway)
    ?? defaultRoutes[0]
    ?? null;
  const routeGateway = activeGateway ?? activeRoute?.nextHop ?? null;
  const physicalGateway = physical?.gateway
    ?? defaultRoutes.find(route => route.adapter === physical?.name)?.nextHop
    ?? null;
  const viaTun = Boolean(tun && (proxyActive || activeAdapter === tun.name || activeRoute?.adapter === tun.name));

  const distro = distributions.find(item => item.ipAddress) ?? distributions[0] ?? null;
  const distros = distributions.slice(0, 3);
  const dns = distro?.dns?.length ? distro.dns : dnsServers;
  const routes = defaultRoutes.slice(0, 2);

  // ---- 与参考 HTML 相同的 1240 x 940 三层坐标 ----
  const node = {
    app: { x: 95, y: 225, w: 335, h: 105 },
    route: { x: 95, y: 375, w: 335, h: 145 },
    physical: { x: 470, y: 225, w: 225, h: 145 },
    tun: { x: 725, y: 225, w: 225, h: 145 },
    vswitch: { x: 980, y: 225, w: 215, h: 145 },
    gw: { x: 110, y: 62, w: 240, h: 78 },
    site: { x: 560, y: 62, w: 240, h: 78 },
    proxy: { x: 900, y: 62, w: 240, h: 78 },
    distroBox: { x: 95, y: 648, w: 470, h: 202 },
    dns: { x: 262, y: 772, w: 140, h: 70 },
    wslInfo: { x: 412, y: 772, w: 140, h: 70 },
    wslGw: { x: 630, y: 665, w: 280, h: 195 },
    hns: { x: 985, y: 665, w: 210, h: 195 },
  };

  // 连续运动路径（卡片背后）
  const appChannel = viaTun
    ? "M 262,335 V 445 H 700 V 297 H 837 V 200 H 1020 V 101 H 680"
    : "M 262,335 V 420 H 452 V 297 H 582 V 221 V 193 H 230 V 101 H 680";
  const wslChannel = viaTun
    ? "M 182,762 V 876 H 620 V 752 H 1087 V 520 H 434 V 445 H 700 V 297 H 837 V 200 H 1020 V 101 H 680"
    : "M 182,762 V 876 H 620 V 752 H 1087 V 520 H 434 V 420 H 452 V 297 H 582 V 221 V 193 H 230 V 101 H 680";
  const tunPhysChannel = "M 837,375 V 405 H 582 V 374";
  const dnsChannel = "M 332,842 V 866 H 600 V 812 H 617";

  // 可见短连线（卡片之间）
  const appLinks = ["M 262,335 V 371"];
  const wslLinks = [
    "M 182,762 V 876 H 616", // 发行版 → WSL 网关
    "M 910,752 H 981",       // WSL 网关 → HNS
    "M 1087,661 V 374",      // HNS → vEthernet
    "M 1087,374 V 520 H 434",// vEthernet → Windows 路由表
  ];
  const egressLinks = viaTun
    ? [
      "M 434,445 H 700 V 297 H 721",   // 路由表 → TUN
      "M 837,221 V 200 H 1020 V 146",  // TUN → 代理节点
      "M 896,101 H 806",               // 代理节点 → 目标站点
    ]
    : [
      "M 434,420 H 452 V 297 H 466",   // 路由表 → 物理网卡
      "M 582,221 V 193 H 230 V 146",   // 物理网卡 → 出口网关
      "M 354,101 H 556",               // 出口网关 → 目标站点
    ];
  const backLinks = viaTun
    ? ["M 806,101 H 896", "M 1020,146 V 200 H 837 V 225"]
    : ["M 556,101 H 354"];

  const showMain = focus === "all" || focus === "main";
  const showDirect = focus === "all" || focus === "direct";
  const showDns = focus === "all" || focus === "dns";
  const primaryVisible = viaTun ? showMain : (showMain || showDirect);
  const egressVisible = showMain || showDirect;
  const bypassVisible = viaTun && showDirect;
  const pathTone: Exclude<Tone, "back"> = viaTun ? "main" : "dir";
  const anim = (visible: boolean) => !paused && visible;
  const svgClass = ["wsl-topo-svg", `focus-${focus}`, paused ? "is-paused" : ""].join(" ");

  return (
    <div className="wsl-topo-canvas">
      <div className="wsl-topo-scroll">
        <svg
          className={svgClass}
          viewBox="0 0 1240 940"
          role="img"
          aria-label={`WSL 网络拓扑，当前 ${modeLabel(topology.mode)} 模式，出网${viaTun ? "经代理隧道" : "经物理网卡直出"}`}
        >
          <defs>
            <marker id="wt-arw-main" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--jb-accent)" /></marker>
            <marker id="wt-arw-dir" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--jb-green)" /></marker>
            <marker id="wt-arw-dns" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--jb-warning)" /></marker>
          </defs>

          {/* 分层底板 */}
          <rect className="wt-band" x="40" y="20" width="1160" height="145" rx="14" />
          <text className="wt-band-t" x="58" y="42">局域网 · 外网</text>
          <rect className="wt-band" x="40" y="185" width="1160" height="390" rx="14" />
          <text className="wt-band-t" x="58" y="207">Windows 主机</text>
          <rect className="wt-band" x="40" y="605" width="1160" height="300" rx="14" />
          <text className="wt-band-t" x="58" y="627">WSL 虚拟机 · {modeLabel(topology.mode)} 模式</text>

          {/* 回程路径（参考图中的淡色虚线） */}
          <PlainLinks links={backLinks} tone="back" dim={focus !== "all"} />

          {/* 端到端主路径：数据包沿完整链路流动 */}
          <FlowPath id="wt-p-app" d={appChannel} links={appLinks} tone={pathTone} dim={!primaryVisible} active={anim(primaryVisible)} />
          <FlowPath id="wt-p-wsl" d={wslChannel} links={wslLinks} tone={pathTone} dim={!primaryVisible} active={anim(primaryVisible)} duration={5.2} />
          <PlainLinks links={egressLinks} tone={pathTone} dim={!egressVisible} />
          {viaTun && (
            <FlowPath id="wt-p-tun-phys" d={tunPhysChannel} links={[tunPhysChannel]} tone="dir" dim={!bypassVisible} active={anim(bypassVisible)} duration={2.6} />
          )}
          <FlowPath id="wt-p-dns" d={dnsChannel} links={[dnsChannel]} tone="dns" dim={!showDns} active={anim(showDns)} duration={2.2} />

          {/* 外网节点 */}
          <g className="wt-node">
            <rect x={node.gw.x} y={node.gw.y} width={node.gw.w} height={node.gw.h} rx="10" />
            <text className="wt-t-title" x={node.gw.x + 20} y={node.gw.y + 24}>出口网关 / 路由器</text>
            <text className="wt-t-mono" x={node.gw.x + 20} y={node.gw.y + 48}>{physicalGateway ?? "未检测到"}</text>
            <text className="wt-t-sub" x={node.gw.x + 20} y={node.gw.y + 68}>WAN → 运营商 · 物理出口</text>
          </g>
          <g className="wt-node">
            <rect x={node.site.x} y={node.site.y} width={node.site.w} height={node.site.h} rx="10" />
            <text className="wt-t-title" x={node.site.x + 20} y={node.site.y + 24}>目标站点 / 外网</text>
            <text className="wt-t-mono" x={node.site.x + 20} y={node.site.y + 48}>公网地址</text>
            <text className="wt-t-sub" x={node.site.x + 20} y={node.site.y + 68}>出站流量目的地</text>
          </g>
          {viaTun && tun && (
            <g className="wt-node wt-node-proxy">
              <rect x={node.proxy.x} y={node.proxy.y} width={node.proxy.w} height={node.proxy.h} rx="10" />
              <text className="wt-t-title" x={node.proxy.x + 20} y={node.proxy.y + 24}>代理 / 隧道节点</text>
              <text className="wt-t-mono wt-t-proxy" x={node.proxy.x + 20} y={node.proxy.y + 48}>{shortName(tun.name, 22)}</text>
              <text className="wt-t-sub" x={node.proxy.x + 20} y={node.proxy.y + 68}>{shortName(tun.description, 24)} · 隧道出站</text>
            </g>
          )}

          {/* Windows 节点 */}
          <g className="wt-node wt-node-hi">
            <rect x={node.app.x} y={node.app.y} width={node.app.w} height={node.app.h} rx="10" />
            <text className="wt-t-title" x={node.app.x + 20} y={node.app.y + 27}>Windows 本机程序</text>
            <text className="wt-t-sub" x={node.app.x + 20} y={node.app.y + 47}>浏览器 · 终端 · Docker · 系统服务</text>
            <text className="wt-t-note-fg" x={node.app.x + 20} y={node.app.y + 75}>出站 → 路由表 → {viaTun ? "代理隧道 → 站点" : "物理网卡 → 出口"}</text>
            <text className="wt-t-note" x={node.app.x + 20} y={node.app.y + 93}>{viaTun ? "境内流量可由 TUN 从物理网卡直接发出" : "全部直出，不经过代理节点"}</text>
          </g>

          <g className="wt-node">
            <rect x={node.route.x} y={node.route.y} width={node.route.w} height={node.route.h} rx="10" />
            <text className="wt-t-lbl" x={node.route.x + 20} y={node.route.y + 25}>Windows IPv4 路由表</text>
            {routes.length ? routes.map((route, index) => {
              const y = node.route.y + 49 + index * 56;
              const active = route.adapter === activeAdapter && route.nextHop === routeGateway;
              return (
                <g key={`${route.adapter}-${index}`}>
                  <text className="wt-t-mono" x={node.route.x + 20} y={y}>0.0.0.0/0 → {shortName(route.nextHop, 17)}</text>
                  <text className="wt-t-mono-sm" x={node.route.x + 20} y={y + 17}>via {shortName(route.adapter, 18)} · metric {route.metric}</text>
                  <text className={active ? "wt-t-on" : "wt-t-off"} x={node.route.x + 193} y={y}>{active ? "● 生效" : "— 备用"}</text>
                </g>
              );
            }) : (
              <text className="wt-t-sub" x={node.route.x + 20} y={node.route.y + 60}>未检测到默认路由</text>
            )}
            {routes.length < 2 && <text className="wt-t-note" x={node.route.x + 20} y={node.route.y + 122}>出口由 metric 最小的默认路由决定</text>}
          </g>

          <g className={`wt-node ${physical ? "wt-node-hi" : ""}`}>
            <rect x={node.physical.x} y={node.physical.y} width={node.physical.w} height={node.physical.h} rx="10" />
            <text className="wt-t-title" x={node.physical.x + 20} y={node.physical.y + 27}>{physical ? shortName(physical.name, 18) : "物理网卡"}</text>
            <text className="wt-t-sub" x={node.physical.x + 20} y={node.physical.y + 47}>{physical ? shortName(physical.description, 24) : "未检测到"}</text>
            <text className="wt-t-mono" x={node.physical.x + 20} y={node.physical.y + 77}>{ipText(physical)}</text>
            <text className="wt-t-note-fg" x={node.physical.x + 20} y={node.physical.y + 99}>{physicalGateway ? `网关 ${physicalGateway}` : "无默认网关"}</text>
            <text className={viaTun ? "wt-t-note" : "wt-t-on"} x={node.physical.x + 20} y={node.physical.y + 124}>
              {viaTun ? `物理出口 · metric ${physical?.metric ?? "—"} 备用` : `● 生效 · metric ${physical?.metric ?? "—"}`}
            </text>
          </g>

          {tun && (
            <g className={`wt-node ${viaTun ? "wt-node-hi wt-node-proxy" : ""}`}>
              <rect x={node.tun.x} y={node.tun.y} width={node.tun.w} height={node.tun.h} rx="10" />
              <text className="wt-t-title" x={node.tun.x + 20} y={node.tun.y + 27}>{shortName(tun.name, 18)}</text>
              <text className="wt-t-sub" x={node.tun.x + 20} y={node.tun.y + 47}>{shortName(tun.description, 24)}</text>
              <text className="wt-t-mono" x={node.tun.x + 20} y={node.tun.y + 77}>{ipText(tun)}</text>
              <text className="wt-t-note-fg" x={node.tun.x + 20} y={node.tun.y + 99}>{tun.gateway ? `网关 ${tun.gateway}` : "无默认网关"}</text>
              <text className={viaTun ? "wt-t-on" : "wt-t-off"} x={node.tun.x + 20} y={node.tun.y + 124}>
                {viaTun ? `● Up · metric ${tun.metric ?? 0} 生效` : `○ ${tun.status} · 未命中默认路由`}
              </text>
            </g>
          )}

          <g className={`wt-node ${vswitch ? "wt-node-hi" : ""}`}>
            <rect x={node.vswitch.x} y={node.vswitch.y} width={node.vswitch.w} height={node.vswitch.h} rx="10" />
            <text className="wt-t-title" x={node.vswitch.x + 20} y={node.vswitch.y + 27}>{vswitch ? shortName(vswitch.name, 16) : "vEthernet (WSL)"}</text>
            <text className="wt-t-sub" x={node.vswitch.x + 20} y={node.vswitch.y + 47}>Hyper-V 虚拟网卡</text>
            <text className="wt-t-mono" x={node.vswitch.x + 20} y={node.vswitch.y + 77}>{ipText(vswitch)}</text>
            <text className="wt-t-note-fg" x={node.vswitch.x + 20} y={node.vswitch.y + 99}>无默认网关</text>
            <text className="wt-t-note" x={node.vswitch.x + 20} y={node.vswitch.y + 124}>HNS 虚拟交换机</text>
          </g>

          {/* WSL 层节点 */}
          <rect className="wt-node-dash" x={node.distroBox.x} y={node.distroBox.y} width={node.distroBox.w} height={node.distroBox.h} rx="12" />
          <text className="wt-t-lbl" x={node.distroBox.x + 17} y={node.distroBox.y + 20}>发行版 / 进程</text>
          <text className="wt-t-note" x={node.distroBox.x + node.distroBox.w - 17} y={node.distroBox.y + 20} textAnchor="end">
            {sharedNetworkStack ? `${distributions.length} 个发行版共用同一网络栈` : "独立网络栈"}
          </text>
          {distros.length ? distros.map((item, index) => {
            const x = node.distroBox.x + 17 + index * 150;
            return (
              <g key={item.name} className={`wt-node ${item === distro ? "wt-node-hi" : ""}`}>
                <rect x={x} y={node.distroBox.y + 32} width="140" height="80" rx="9" />
                <text className="wt-t-title-sm" x={x + 12} y={node.distroBox.y + 56}>{shortName(item.name, 15)}</text>
                <text className="wt-t-mono-sm" x={x + 12} y={node.distroBox.y + 78}>{item.ipAddress ?? "未获取 IP"}</text>
                <text className="wt-t-note" x={x + 12} y={node.distroBox.y + 98}>网关 {shortName(item.gateway ?? "—", 14)}</text>
              </g>
            );
          }) : (
            <text className="wt-t-note" x={node.distroBox.x + 20} y={node.distroBox.y + 86}>没有运行中的发行版；启动后可在此查看 IP、网关与 DNS。</text>
          )}

          <g className="wt-node">
            <rect x={node.dns.x} y={node.dns.y} width={node.dns.w} height={node.dns.h} rx="9" />
            <text className="wt-t-title-sm" x={node.dns.x + 12} y={node.dns.y + 24}>DNS 解析</text>
            <text className="wt-t-mono-sm" x={node.dns.x + 12} y={node.dns.y + 44}>{dns[0] ?? "未检测到 DNS"}</text>
            <text className="wt-t-note" x={node.dns.x + 12} y={node.dns.y + 62}>{dns.length > 1 ? `备用 ${dns[1]}` : "WSL 解析器"}</text>
          </g>
          <g className="wt-node">
            <rect x={node.wslInfo.x} y={node.wslInfo.y} width={node.wslInfo.w} height={node.wslInfo.h} rx="9" />
            <text className="wt-t-title-sm" x={node.wslInfo.x + 12} y={node.wslInfo.y + 24}>WSL 运行时</text>
            <text className="wt-t-mono-sm" x={node.wslInfo.x + 12} y={node.wslInfo.y + 44}>{shortName(topology.wslVersion ?? "未获取", 18)}</text>
            <text className="wt-t-note" x={node.wslInfo.x + 12} y={node.wslInfo.y + 62}>内核 {shortName(topology.kernelVersion ?? "—", 16)}</text>
          </g>

          <g className="wt-node wt-node-hi">
            <rect x={node.wslGw.x} y={node.wslGw.y} width={node.wslGw.w} height={node.wslGw.h} rx="10" />
            <text className="wt-t-title" x={node.wslGw.x + 20} y={node.wslGw.y + 27}>WSL 里的网关</text>
            <text className="wt-t-sub" x={node.wslGw.x + 20} y={node.wslGw.y + 47}>eth0 · proto kernel onlink</text>
            <text className="wt-t-mono" x={node.wslGw.x + 20} y={node.wslGw.y + 76}>{distro?.ipAddress ?? "未获取"}</text>
            <text className="wt-t-mono wt-t-accent" x={node.wslGw.x + 20} y={node.wslGw.y + 100}>
              {distro?.gateway ? `default via ${distro.gateway}` : "未获取默认网关"}
            </text>
            <line className="wt-rule" x1={node.wslGw.x + 20} y1={node.wslGw.y + 116} x2={node.wslGw.x + node.wslGw.w - 20} y2={node.wslGw.y + 116} />
            <text className="wt-t-note-fg" x={node.wslGw.x + 20} y={node.wslGw.y + 138}>DNS {dns.slice(0, 2).join(" / ") || "未获取"}</text>
            <text className="wt-t-note" x={node.wslGw.x + 20} y={node.wslGw.y + 160}>出口由 Windows 侧路由表决定</text>
            <text className="wt-t-note" x={node.wslGw.x + 20} y={node.wslGw.y + 182}>
              {isSharedStackMode(topology.mode) ? "当前模式复用 Windows 网络接口" : "NAT 经 HNS 虚拟交换机转发"}
            </text>
          </g>

          <g className="wt-node">
            <rect x={node.hns.x} y={node.hns.y} width={node.hns.w} height={node.hns.h} rx="10" />
            <text className="wt-t-title" x={node.hns.x + 20} y={node.hns.y + 27}>HNS 虚拟交换机</text>
            <text className="wt-t-sub" x={node.hns.x + 20} y={node.hns.y + 47}>WSL (Hyper-V)</text>
            <text className="wt-t-note" x={node.hns.x + 20} y={node.hns.y + 67}>ICS / NAT · 同网段直连</text>
            <line className="wt-rule" x1={node.hns.x + 20} y1={node.hns.y + 84} x2={node.hns.x + node.hns.w - 20} y2={node.hns.y + 84} />
            <text className="wt-t-mono-sm" x={node.hns.x + 20} y={node.hns.y + 108}>Win  {vswitch?.ip ?? "—"}</text>
            <text className="wt-t-mono-sm" x={node.hns.x + 20} y={node.hns.y + 130}>WSL  {distro?.ipAddress ?? "—"}</text>
            <text className="wt-t-note" x={node.hns.x + 20} y={node.hns.y + 158}>连接 WSL 与 Windows</text>
            <text className="wt-t-note" x={node.hns.x + 20} y={node.hns.y + 180}>{sharedNetworkStack ? "共享网络栈" : "独立网络栈"}</text>
          </g>

          {/* 连线标注 */}
          <text className="wt-note-a" x="196" y="894">① WSL 路由查表 → {distro?.gateway ? `default via ${distro.gateway}` : "未获取默认网关"}</text>
          <text className="wt-note-a" x="920" y="740">② 交换机</text>
          <text className="wt-note-a" x="1078" y="628" textAnchor="end">③ vEthernet (WSL)</text>
          <text className="wt-note-a" x="424" y="438" textAnchor="end">路由表</text>
          {viaTun ? (
            <>
              <text className="wt-note-a" x="630" y="287">④ 命中 metric 0</text>
              <text className="wt-note-a" x="860" y="192">⑤ 隧道分流</text>
              <text className="wt-note-a" x="806" y="90">隧道出站</text>
              <text className="wt-t-sub" x="806" y="120">回程</text>
            </>
          ) : (
            <>
              <text className="wt-note-r" x="398" y="287">④ metric {physical?.metric ?? "—"}</text>
              <text className="wt-note-r" x="404" y="90">物理出口 · ISP 直连</text>
            </>
          )}
          <text className="wt-note-d" x="420" y="860">DNS 查询</text>
        </svg>
      </div>
    </div>
  );
}

export function WslNetworkTopologyDialog({ open, topology, isPreview, onClose }: Props) {
  const [focus, setFocus] = useState<Focus>("all");
  const [paused, setPaused] = useState(false);
  if (!open) return null;

  const captureTime = topology.capturedAt
    ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(topology.capturedAt))
    : "—";

  return (
    <SharedDialog
      title="WSL 网络拓扑"
      eyebrow={isPreview ? "本地调试预览" : "本机实测"}
      subtitle={isPreview ? "浏览器/H5 调试数据，仅用于预览交互，不代表真实本机巡检结果。" : `采集于 ${captureTime} · 当前 ${modeLabel(topology.mode)} 模式`}
      icon={<Network size={18} aria-hidden="true" />}
      onClose={onClose}
      className="wsl-topo-dialog"
      size="large"
    >
      <div className="wsl-topo-root">
        {isPreview && <p className="wsl-topo-preview" role="status">当前为本地调试数据：拓扑可交互，但网卡、IP、DNS 均为示例值。请在 Windows 桌面客户端查看本机实测拓扑。</p>}
        {!isPreview && topology.message && <p className="wsl-topo-notice" role="status">{topology.message}</p>}

        <div className="wsl-topo-toolbar">
          <div className="wsl-topo-chips" role="group" aria-label="路径聚焦">
            <button type="button" className={`wt-chip ${focus === "all" ? "is-active" : ""}`} aria-pressed={focus === "all"} onClick={() => setFocus("all")}>全部路径</button>
            <button type="button" className={`wt-chip ${focus === "main" ? "is-active" : ""}`} aria-pressed={focus === "main"} onClick={() => setFocus("main")}><span className="wt-swatch wt-swatch-a" />出网主路径</button>
            <button type="button" className={`wt-chip ${focus === "dns" ? "is-active" : ""}`} aria-pressed={focus === "dns"} onClick={() => setFocus("dns")}><span className="wt-swatch wt-swatch-w" />DNS 解析</button>
            <button type="button" className={`wt-chip ${focus === "direct" ? "is-active" : ""}`} aria-pressed={focus === "direct"} onClick={() => setFocus("direct")}><span className="wt-swatch wt-swatch-d" />直连旁路</button>
          </div>
          <button type="button" className="wt-chip" aria-pressed={paused} onClick={() => setPaused(value => !value)}>
            {paused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}{paused ? "继续动画" : "暂停动画"}
          </button>
        </div>

        <TopologyCanvas topology={topology} focus={focus} paused={paused} />

        <details className="wsl-topo-details">
          <summary><strong>采集明细</strong><small>展开查看网卡、路由、DNS 与发行版原始数据</small></summary>
          <div className="wsl-topo-details-body">
            <table className="wsl-topo-table">
              <caption>Windows 网卡</caption>
              <thead><tr><th scope="col">网卡</th><th scope="col">类型</th><th scope="col">IPv4</th><th scope="col">网关</th><th scope="col">metric</th><th scope="col">状态</th></tr></thead>
              <tbody>
                {topology.adapters.length ? topology.adapters.map((adapter, index) => (
                  <tr key={`${adapter.name}-${index}`}>
                    <th scope="row">{adapter.name}{adapter.active && <span className="wt-badge">生效</span>}</th>
                    <td>{adapter.kind}</td>
                    <td><code>{adapter.ip ? `${adapter.ip}/${adapter.prefix ?? ""}` : "—"}</code></td>
                    <td><code>{adapter.gateway ?? "—"}</code></td>
                    <td>{adapter.metric ?? "—"}</td>
                    <td>{adapter.status}</td>
                  </tr>
                )) : <tr><td colSpan={6}>未读取到网卡信息</td></tr>}
              </tbody>
            </table>
            <table className="wsl-topo-table">
              <caption>默认路由</caption>
              <thead><tr><th scope="col">目标</th><th scope="col">下一跳</th><th scope="col">接口</th><th scope="col">metric</th></tr></thead>
              <tbody>
                {topology.defaultRoutes.length ? topology.defaultRoutes.map((route, index) => (
                  <tr key={`${route.adapter}-${index}`}><th scope="row">0.0.0.0/0</th><td><code>{route.nextHop}</code></td><td>{route.adapter}</td><td>{route.metric}</td></tr>
                )) : <tr><td colSpan={4}>未检测到默认路由</td></tr>}
              </tbody>
            </table>
            <table className="wsl-topo-table">
              <caption>WSL 发行版</caption>
              <thead><tr><th scope="col">发行版</th><th scope="col">IP</th><th scope="col">网关</th><th scope="col">DNS</th></tr></thead>
              <tbody>
                {topology.distributions.length ? topology.distributions.map(item => (
                  <tr key={item.name}><th scope="row">{item.name}</th><td><code>{item.ipAddress ?? "—"}</code></td><td><code>{item.gateway ?? "—"}</code></td><td><code>{item.dns.join(" ") || "—"}</code></td></tr>
                )) : <tr><td colSpan={4}>没有运行中的发行版</td></tr>}
              </tbody>
            </table>
            <dl className="wsl-topo-facts">
              <dt>WSL 版本</dt><dd>{topology.wslVersion ?? "未获取"}</dd>
              <dt>内核版本</dt><dd>{topology.kernelVersion ?? "未获取"}</dd>
              <dt>网络模式</dt><dd>{modeLabel(topology.mode)}</dd>
              <dt>共享网络栈</dt><dd>{topology.sharedNetworkStack ? "是（多个发行版共用 IP）" : "否 / 未知"}</dd>
              <dt>代理 / 隧道网卡</dt><dd>{topology.proxyDetected ? (topology.proxyActive ? "已检测到并生效" : "已检测到，未命中默认路由") : "未检测到"}</dd>
              <dt>配置文件</dt><dd><code>{topology.configPath}</code></dd>
            </dl>
          </div>
        </details>
      </div>
    </SharedDialog>
  );
}
