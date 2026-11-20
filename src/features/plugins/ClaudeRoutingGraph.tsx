import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref as ReactRef } from "react";
import { ChevronDown, GripVertical, Settings2, Table2, Terminal } from "lucide-react";
import { useSortableDrag } from "../../shared/useSortableDrag";
import type { ClaudeActiveRequest, ClaudeMode, ClaudeProviderSummary, ClaudeRequestLog, ClaudeRoutingState } from "../../platform/clients/claudeProviders";
import { CLAUDE_MODEL_ROLES } from "./claudeModelRoles";
import { formatRoutingCount, formatRoutingLatency, formatRoutingTokens, ROUTING_USAGE_WINDOW_MS, summarizeRoutingUsage } from "./claudeRoutingUsage";
import { providerAccent } from "./claudeRoutingVisuals";

/**
 * 供应商页上方的路由拓扑。
 *
 * 布局与动效参考 yetone/magpie 的 routing view（MIT）：
 * 客户端 → 本地路由中枢 → 队列供应商，连线随进行中请求流动，中枢风车旋转，
 * 请求与响应以对应渠道颜色的小球沿连线移动。
 * 这里只使用本地路由快照与请求记录，不额外发起探测或写配置。
 */

const MAX_TARGETS = 4;
const MAX_RECENT_CLIENTS = 2;
const ROUTING_STAGE_LINGER_MS = 12_000;

type Rect = { left: number; top: number; width: number; height: number };
type Point = { x: number; y: number };
type TargetEntry = { provider: ClaudeProviderSummary; queueIndex: number };
type ClientEntry = { id: string; label: string; detail: string; model: string; timestamp: number; active: boolean; workingDirectory?: string; sessionTitle?: string };
type SourceContext = { workingDirectory?: string; sessionTitle?: string; timestamp: number };
type WireLayout = {
  width: number;
  height: number;
  sourceToHub: Record<string, string>;
  hubToSource: Record<string, string>;
  hubToTarget: Record<string, string>;
  targetToHub: Record<string, string>;
};
type TrafficParticle = { key: number; direction: "out" | "in"; path: string; duration: number; color: string };

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function relativeRect(element: Element, base: Rect): Rect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height };
}

/** 从卡片边缘出发的横向/纵向贝塞尔连线，避免线头压住文字。 */
function connect(from: Rect, to: Rect, pad = 3): string {
  if (to.left >= from.left + from.width - 1) {
    const start: Point = { x: from.left + from.width + pad, y: from.top + from.height / 2 };
    const end: Point = { x: to.left - pad, y: to.top + to.height / 2 };
    const bend = Math.max(18, (end.x - start.x) * 0.55);
    return `M ${round(start.x)} ${round(start.y)} C ${round(start.x + bend)} ${round(start.y)} ${round(end.x - bend)} ${round(end.y)} ${round(end.x)} ${round(end.y)}`;
  }
  const start: Point = { x: from.left + from.width / 2, y: from.top + from.height + pad };
  const end: Point = { x: to.left + to.width / 2, y: to.top - pad };
  const bend = Math.max(14, (end.y - start.y) * 0.55);
  return `M ${round(start.x)} ${round(start.y)} C ${round(start.x)} ${round(start.y + bend)} ${round(end.x)} ${round(end.y - bend)} ${round(end.x)} ${round(end.y)}`;
}

/** 反转拓扑中实际绘制的单段三次贝塞尔曲线，确保回程粒子沿原虚线精确返回。 */
function reverseWire(path: string): string {
  const points = path.match(/-?(?:\d+\.?\d*|\.\d+)/g)?.map(Number);
  if (!points) return path;
  if (points.length === 4) return `M ${round(points[2])} ${round(points[3])} L ${round(points[0])} ${round(points[1])}`;
  if (points.length !== 8) return path;
  const [startX, startY, control1X, control1Y, control2X, control2Y, endX, endY] = points;
  return `M ${round(endX)} ${round(endY)} C ${round(control2X)} ${round(control2Y)} ${round(control1X)} ${round(control1Y)} ${round(startX)} ${round(startY)}`;
}

/** 合并连续线段为一条 SVG 路径，让小球按整条路线的长度匀速滑动。 */
function joinWireSegments(paths: string[]): string {
  return paths.filter(Boolean).map((path, index) => index === 0
    ? path
    : path.replace(/^M\s*-?(?:\d+\.?\d*|\.\d+)\s+-?(?:\d+\.?\d*|\.\d+)\s*/, "")).join(" ");
}

/** 把左右两段线拆成 CloudHub 中心前后的桥接段，便于请求和重试在中心交接。 */
function bridgeThroughHub(sourceWire: string, targetWire: string): [string, string] {
  const sourcePoints = sourceWire.match(/-?(?:\d+\.?\d*|\.\d+)/g)?.map(Number);
  const targetPoints = targetWire.match(/-?(?:\d+\.?\d*|\.\d+)/g)?.map(Number);
  if (!sourcePoints || sourcePoints.length !== 8 || !targetPoints || targetPoints.length !== 8) return ["", ""];
  const startX = sourcePoints[6], startY = sourcePoints[7];
  const endX = targetPoints[0], endY = targetPoints[1];
  const centerX = (startX + endX) / 2, centerY = (startY + endY) / 2;
  return [
    `M ${round(startX)} ${round(startY)} L ${round(centerX)} ${round(centerY)}`,
    `M ${round(centerX)} ${round(centerY)} L ${round(endX)} ${round(endY)}`,
  ];
}

function samePaths(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

function sameLayout(current: WireLayout | null, next: WireLayout): boolean {
  if (!current || current.width !== next.width || current.height !== next.height) return false;
  return samePaths(current.sourceToHub, next.sourceToHub)
    && samePaths(current.hubToSource, next.hubToSource)
    && samePaths(current.hubToTarget, next.hubToTarget)
    && samePaths(current.targetToHub, next.targetToHub);
}

function providerModel(provider: ClaudeProviderSummary): { role: string; model: string } {
  for (const role of CLAUDE_MODEL_ROLES) {
    const model = provider.models?.[role.key]?.model?.trim();
    if (model) return { role: role.label, model };
  }
  return {
    role: "Sonnet",
    model: provider.modelCatalog?.[0]?.model?.trim() || provider.fallbackModel?.model?.trim() || "",
  };
}

/** 风车塔架保持静止，叶轮由请求 RPM 驱动的动画循环控制转速。 */
function WindmillMark({ rotorRef }: { rotorRef?: ReactRef<SVGGElement> }) {
  const blade = "M0 0C-1.6-4.4-4-8.4-7.8-13.8C-12.2-11.4-14.2-7-12.2-2.8C-9.2-1-4.5-.1 0 0Z";
  return <g className="claude-route-graph-windmill-mark">
    <path className="claude-route-graph-windmill-tower" d="M-4.6 6.5L-8.4 19.6H8.4L4.6 6.5Z" />
    <g className="claude-route-graph-windmill-rotor" ref={rotorRef}>
      <g className="claude-route-graph-windmill-blades">
        <path d={blade} />
        <path d={blade} transform="rotate(90)" />
        <path d={blade} transform="rotate(180)" />
        <path d={blade} transform="rotate(270)" />
      </g>
      <circle className="claude-route-graph-windmill-hub" cx="0" cy="0" r="2.5" />
      <circle className="claude-route-graph-windmill-hub-dot" cx="0" cy="0" r="1" />
    </g>
  </g>;
}

export function ClaudeRoutingGraph({ view, state, providers, onLocate, onOpenMapping, onOpenSettings, onReorderQueue, actionsDisabled = false }: {
  view: Exclude<ClaudeMode, "direct">;
  state: ClaudeRoutingState;
  providers: ClaudeProviderSummary[];
  onLocate?: (id: string) => void;
  onOpenMapping?: () => void;
  onOpenSettings?: () => void;
  onReorderQueue?: (queue: string[]) => void;
  actionsDisabled?: boolean;
}) {
  const config = state.config;
  const providerById = useMemo(() => new Map(providers.map(provider => [provider.id, provider])), [providers]);
  const [open, setOpen] = useState(true);
  const [lingerNow, setLingerNow] = useState(() => Date.now());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<WireLayout | null>(null);
  const [particles, setParticles] = useState<TrafficParticle[]>([]);
  const particleKey = useRef(0);
  const particleTimers = useRef<number[]>([]);
  const sourceContexts = useRef(new Map<string, SourceContext>());
  const seenLogIds = useRef<Set<string>>(new Set());
  const sawLogSnapshot = useRef(false);
  const seenLogView = useRef(view);
  /** 光点检测与请求快照各自维护；布局未就绪时先排队。 */
  const seenParticleKeys = useRef<Set<string>>(new Set());
  const sawParticleSnapshot = useRef(false);
  const pendingOutParticles = useRef<ClaudeActiveRequest[]>([]);
  const rotorRef = useRef<SVGGElement | null>(null);
  const windmillTargetRef = useRef(0);

  /** 只有当前查看的模式确实在运行时才播放动画，避免把静态队列描述成实时转发。 */
  const live = state.running && state.mode === view;
  const queueEnabled = config.failover || config.roundRobin;
  const strategyLabel = config.roundRobin ? "轮询" : config.failover ? "优先级故障转移" : "固定路由";
  /** 队列顺序参与请求选择时，才显示拖拽手柄并允许排序。 */
  const sortable = view === "route" && queueEnabled && Boolean(onReorderQueue);
  const canReorder = sortable && !actionsDisabled;
  /** 与账号管理一致：指针拖拽 + 独立手柄，拖动过程用 transform 预览，松手后一次性提交。 */
  const { startDrag: startTargetDrag } = useSortableDrag({
    selector: "[data-claude-route-sort-id]",
    attribute: "data-claude-route-sort-id",
    enabled: canReorder,
    onMove: (source, target) => {
      const queue = [...config.queue];
      const from = queue.indexOf(source), to = queue.indexOf(target);
      if (from < 0 || to < 0 || from === to) return;
      queue.splice(from, 1);
      queue.splice(to, 0, source);
      if (queue.every((value, index) => value === config.queue[index])) return;
      onReorderQueue?.(queue);
    },
  });

  const targetIds = useMemo(() => {
    if (view === "aggregate") {
      return [config.defaultProvider, ...config.members]
        .filter((id, index, list) => Boolean(id) && list.indexOf(id) === index)
        .filter(id => providerById.has(id));
    }
    if (!queueEnabled) {
      const fixed = config.routeProvider && providerById.has(config.routeProvider) ? [config.routeProvider] : [];
      const queue = config.queue.filter(id => providerById.has(id));
      return [...fixed, ...queue.filter(id => !fixed.includes(id))];
    }
    const queue = config.queue.filter(id => providerById.has(id));
    return queue.length ? queue : (config.routeProvider && providerById.has(config.routeProvider) ? [config.routeProvider] : []);
  }, [config.defaultProvider, config.members, config.queue, config.routeProvider, providerById, queueEnabled, view]);

  /** 当前模式的进行中请求：驱动「回答中」状态、连线流动与风车旋转。 */
  const activeRequests = useMemo(
    () => live ? (state.activeRequests ?? []).filter(request => (request.mode ?? view) === view) : [],
    [live, state.activeRequests, view],
  );
  useEffect(() => {
    const activeIds = new Set(activeRequests.map(request => request.id));
    for (const request of activeRequests) {
      if (request.workingDirectory || request.sessionTitle) sourceContexts.current.set(request.id, {
        workingDirectory: request.workingDirectory ?? undefined,
        sessionTitle: request.sessionTitle ?? undefined,
        timestamp: request.timestamp,
      });
    }
    for (const log of state.logs) {
      if ((log.mode ?? view) !== view) continue;
      const id = log.requestId?.trim();
      const context = id ? sourceContexts.current.get(id) : undefined;
      if (context && log.timestamp > context.timestamp) context.timestamp = log.timestamp;
    }
    for (const [id, context] of sourceContexts.current) {
      if (!activeIds.has(id) && context.timestamp + ROUTING_STAGE_LINGER_MS <= lingerNow) sourceContexts.current.delete(id);
    }
  }, [activeRequests, lingerNow, state.logs, view]);
  const activeByProvider = useMemo(() => {
    const map = new Map<string, ClaudeActiveRequest[]>();
    for (const request of activeRequests) {
      const entries = map.get(request.providerId);
      if (entries) entries.push(request); else map.set(request.providerId, [request]);
    }
    return map;
  }, [activeRequests]);
  const newestActive = useMemo(
    () => activeRequests.reduce<ClaudeActiveRequest | null>((newest, request) => !newest || request.timestamp > newest.timestamp ? request : newest, null),
    [activeRequests],
  );
  const recentProviderLog = useMemo(() => {
    if (!live) return null;
    return state.logs.reduce<ClaudeRequestLog | null>((latest, log) =>
      (log.mode ?? view) === view && log.timestamp <= lingerNow && log.timestamp + ROUTING_STAGE_LINGER_MS > lingerNow
        && (!latest || log.timestamp > latest.timestamp) ? log : latest, null);
  }, [lingerNow, live, state.logs, view]);
  const lingeringProviderIds = useMemo(() => new Set(live
    ? state.logs
      .filter(log => (log.mode ?? view) === view && log.timestamp <= lingerNow && log.timestamp + ROUTING_STAGE_LINGER_MS > lingerNow)
      .map(log => log.providerId)
    : []), [lingerNow, live, state.logs, view]);

  useEffect(() => {
    setLingerNow(Date.now());
  }, [live, state.logs, view]);

  useEffect(() => {
    if (!live) return;
    const nextExpiry = state.logs.reduce<number | null>((next, log) => {
      if ((log.mode ?? view) !== view) return next;
      const expiresAt = log.timestamp + ROUTING_STAGE_LINGER_MS;
      if (expiresAt <= lingerNow) return next;
      return next === null || expiresAt < next ? expiresAt : next;
    }, null);
    if (nextExpiry === null) return;
    const windowRef = stageRef.current?.ownerDocument.defaultView ?? window;
    const timer = windowRef.setTimeout(() => setLingerNow(Date.now()), Math.max(0, nextExpiry - Date.now() + 1));
    return () => windowRef.clearTimeout(timer);
  }, [lingerNow, live, state.logs, view]);
  /** 网关按请求追踪并发；所有进行中请求都要显示，空位再由最近完成的请求短暂占用。 */
  const clientNodes = useMemo<ClientEntry[]>(() => {
    const activeIds = new Set(activeRequests.map(request => request.id));
    const active = [...activeRequests]
      .sort((left, right) => left.timestamp - right.timestamp)
      .map((request, index) => ({
        id: request.id,
        label: "Claude Code",
        detail: index === 0 ? "客户端请求" : `并发请求 ${index + 1}`,
        model: request.model,
        timestamp: request.timestamp,
        active: true,
        workingDirectory: request.workingDirectory ?? undefined,
        sessionTitle: request.sessionTitle ?? undefined,
      }));
    const recentByRequest = new Map<string, ClaudeRequestLog>();
    if (live) for (const log of state.logs) {
      if ((log.mode ?? view) !== view || log.timestamp > lingerNow || log.timestamp + ROUTING_STAGE_LINGER_MS <= lingerNow) continue;
      const id = log.requestId?.trim() || `log:${log.id}`;
      if (activeIds.has(id)) continue;
      const previous = recentByRequest.get(id);
      if (!previous || log.timestamp > previous.timestamp) recentByRequest.set(id, log);
    }
    const recent = [...recentByRequest.entries()]
      .map(([id, log]) => ({
        id,
        label: "Claude Code",
        detail: log.status >= 400 ? "最近失败" : "刚完成",
        model: log.model,
        timestamp: log.timestamp,
        active: false,
        workingDirectory: sourceContexts.current.get(id)?.workingDirectory,
        sessionTitle: sourceContexts.current.get(id)?.sessionTitle,
      }))
      .sort((left, right) => left.timestamp - right.timestamp);
    const visibleActive = active;
    const recentSlots = Math.max(0, MAX_RECENT_CLIENTS - visibleActive.length);
    const visibleRecent = recentSlots ? recent.slice(-recentSlots) : [];
    const nodes = [...visibleRecent, ...visibleActive].sort((left, right) => left.timestamp - right.timestamp);
    if (!nodes.length) return [{ id: "idle", label: "Claude Code", detail: live ? "等待请求" : "客户端请求", model: "", timestamp: 0, active: false }];
    return nodes;
  }, [activeRequests, lingerNow, live, state.logs, view]);
  const clientKey = clientNodes.map(client => client.id).join("|");
  /** 近 20 秒的请求量换算成每分钟 RPM；没有请求也没有进行中请求时目标转速为 0。 */
  const windmillRpm = useMemo(() => {
    if (!live) return 0;
    const since = Date.now() - 20_000;
    const recent = state.logs.filter(log => (log.mode ?? view) === view && log.timestamp >= since).length;
    return (recent + activeRequests.length * 2) * 3;
  }, [activeRequests.length, live, state.logs, view]);
  const windmillTarget = windmillRpm > 0 ? Math.min(240, 24 + windmillRpm * 7) : 0;

  const activeCandidate = view === "aggregate"
    ? (newestActive && targetIds.includes(newestActive.providerId)
        ? newestActive.providerId
        : recentProviderLog && targetIds.includes(recentProviderLog.providerId) ? recentProviderLog.providerId : "")
    : live ? (newestActive && targetIds.includes(newestActive.providerId)
      ? newestActive.providerId
      : queueEnabled ? (recentProviderLog && targetIds.includes(recentProviderLog.providerId) ? recentProviderLog.providerId : "") : config.routeProvider) : "";
  const activeId = live && targetIds.includes(activeCandidate) ? activeCandidate : "";

  const allTargets = useMemo<TargetEntry[]>(() => targetIds.map(id => ({
    provider: providerById.get(id)!,
    queueIndex: config.queue.indexOf(id),
  })), [config.queue, providerById, targetIds]);

  /** 限制高度：优先保证当前响应的供应商在可见范围内。 */
  const targets = useMemo(() => {
    const visible = allTargets.slice(0, MAX_TARGETS);
    if (activeId && !visible.some(entry => entry.provider.id === activeId)) {
      const active = allTargets.find(entry => entry.provider.id === activeId);
      if (active) visible.splice(Math.max(0, MAX_TARGETS - 1), 1, active);
    }
    return visible;
  }, [activeId, allTargets]);
  const hiddenCount = allTargets.length - targets.length;
  const visibleKey = targets.map(entry => entry.provider.id).join("|");

  /** 只看当前模式的请求记录，避免聚合流量把路由页的供应商标成“正常”。 */
  const lastResponse = (providerId: string) => state.logs.find(log => log.providerId === providerId && (log.mode ?? view) === view);
  /** 近 5 小时本地请求尝试：中枢与各渠道卡片共用同一份统计口径。 */
  const usage = useMemo(
    () => summarizeRoutingUsage(state.logs, view, Date.now() - ROUTING_USAGE_WINDOW_MS),
    [state.logs, view],
  );
  const hubUsageTitle = `近 5 小时：请求 ${formatRoutingCount(usage.total.requests)}（按客户端请求去重），改道 ${formatRoutingCount(usage.total.reroutedRequests)}（经历多次供应商尝试的请求），Agent 收到的错误 ${formatRoutingCount(usage.total.deliveredErrors)}（最终仍失败的请求），Token ${formatRoutingCount(usage.total.tokens)}（输入 + 输出 + 缓存读取）`;

  const summary = (() => {
    const traffic = activeRequests.length ? `${activeRequests.length} 个请求转发中 · ` : "";
    if (view === "aggregate") {
      const defaultName = providerById.get(config.defaultProvider)?.name;
      if (live) return `${traffic}默认供应商${defaultName ? ` ${defaultName}` : ""} 承接普通请求，聚合成员按模型分发。`;
      if (state.running) return "Claude Code 当前使用其他连接模式，聚合拓扑仅展示配置。";
      return "聚合未启动，以下为默认供应商与已添加成员。";
    }
    const fixedName = providerById.get(config.routeProvider)?.name;
    if (live) return config.roundRobin
      ? `${traffic}新请求按 P1、P2… 轮流分配，单次失败时尝试下一位；强调线为当前响应路径。`
      : config.failover
        ? `${traffic}P1 优先，失败时按队列尝试下一位；强调线为当前或最近响应路径。`
        : `${traffic}请求仅发往固定供应商${fixedName ? ` ${fixedName}` : ""}，不会切换到队列；队列顺序仍保留。`;
    if (state.running) return "Claude Code 当前使用其他连接模式，路由队列仅展示配置。";
    return "本地路由未启动，以下为已保存的队列与策略。";
  })();

  // 根据实际 DOM 位置生成连线；卡片尺寸、字体和窗口变化后重新测量。
  useLayoutEffect(() => {
    if (!open) { setLayout(null); return; }
    const stage = stageRef.current;
    if (!stage) return;
    const viewWindow = stage.ownerDocument.defaultView;
    let frame = 0;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const box = stage.getBoundingClientRect();
        const hub = stage.querySelector<HTMLElement>('[data-claude-route-node="hub"]');
        if (!hub || box.width < 1 || box.height < 1) return;
        const base: Rect = { left: box.left, top: box.top, width: box.width, height: box.height };
        const hubRect = relativeRect(hub, base);
        const sourceToHub: Record<string, string> = {};
        const hubToSource: Record<string, string> = {};
        stage.querySelectorAll<HTMLElement>("[data-claude-route-source]").forEach(element => {
          const id = element.dataset.claudeRouteSource;
          if (!id) return;
          const sourceRect = relativeRect(element, base);
          sourceToHub[id] = connect(sourceRect, hubRect);
          hubToSource[id] = connect(hubRect, sourceRect);
        });
        if (!Object.keys(sourceToHub).length) return;
        const hubToTarget: Record<string, string> = {};
        const targetToHub: Record<string, string> = {};
        stage.querySelectorAll<HTMLElement>("[data-claude-route-target]").forEach(element => {
          const id = element.dataset.claudeRouteTarget;
          if (!id) return;
          const targetRect = relativeRect(element, base);
          hubToTarget[id] = connect(hubRect, targetRect);
          targetToHub[id] = connect(targetRect, hubRect);
        });
        const next: WireLayout = {
          width: box.width,
          height: box.height,
          sourceToHub,
          hubToSource,
          hubToTarget,
          targetToHub,
        };
        setLayout(current => sameLayout(current, next) ? current : next);
      });
    };
    measure();
    const Resize = viewWindow?.ResizeObserver ?? ResizeObserver;
    const observer = new Resize(measure);
    observer.observe(stage);
    void stage.ownerDocument.fonts?.ready.then(measure).catch(() => {});
    viewWindow?.addEventListener("resize", measure);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewWindow?.removeEventListener("resize", measure);
    };
  }, [clientKey, open, visibleKey]);

  /** 在连线上投放对应渠道颜色的小球。 */
  function spawnParticle(direction: TrafficParticle["direction"], providerId: string, ...paths: string[]) {
    const key = ++particleKey.current;
    const windowRef = stageRef.current?.ownerDocument.defaultView ?? window;
    const provider = providerById.get(providerId);
    const color = provider ? providerAccent(provider.name).color : "var(--jb-accent-strong, var(--jb-accent, #ea580c))";
    const segments = paths.filter(Boolean);
    const duration = Math.max(1.8, segments.length * 0.8);
    setParticles(current => [...current.slice(-11), { key, direction, path: joinWireSegments(segments), duration, color }]);
    const timer = windowRef.setTimeout(() => {
      setParticles(current => current.filter(particle => particle.key !== key));
      particleTimers.current = particleTimers.current.filter(id => id !== timer);
    }, duration * 1000 + 100);
    particleTimers.current = [...particleTimers.current, timer];
  }

  // 请求开始：沿「客户端 → 中枢 → 渠道」放一个向右移动的光点。
  useEffect(() => {
    const keyOf = (request: ClaudeActiveRequest) => `${request.id}:${request.providerId}:${request.attempt}`;
    const keys = new Set(activeRequests.map(keyOf));
    const previous = seenParticleKeys.current;
    seenParticleKeys.current = keys;
    if (!sawParticleSnapshot.current) { sawParticleSnapshot.current = true; return; }
    if (!live) { pendingOutParticles.current = []; return; }
    const fresh = activeRequests.filter(request => !previous.has(keyOf(request)));
    if (fresh.length) {
      pendingOutParticles.current = [...pendingOutParticles.current, ...fresh].slice(-8);
    }
    if (!layout) return;
    const queued = pendingOutParticles.current;
    pendingOutParticles.current = [];
    for (const request of queued) {
      const sourceWire = layout.sourceToHub[request.id] ?? Object.values(layout.sourceToHub)[0];
      const targetWire = layout.hubToTarget[request.providerId];
      if (!sourceWire || !targetWire) continue;
      if (Date.now() - request.timestamp > 30_000) continue;
      // 首次请求从客户端进入；故障切换后的重试已在中枢，直接沿右侧虚线发往新渠道。
      const [centerLeft, centerRight] = bridgeThroughHub(sourceWire, targetWire);
      spawnParticle("out", request.providerId, ...(request.attempt > 1 ? [centerRight, targetWire] : [sourceWire, centerLeft, centerRight, targetWire]));
    }
  }, [activeRequests, layout, live]);

  // 请求完成：沿「渠道 → 中枢 → 客户端」放一个向左回来的光点。
  useEffect(() => {
    if (seenLogView.current !== view) {
      seenLogView.current = view;
      seenLogIds.current = new Set();
      sawLogSnapshot.current = false;
    }
    const ids = new Set(state.logs.map(log => log.id));
    const previous = seenLogIds.current;
    seenLogIds.current = ids;
    if (!sawLogSnapshot.current) { sawLogSnapshot.current = true; return; }
    if (!live || !layout) return;
    const finished = state.logs
      .filter(log => !previous.has(log.id) && (log.mode ?? view) === view)
      .sort((left, right) => right.timestamp - left.timestamp);
    for (const log of finished.slice(0, 3)) {
      const targetWire = layout.hubToTarget[log.providerId];
      if (!targetWire) continue;
      const attempt = log.attempt ?? 1;
      const retryable = [401, 403, 408, 429].includes(log.status) || log.status >= 500;
      const requestStillActive = activeRequests.some(request => request.id === log.requestId);
      const returnsToHubOnly = view === "route"
        && (config.failover || config.roundRobin)
        && retryable
        && requestStillActive
        && attempt < config.retries + 1
        && attempt < targetIds.length;
      // 中间失败只退回中枢；最终响应才继续沿左侧虚线回到客户端。
      const sourceId = log.requestId ?? activeRequests[0]?.id ?? "idle";
      const sourceWire = layout.sourceToHub[sourceId] ?? Object.values(layout.sourceToHub)[0];
      if (!returnsToHubOnly && !sourceWire) continue;
      if (Date.now() - log.timestamp > 30_000) continue;
      const [centerLeft, centerRight] = sourceWire ? bridgeThroughHub(sourceWire, targetWire) : ["", ""];
      spawnParticle("in", log.providerId, reverseWire(targetWire), reverseWire(centerRight), ...(returnsToHubOnly || !sourceWire ? [] : [reverseWire(centerLeft), reverseWire(sourceWire)]));
    }
  }, [activeRequests, config.failover, config.retries, config.roundRobin, layout, live, state.logs, targetIds.length, view]);

  useEffect(() => () => {
    const windowRef = stageRef.current?.ownerDocument.defaultView ?? window;
    particleTimers.current.forEach(id => windowRef.clearTimeout(id));
    particleTimers.current = [];
  }, []);

  useEffect(() => {
    windmillTargetRef.current = windmillTarget;
  }, [windmillTarget]);

  // 风车转速：请求 RPM 越高转得越快；没有请求时平滑减速到停止。
  // 直接用 rAF 累加角度而不是切换 CSS 动画时长，避免每次速率变化时转子跳位。
  useEffect(() => {
    const viewWindow = stageRef.current?.ownerDocument.defaultView ?? window;
    if (viewWindow.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let last: number | null = null;
    let speed = 0;
    let angle = 0;
    const tick = (now: number) => {
      if (last === null) last = now;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const target = windmillTargetRef.current;
      const response = target > speed ? 0.9 : 1.8;
      speed += (target - speed) * Math.min(1, dt / response);
      if (target === 0 && speed < 0.2) speed = 0;
      if (speed > 0) {
        angle = (angle + speed * dt) % 360;
        if (rotorRef.current) rotorRef.current.style.transform = `rotate(${angle}deg)`;
      }
      frame = viewWindow.requestAnimationFrame(tick);
    };
    frame = viewWindow.requestAnimationFrame(tick);
    return () => viewWindow.cancelAnimationFrame(frame);
  }, []);

  return <section className="claude-route-graph" aria-label="路由拓扑">
    <header className="claude-route-graph-head">
      <div>
        <strong>路由拓扑</strong>
        <span className={`claude-route-graph-badge${live ? " is-live" : ""}`}><i aria-hidden="true" />{live ? "实时" : state.running ? "仅预览" : "未启动"}</span>
        <span className="claude-route-graph-summary" title={summary}>{summary}</span>
      </div>
      {onOpenMapping && <button type="button" className="claude-route-graph-action" onClick={onOpenMapping} title="编辑角色 × 渠道模型映射"><Table2 size={12} aria-hidden="true" />模型映射</button>}
      <button type="button" className="claude-route-graph-toggle" aria-expanded={open} aria-controls="claude-route-graph-body" title={open ? "收起路由拓扑" : "展开路由拓扑"} aria-label={open ? "收起路由拓扑" : "展开路由拓扑"} onClick={() => setOpen(current => !current)}><ChevronDown size={14} aria-hidden="true" /></button>
    </header>
    {open && <div id="claude-route-graph-body" className="claude-route-graph-body">
      <div ref={stageRef} className="claude-route-graph-stage">
        {layout && <svg className="claude-route-graph-wires" width={Math.ceil(layout.width)} height={Math.ceil(layout.height)} aria-hidden="true">
          {Object.entries(layout.sourceToHub).map(([id, path]) => {
            const active = activeRequests.some(request => request.id === id);
            const lingering = clientNodes.some(client => client.id === id && !client.active && client.id !== "idle");
            const flowing = live && (active || lingering);
            return <path key={id} className={`claude-route-graph-wire${flowing ? " is-current is-flow" : ""}${active ? " is-traffic" : ""}`} d={path} />;
          })}
          {targets.map(({ provider }) => {
            const health = state.health[provider.id];
            const open_ = Boolean(health?.openUntil && health.openUntil > Date.now());
            const last = lastResponse(provider.id);
            const failed = open_ || Boolean(last && last.status >= 400);
            const busy = (activeByProvider.get(provider.id)?.length ?? 0) > 0;
            const classes = ["claude-route-graph-wire"];
            if (busy) classes.push("is-current", "is-flow", "is-traffic");
            else if (provider.id === activeId || lingeringProviderIds.has(provider.id)) classes.push("is-current", "is-flow");
            else if (failed) classes.push("is-error");
            return <path key={provider.id} data-claude-route-wire={provider.id} className={classes.join(" ")} d={layout.hubToTarget[provider.id] ?? ""} />;
          })}
        </svg>}
        <div className={`claude-route-graph-sources${clientNodes.length > 1 ? " is-multiple" : ""}`} role="group" aria-label={activeRequests.length > 1 ? `${activeRequests.length} 个并发 Claude Code 请求` : activeRequests.length === 1 ? "Claude Code 客户端请求" : clientNodes[0]?.id !== "idle" ? "最近的 Claude Code 请求" : "Claude Code 客户端"}>
          {clientNodes.map(client => {
            const directoryName = client.workingDirectory?.split(/[\\/]/).filter(Boolean).slice(-1)[0];
            const contextLabel = client.sessionTitle || directoryName;
            const description = [contextLabel, client.detail].filter(Boolean).join(" · ");
            const title = [client.sessionTitle, client.workingDirectory, client.model && `请求模型 ${client.model}`].filter(Boolean).join(" · ") || undefined;
            return <div key={client.id} className={`claude-route-graph-node claude-route-graph-source${!client.active && client.id !== "idle" ? " is-lingering" : ""}`} data-claude-route-node="source" data-claude-route-source={client.id} aria-label={description || client.label} title={title}>
            <span className="claude-route-graph-source-icon"><Terminal size={17} aria-hidden="true" /></span>
            <strong>{client.label}</strong>
            <small>{description}</small>
          </div>;})}
        </div>
        <div className={`claude-route-graph-node claude-route-graph-hub${live ? " is-live" : ""}`} data-claude-route-node="hub">
          <div className="claude-route-graph-clouds" role="group" aria-label={hubUsageTitle} title={hubUsageTitle}>
            <span className="claude-route-graph-cloud"><strong>{formatRoutingCount(usage.total.requests)}</strong><small>请求</small></span>
            <span className="claude-route-graph-cloud"><strong>{formatRoutingCount(usage.total.reroutedRequests)}</strong><small>改道</small></span>
            <span className={`claude-route-graph-cloud${usage.total.deliveredErrors ? " is-error" : ""}`}><strong>{formatRoutingCount(usage.total.deliveredErrors)}</strong><small>Agent 错误</small></span>
            <span className="claude-route-graph-cloud"><strong>{formatRoutingTokens(usage.total.tokens)}</strong><small>Token</small></span>
          </div>
          {onOpenSettings && <button type="button" className="claude-route-graph-hub-settings" title="路由拓扑设置" aria-label="路由拓扑设置" disabled={actionsDisabled} onClick={onOpenSettings}><Settings2 size={12} aria-hidden="true" /></button>}
          {onOpenSettings
            ? <button type="button" className="claude-route-graph-hub-icon" title="打开路由设置" aria-label="打开路由设置" disabled={actionsDisabled} onClick={onOpenSettings}><svg className={`claude-route-graph-windmill${live ? " is-live" : ""}`} viewBox="-18 -18 36 38" aria-hidden="true"><WindmillMark rotorRef={rotorRef} /></svg></button>
            : <svg className={`claude-route-graph-windmill${live ? " is-live" : ""}`} viewBox="-18 -18 36 38" aria-hidden="true"><WindmillMark rotorRef={rotorRef} /></svg>}
          <strong>CloudHub</strong>
          <small className="claude-route-graph-address" title={state.address ?? undefined}>{state.running && state.address ? state.address.replace(/^https?:\/\//, "") : `127.0.0.1:${config.port}`}</small>
          <span className="claude-route-graph-mode">{view === "aggregate" ? (live ? "聚合中" : "聚合配置") : strategyLabel}</span>
        </div>
        <ul className="claude-route-graph-targets" aria-label={view === "aggregate" ? "聚合供应商" : "路由队列"}>
          {targets.map(({ provider, queueIndex }) => {
            const health = state.health[provider.id];
            const open_ = Boolean(health?.openUntil && health.openUntil > Date.now());
            const last = lastResponse(provider.id);
            const failed = open_ || Boolean(last && last.status >= 400);
            const isActive = provider.id === activeId;
            const isDefault = view === "aggregate" && provider.id === config.defaultProvider;
            const activeForProvider = activeByProvider.get(provider.id) ?? [];
            const busy = activeForProvider.length > 0;
            const latestActive = activeForProvider.reduce<ClaudeActiveRequest | null>((latest, request) => !latest || request.timestamp > latest.timestamp ? request : latest, null);
            const status = busy
              ? activeForProvider.length > 1 ? `回答中 ×${activeForProvider.length}` : "回答中"
              : isActive
                ? view === "aggregate" ? "最近响应" : queueEnabled ? "最近响应" : "路由中"
                : failed ? open_ ? "熔断中" : "请求失败"
                : view === "route" && !queueEnabled ? "队列保留"
                : last ? "正常" : live ? "待请求" : "未检测";
            const accent = providerAccent(provider.name);
            const modelInfo = providerModel(provider);
            const modelText = latestActive
              ? `实际 · ${latestActive.actualModel}`
              : isActive && last
                ? `实际 · ${last.actualModel}`
                : `${modelInfo.role} · ${modelInfo.model || "未配置模型"}`;
            const missingSonnet = view === "route" && !provider.models?.sonnet?.model?.trim();
            const providerUsage = usage.byProvider.get(provider.id);
            const providerUsageTitle = providerUsage
              ? `近 5 小时已完成请求尝试：请求 ${formatRoutingCount(providerUsage.requests)}，错误 ${formatRoutingCount(providerUsage.errors)}，成功率 ${providerUsage.requests ? Math.round(((providerUsage.requests - providerUsage.errors) / providerUsage.requests) * 100) : 100}%，平均延迟 ${formatRoutingLatency(providerUsage.durationMs / providerUsage.requests)}（请求总耗时，含失败尝试与流式生成），Token ${formatRoutingCount(providerUsage.tokens)}（输入 + 输出 + 缓存读取）`
              : "近 5 小时本地没有该渠道的已完成请求记录";
            return <li key={provider.id} data-claude-route-sort-id={provider.id}>
              <div className={`claude-route-graph-target${sortable ? " is-sortable" : ""}${isActive ? " is-current" : ""}${busy ? " is-live" : ""}`} data-claude-route-target={provider.id}>
                {sortable && <button
                  type="button"
                  className="claude-route-graph-grip"
                  title="拖动排序，也可用上下方向键调整"
                  aria-label={`拖动调整 ${provider.name} 的队列顺序`}
                  disabled={actionsDisabled}
                  onPointerDown={event => startTargetDrag(event, provider.id)}
                  onKeyDown={event => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault();
                    const queue = [...config.queue];
                    const index = queue.indexOf(provider.id);
                    const next = index + (event.key === "ArrowUp" ? -1 : 1);
                    if (index < 0 || next < 0 || next >= queue.length) return;
                    [queue[index], queue[next]] = [queue[next], queue[index]];
                    onReorderQueue?.(queue);
                  }}
                ><GripVertical size={14} aria-hidden="true" /></button>}
                <button
                  type="button"
                  className="claude-route-graph-target-main"
                  aria-label={`${provider.name}，${status}${onLocate ? "，定位到供应商列表" : ""}`}
                  title={onLocate ? "定位到供应商列表" : undefined}
                  onClick={() => onLocate?.(provider.id)}
                >
                  <span className={`claude-route-graph-dot${busy ? " is-live" : isActive ? " is-current" : failed ? " is-error" : ""}`} aria-hidden="true" />
                  <span className="claude-route-graph-logo" style={{ background: accent.color }} aria-hidden="true">{accent.letter}</span>
                  <span className="claude-route-graph-main"><strong>{provider.name}</strong><small>{modelText}</small><small className="claude-route-graph-usage" title={providerUsageTitle}>
                    {providerUsage ? <>5h · 请求 {formatRoutingCount(providerUsage.requests)} · <span className={providerUsage.errors ? "is-error" : ""}>错误 {formatRoutingCount(providerUsage.errors)}</span> · {formatRoutingTokens(providerUsage.tokens)} tok</> : "5h · 暂无记录"}
                  </small></span>
                  <span className="claude-route-graph-meta">
                    {providerUsage && <span className="claude-route-graph-latency" title="近 5 小时平均请求总耗时（含失败尝试与流式生成）">平均 {formatRoutingLatency(providerUsage.durationMs / providerUsage.requests)}</span>}
                    {isDefault && <span className="claude-route-graph-tag is-default">默认</span>}
                    {view === "route" && queueIndex >= 0 && (queueEnabled || provider.id !== config.routeProvider) && <span className="claude-route-graph-tag">{queueEnabled ? `P${queueIndex + 1}` : `队列 ${queueIndex + 1}`}</span>}
                    {view === "route" && !queueEnabled && provider.id === config.routeProvider && <span className="claude-route-graph-tag">固定</span>}
                    {missingSonnet && <span className="claude-route-graph-tag is-warning">缺 Sonnet</span>}
                    <span className={`claude-route-graph-status${busy ? " is-live" : isActive ? " is-current" : failed ? " is-error" : ""}`}>{status}</span>
                  </span>
                </button>
              </div>
            </li>;
          })}
          {!targets.length && <li className="claude-route-graph-empty">{view === "aggregate" ? "队列为空。请在下方列表将供应商加入聚合。" : queueEnabled ? "队列为空。请在下方列表将供应商加入路由队列。" : "尚未选择固定供应商。请在下方列表点击“设为固定”。"}</li>}
          {hiddenCount > 0 && <li className="claude-route-graph-more">另有 {hiddenCount} 家供应商，下方列表可查看全部</li>}
        </ul>
        {particles.length > 0 && <svg className="claude-route-graph-particles" width={layout ? Math.ceil(layout.width) : 0} height={layout ? Math.ceil(layout.height) : 0} aria-hidden="true">
          {particles.map(particle => <g key={particle.key} className={`claude-route-graph-particle is-${particle.direction}`} data-claude-route-particle={particle.direction}>
            <animateMotion dur={`${particle.duration}s`} calcMode="paced" fill="freeze" path={particle.path} />
            <circle className="claude-route-graph-particle-ball" r="4" style={{ fill: particle.color }} />
          </g>)}
        </svg>}
      </div>
      <p className="claude-route-graph-note">{view === "route" ? "模型列显示各渠道首个已映射角色（通常为 Sonnet）；实际请求模型见右侧实时请求与用量日志。没有请求记录显示“未检测”，不代表连接失败。" : "默认供应商承接不带前缀的请求；成员按模型分发，不做故障转移。"}</p>
      {view === "route" ? <details className="claude-route-graph-rules">
        <summary>路由规则</summary>
        <ul>
          {config.roundRobin ? <>
            <li><strong>轮询：</strong>每个新请求按 P1 → P2… 顺序轮流分配，不是固定优先 P1；健康渠道之间尽量均分请求。</li>
            <li><strong>失败切换：</strong>同一请求遇到网络错误、超时、401/403/408/429/5xx 时，最多尝试 {config.retries + 1} 家供应商；其他 4xx 直接失败，不切换；流式响应开始转发后中断也不会切换。</li>
            <li><strong>熔断：</strong>某家连续失败达到 {config.failureThreshold} 次后熔断 {config.cooldownSecs} 秒；熔断期间从轮转中剔除，恢复后重新参与，成功一次即清零失败计数。</li>
          </> : config.failover ? <>
            <li><strong>优先级：</strong>每个新请求都从队列首个可用供应商开始（通常是 P1）；按 P1 → P2… 顺序尝试，不是轮询，也不会把请求均分到各家。P1/P2 是尝试优先级，不是两个独立队列。</li>
            <li><strong>优先级故障转移：</strong>同一请求遇到网络错误、超时、401/403/408/429/5xx 时，按队列顺序最多尝试 {config.retries + 1} 家供应商；其他 4xx 直接失败，不切换；流式响应开始转发后中断也不会切换。</li>
            <li><strong>熔断：</strong>某家连续失败达到 {config.failureThreshold} 次后熔断 {config.cooldownSecs} 秒，期间请求从下一位开始；冷却结束后重新尝试 P1，成功一次即清零失败计数。</li>
          </> : <>
            <li><strong>固定路由：</strong>所有请求只发往固定供应商，不会切换到队列；选择轮询或优先级故障转移后，队列顺序才参与请求分配。</li>
            <li><strong>熔断：</strong>固定供应商连续失败达到 {config.failureThreshold} 次后会熔断 {config.cooldownSecs} 秒，期间请求会返回“没有可用供应商”；冷却结束后重新尝试，成功一次即清零失败计数。</li>
          </>}
          <li><strong>状态：</strong>“最近响应”表示最后一次成功的供应商；卡片显示“回答中”才表示当前有请求正在转发。</li>
        </ul>
      </details> : <details className="claude-route-graph-rules">
        <summary>聚合规则</summary>
        <ul>
          <li>默认供应商承接不带前缀的请求；其他成员的模型以 <code>ccs-claude-…</code> 形式出现在 Claude Code 的 /model 中。</li>
          <li>聚合模式不按队列做故障转移；请求由客户端选择的模型直接决定目标供应商。</li>
        </ul>
      </details>}
    </div>}
  </section>;
}
