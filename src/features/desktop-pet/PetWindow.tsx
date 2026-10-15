import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Droplets, Home, Moon, Move, Settings, X, EyeOff, Maximize2, Minimize2, MessageCircle } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { defaultPetSettings, sortPetAlerts, desktopPetClient as client, type PetSettings, type PetSnapshot, type PetAlert } from "../../platform/clients/desktopPet";
import { platformErrorMessage } from "../../platform/api";
import { petAppearances, petSpriteStyle } from "./appearances";
import { PetChat } from "./PetChat";
import { usePetLife } from "./usePetLife";
import { PetLifeBubble } from "./PetLifeBubble";
import { AlertList } from "./PetSettingsPanel";
import "./desktop-pet.css";

type Pose = "idle" | "run" | "spray" | "sleep" | "happy" | "curious" | "hanging" | "work" | "alert";
const frameFor = (pose: Pose, frame: number): [number, number] => pose === "idle" ? [frame % 6, 0] : pose === "run" ? [frame % 6, 1] : pose === "spray" ? [frame % 6, 2] : [{ sleep: 0, happy: 1, curious: 2, hanging: 3, work: 4, alert: 5 }[pose], 3];

export function PetWindow() {
  const [settings, setSettings] = useState<PetSettings>(defaultPetSettings);
  const [snapshot, setSnapshot] = useState<PetSnapshot>({ alerts: [], checkedAt: 0, lastError: null });
  const [pose, setPose] = useState<Pose>("idle");
  const [frame, setFrame] = useState(0);
  const [panel, setPanel] = useState<"menu" | "status" | "chat" | null>(null);
  const [alertBusy, setAlertBusy] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [notice, setNotice] = useState<PetAlert | null>(null);
  const [noticeExpanded, setNoticeExpanded] = useState(false);
  const [error, setError] = useState("");
  const [direction, setDirection] = useState(1);
  const [sleeping, setSleeping] = useState(false);
  const [hover, setHover] = useState(false);
  const [visible, setVisible] = useState(true);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const visibleRef = useRef(true);
  visibleRef.current = visible;
  const [systemReduced, setSystemReduced] = useState(matchMedia("(prefers-reduced-motion: reduce)").matches);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = settings.reducedMotion || systemReduced;
  const stopLifePose = useCallback(() => setPose(p => p === "run" ? "idle" : p), []);
  const life = usePetLife({ settings, blocked: panel !== null || notice !== null || hover || sleeping, visible, reduced, setPose, setDirection, stopPose: stopLifePose, onError: e => setError(platformErrorMessage(e)) });
  const pause = panel !== null || hover || sleeping || notice !== null || life.notice !== null;
  const [ready, setReady] = useState(false);
  const work = async (fn: () => Promise<unknown>) => { try { await fn(); setError(""); } catch (e) { setError(platformErrorMessage(e)); } };
  useEffect(() => {
    document.documentElement.classList.add("pet-window-page");
    let disposed = false;
    void Promise.all([client.settings(), client.snapshot()]).then(([s,a]) => { if (!disposed) { setSettings(s); setSnapshot({ ...a, alerts: sortPetAlerts(a.alerts) }); setReady(true); if (s.monitoring && !s.quiet) setNotice(sortPetAlerts(a.alerts).find(alert => alert.active && !alert.ignored && alert.snoozedUntil <= Date.now()/1000) || null); } }).catch(e => setError(platformErrorMessage(e)));
    const subscriptions = [listen<boolean>("pet-visibility", e => { setVisible(e.payload); if (!e.payload) { setPanel(null); setNotice(null); setPose("idle"); } }), listen<PetSettings>("pet-settings-changed", e => setSettings(e.payload)), listen<PetSnapshot>("pet-alerts-changed", e => setSnapshot({ ...e.payload, alerts: sortPetAlerts(e.payload.alerts) })), listen<PetAlert>("pet-notification", e => { if (visibleRef.current && !settingsRef.current.quiet) { setNoticeExpanded(false); if(actionTimer.current) clearTimeout(actionTimer.current); setNotice(e.payload); setPose(e.payload.active ? "alert" : "happy"); } })];
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setSystemReduced(media.matches); media.addEventListener("change", change);
    return () => { disposed = true; media.removeEventListener("change", change); subscriptions.forEach(p => void p.then(fn => fn())); if (actionTimer.current) clearTimeout(actionTimer.current); document.documentElement.classList.remove("pet-window-page"); };
  }, []);
  useEffect(() => { if (settings.quiet) { setNotice(null); setNoticeExpanded(false); } }, [settings.quiet]);
  const panelOpen = panel !== null || notice !== null || life.notice !== null;
  const largeLayout = panelOpen && panel !== "menu" && (enlarged || panel === "chat");
  useEffect(() => { void work(() => client.layout(panelOpen, largeLayout)); }, [panelOpen, largeLayout]);
  useEffect(() => {
    const update = () => {
      const regions = [...document.querySelectorAll(".pet-floating-card,.pet-speech-bubble,.pet-alert-badge,.pet-inline-error")].map(el => { const r=el.getBoundingClientRect(); return [r.left,r.top,r.right,r.bottom]; });
      void client.regions(regions).catch(e => setError(platformErrorMessage(e)));
    };
    const observer=new ResizeObserver(update); observer.observe(document.body); document.querySelectorAll(".pet-floating-card,.pet-speech-bubble,.pet-inline-error").forEach(el=>observer.observe(el));
    update(); return () => observer.disconnect();
  }, [panel, notice, noticeExpanded, snapshot, error, life.notice]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setPanel(null); setNotice(null); setNoticeExpanded(false); setEnlarged(false); setPose(sleeping ? "sleep" : "idle"); } };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [sleeping]);
  useEffect(() => {
    if (!visible || reduced || !["idle", "run", "spray"].includes(pose)) { setFrame(0); return; }
    const timer = setInterval(() => setFrame(f => (f + 1) % 6), pose === "idle" ? 480 : 130);
    return () => clearInterval(timer);
  }, [pose, reduced, visible]);
  useEffect(() => {
    if (!ready || !visible || pause || reduced || settings.activity === 0) return;
    const timer = setInterval(() => {
      if (Math.random() < .25) { perform("spray"); return; }
      if (settings.roam !== "still") { setDirection(Math.random() < .5 ? -1 : 1); perform("run", 2600); }
      else perform("curious");
    }, settings.activity === 2 ? 10000 : 25000);
    return () => clearInterval(timer);
  }, [ready, visible, pause, reduced, settings.activity, settings.roam]);
  useEffect(() => {
    if (!visible || pose !== "run" || pause || reduced) return;
    let pending = false;
    const timer = setInterval(() => { if (!pending) { pending = true; void client.move(direction * 4, settings.roam === "free" ? -direction * 2 : 0).catch(e => setError(platformErrorMessage(e))).finally(() => { pending = false; }); } }, 65);
    return () => clearInterval(timer);
  }, [visible, pose, pause, reduced, settings.roam, direction]);
  useEffect(() => { if (pause && !life.roaming && pose === "run") setPose(sleeping ? "sleep" : "idle"); }, [pause, pose, sleeping, life.roaming]);
  function perform(next: Pose, duration = 1800) {
    if (actionTimer.current) clearTimeout(actionTimer.current);
    setPose(next); setFrame(0);
    if (next === "spray" && settings.sound && !settings.quiet) {
      const audio = new AudioContext(); const osc = audio.createOscillator(); const gain = audio.createGain();
      osc.type = "sine"; osc.frequency.setValueAtTime(700, audio.currentTime); osc.frequency.exponentialRampToValueAtTime(180, audio.currentTime + .18);
      gain.gain.setValueAtTime(.025, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .2);
      osc.connect(gain); gain.connect(audio.destination); osc.start(); osc.stop(audio.currentTime + .22); osc.onended = () => { void audio.close(); };
    }
    actionTimer.current = setTimeout(() => setPose(sleeping ? "sleep" : "idle"), duration);
  }
  const [column, row] = frameFor(pose, frame);
  useEffect(() => { void client.sprite(column, row, direction < 0, settings.appearance).catch(e => setError(platformErrorMessage(e))); }, [column, row, direction, settings.appearance]);
  const pending = snapshot.alerts.filter(a => a.active && !a.ignored && a.snoozedUntil <= Date.now()/1000);
  async function ignoreAlerts(keys: string[], ignored = true) {
    setAlertBusy(true);
    try { await work(async () => { setSnapshot(await client.ignore(keys, ignored)); }); }
    finally { setAlertBusy(false); }
  }
  useEffect(() => { setNotice(current => current && snapshot.alerts.some(a => a.key === current.key && (a.ignored || a.snoozedUntil > Date.now()/1000)) ? null : current); }, [snapshot]);
  function closePanel() { setPanel(null); if (noticeExpanded) setNotice(null); setNoticeExpanded(false); setEnlarged(false); setPose(sleeping ? "sleep" : "idle"); }
  function dragPanel(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    void work(async () => { await getCurrentWindow().startDragging(); await client.move(0, 0, false, true); });
  }
  return <main className={`pet-stage ${reduced ? "pet-reduced" : ""}`} style={{ "--pet-size": `${settings.size}px`, "--pet-sprite-image": `url("${(petAppearances[settings.appearance] || petAppearances.alpaca).sprite}")`, "--pet-chat-avatar-position": settings.appearance === "dog" ? "-18px -7px" : "-12px -7px", "--pet-welcome-avatar-position": settings.appearance === "dog" ? "-24px -6px" : "-18px -8px" } as React.CSSProperties}>
    {life.notice && <PetLifeBubble notice={life.notice} action={life.action} roaming={life.roaming} />}
    {!panel && notice && !noticeExpanded && <div className={`pet-speech-bubble ${notice.active ? notice.severity : "recovered"}`} role="status" aria-label="运维消息气泡">
      <button className="pet-speech-open" onClick={() => setNoticeExpanded(true)} aria-label={`查看运维消息：${notice.title}`}>
        <span className="pet-speech-caption"><Bell size={13} aria-hidden="true" />{notice.active ? notice.severity === "emergency" ? "超级严重，请尽快处理" : "有件事想提醒你" : "好消息，状态恢复了"}</span>
        <strong>{notice.title}</strong><span className="pet-speech-detail">{notice.detail}</span><span className="pet-speech-hint">点击查看{pending.length > 1 ? ` · 共 ${pending.length} 项待处理` : ""}</span>
      </button><button className="pet-speech-close" aria-label="关闭消息气泡" title="关闭消息气泡" onClick={() => { setNotice(null); setPose(sleeping ? "sleep" : "idle"); }}><X size={14} /></button>
    </div>}
    {(panel || (notice && noticeExpanded)) && <section className={panel === "menu" ? "pet-floating-card pet-quick-menu" : `pet-floating-card pet-status-card${panel === "chat" ? " pet-chat-card" : ""}`} role="dialog" aria-label={panel === "menu" ? "宠物快捷菜单" : panel === "chat" ? "和宠物聊天" : "宠物运维状态"}>
      <header className="pet-panel-titlebar" onPointerDown={dragPanel} title="拖动标题栏移动"><strong>{panel === "chat" ? <MessageCircle size={15} aria-hidden="true" /> : panel !== "menu" && <Bell size={15} aria-hidden="true" />}{panel === "menu" ? "宠物" : panel === "chat" ? "和宠物聊天" : notice && !panel ? notice.active ? notice.severity === "emergency" ? "超级严重，请尽快处理" : "有事情需要处理" : "状态已恢复" : "运维状态"}</strong>{panel === "status" && <span className="pet-pending-count">{pending.length} 项待处理</span>}<div className="pet-panel-controls">{panel !== "menu" && panel !== "chat" && <button aria-label={enlarged ? "还原面板" : "放大面板"} title={enlarged ? "还原面板" : "放大面板"} onClick={() => setEnlarged(value => !value)}>{enlarged ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>}<button aria-label="关闭" title="关闭（Esc）" onClick={closePanel}><X size={16} /></button></div></header>
      {panel === "chat" ? <PetChat /> : panel === "menu" ? <div className="pet-menu">
        <button onClick={() => { setPanel(null); perform("spray"); }}><Droplets size={16} />喷水玩一下</button>
        <button onClick={() => { setSleeping(!sleeping); setPose(sleeping ? "idle" : "sleep"); setPanel(null); }}><Moon size={16} />{sleeping ? "起来活动" : "休息一下"}</button>
        <button onClick={() => { setNotice(null); setPanel("chat"); }}><MessageCircle size={16} />和宠物聊天</button>
        <button onClick={() => setPanel("status")}><Bell size={16} />查看提醒（{pending.length}）</button>
        <button onClick={() => void work(() => client.move(0,0,true,true))}><Move size={16} />回到屏幕下沿</button>
        <button onClick={() => void work(() => client.open("resources"))}><Home size={16} />打开 CloudHub</button>
        <button onClick={() => void work(() => client.open("settings"))}><Settings size={16} />桌宠设置</button>
        <button onClick={() => void work(client.hide)}><EyeOff size={16} />隐藏桌宠（预警继续）</button>
      </div> : notice && !panel ? <div className={`pet-notice ${notice.severity}`}><strong>{notice.title}</strong><p>{notice.detail}</p><button onClick={() => void work(() => client.open(notice.section, notice.key))}>查看详情</button>{notice.active && <button onClick={() => void work(async () => { await client.snooze(notice.key); setNotice(null); setPose(sleeping ? "sleep" : "idle"); })}>一小时后提醒</button>}{notice.active && <button disabled={alertBusy} onClick={() => void ignoreAlerts([notice.key])}>忽略</button>}</div> : <><AlertList snapshot={snapshot} onSnooze={key => void work(() => client.snooze(key))} onIgnore={(keys, ignored) => void ignoreAlerts(keys, ignored)} busy={alertBusy} /><footer className="pet-status-footer"><span>{settings.monitoring ? "巡检已开启" : "巡检已暂停"}</span><span>{snapshot.checkedAt ? `检查于 ${new Date(snapshot.checkedAt*1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "尚未检查"}</span></footer></>}
    </section>}
    {error && <div className="pet-inline-error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError("")}>关闭</button></div>}
    <div className="pet-avatar-wrap" onMouseEnter={() => { setHover(true); if (pose === "idle") setPose("curious"); }} onMouseLeave={() => { setHover(false); if (pose === "curious") setPose("idle"); }}>
      <button className="pet-avatar" aria-label="宠物：点击查看状态，右键打开菜单，拖动可移动" title="点击查看状态 · 右键菜单 · 拖动移动"
        onContextMenu={e => { e.preventDefault(); setPanel("menu"); setPose("idle"); }}
        onPointerDown={e => { if (e.button !== 0) return; drag.current = { x: e.screenX, y: e.screenY, moved: false }; }}
        onPointerMove={e => { const start = drag.current; if (start && !start.moved && Math.hypot(e.screenX-start.x,e.screenY-start.y)>5) { start.moved = true; setPose("hanging"); void work(async () => { await getCurrentWindow().startDragging(); await client.move(0,0,false,true); setPose("idle"); }); } }}
        onPointerUp={() => { const d=drag.current; drag.current=null; if (d && !d.moved) { setPanel("status"); perform("happy",650); } }}
        onPointerCancel={() => { drag.current=null; setPose("idle"); }}
        onClick={e => { if (e.detail === 0) setPanel("status"); }}>
        <span className={`pet-sprite pet-pose-${pose}`} style={{ ...petSpriteStyle(settings.appearance, column, row), transform: `scaleX(${direction})` }} />
      </button>
      <button className="pet-mouth" aria-label="点击嘴巴，和宠物聊天" title="和宠物聊聊天" style={{ left: settings.appearance === "dog" ? direction < 0 ? "16%" : "58%" : direction < 0 ? "44%" : "30%", top: settings.appearance === "dog" ? "40%" : "28%" }} onClick={() => { setNotice(null); setPanel("chat"); setPose("happy"); }} />
      {pose === "spray" && !reduced && <div className={`pet-water ${direction < 0 ? "to-left" : ""}`} aria-hidden="true">{Array.from({ length: 7 },(_,i) => <i key={i} style={{ "--drop": i } as React.CSSProperties} />)}</div>}
      {pending.length > 0 && <button className="pet-alert-badge" aria-label={`${pending.length}项待处理提醒`} onClick={() => setPanel("status")}>{pending.length}</button>}
    </div>
  </main>;
}
