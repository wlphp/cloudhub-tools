import { useEffect, useRef, useState } from "react";
import { Bell, Droplets, Home, Moon, Move, Settings, X, EyeOff } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { defaultPetSettings, desktopPetClient as client, type PetSettings, type PetSnapshot, type PetAlert } from "../../platform/clients/desktopPet";
import { platformErrorMessage } from "../../platform/api";
import { AlertList } from "./PetSettingsPanel";
import "./desktop-pet.css";

type Pose = "idle" | "run" | "spray" | "sleep" | "happy" | "curious" | "hanging" | "work" | "alert";
const frameFor = (pose: Pose, frame: number): [number, number] => pose === "idle" ? [frame % 6, 0] : pose === "run" ? [frame % 6, 1] : pose === "spray" ? [frame % 6, 2] : [{ sleep: 0, happy: 1, curious: 2, hanging: 3, work: 4, alert: 5 }[pose], 3];

export function PetWindow() {
  const [settings, setSettings] = useState<PetSettings>(defaultPetSettings);
  const [snapshot, setSnapshot] = useState<PetSnapshot>({ alerts: [], checkedAt: 0, lastError: null });
  const [pose, setPose] = useState<Pose>("idle");
  const [frame, setFrame] = useState(0);
  const [panel, setPanel] = useState<"menu" | "status" | null>(null);
  const [notice, setNotice] = useState<PetAlert | null>(null);
  const [error, setError] = useState("");
  const [direction, setDirection] = useState(1);
  const [sleeping, setSleeping] = useState(false);
  const [hover, setHover] = useState(false);
  const [visible, setVisible] = useState(true);
  const visibleRef = useRef(true);
  visibleRef.current = visible;
  const [systemReduced, setSystemReduced] = useState(matchMedia("(prefers-reduced-motion: reduce)").matches);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = settings.reducedMotion || systemReduced;
  const pause = panel !== null || hover || sleeping || notice !== null;
  const [ready, setReady] = useState(false);
  const work = async (fn: () => Promise<unknown>) => { try { await fn(); setError(""); } catch (e) { setError(platformErrorMessage(e)); } };
  useEffect(() => {
    document.documentElement.classList.add("pet-window-page");
    let disposed = false;
    void Promise.all([client.settings(), client.snapshot()]).then(([s,a]) => { if (!disposed) { setSettings(s); setSnapshot(a); setReady(true); } }).catch(e => setError(platformErrorMessage(e)));
    const subscriptions = [listen<boolean>("pet-visibility", e => { setVisible(e.payload); if (!e.payload) { setPanel(null); setNotice(null); setPose("idle"); } }), listen<PetSettings>("pet-settings-changed", e => setSettings(e.payload)), listen<PetSnapshot>("pet-alerts-changed", e => setSnapshot(e.payload)), listen<PetAlert>("pet-notification", e => { if (visibleRef.current) { if(actionTimer.current) clearTimeout(actionTimer.current); setNotice(e.payload); setPose(e.payload.active ? "alert" : "happy"); } })];
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setSystemReduced(media.matches); media.addEventListener("change", change);
    return () => { disposed = true; media.removeEventListener("change", change); subscriptions.forEach(p => void p.then(fn => fn())); if (actionTimer.current) clearTimeout(actionTimer.current); document.documentElement.classList.remove("pet-window-page"); };
  }, []);
  useEffect(() => { void work(() => client.layout(panel !== null || notice !== null)); }, [panel, notice]);
  useEffect(() => {
    const update = () => {
      const regions = [...document.querySelectorAll(".pet-floating-card,.pet-alert-badge,.pet-inline-error")].map(el => { const r=el.getBoundingClientRect(); return [r.left,r.top,r.right,r.bottom]; });
      void client.regions(regions).catch(e => setError(platformErrorMessage(e)));
    };
    const observer=new ResizeObserver(update); observer.observe(document.body); document.querySelectorAll(".pet-floating-card,.pet-inline-error").forEach(el=>observer.observe(el));
    update(); return () => observer.disconnect();
  }, [panel, notice, snapshot, error]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setPanel(null); setNotice(null); setPose(sleeping ? "sleep" : "idle"); } };
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
  useEffect(() => { if (pause && pose === "run") setPose(sleeping ? "sleep" : "idle"); }, [pause, pose, sleeping]);
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
  useEffect(() => { void client.sprite(column, row, direction < 0).catch(e => setError(platformErrorMessage(e))); }, [column, row, direction]);
  const pending = snapshot.alerts.filter(a => a.active && a.snoozedUntil <= Date.now()/1000);
  return <main className={`pet-stage ${reduced ? "pet-reduced" : ""}`} style={{ "--pet-size": `${settings.size}px` } as React.CSSProperties}>
    {(panel || notice) && <section className={panel === "menu" ? "pet-floating-card pet-quick-menu" : "pet-floating-card"} role="dialog" aria-label={panel === "menu" ? "羊驼快捷菜单" : "羊驼运维状态"}>
      <header><strong>{panel === "menu" ? "小羊驼" : notice ? notice.active ? "有事情需要处理" : "状态已恢复" : "运维状态"}</strong><button aria-label="关闭" onClick={() => { setPanel(null); setNotice(null); setPose(sleeping ? "sleep" : "idle"); }}><X size={16} /></button></header>
      {panel === "menu" ? <div className="pet-menu">
        <button onClick={() => { setPanel(null); perform("spray"); }}><Droplets size={16} />喷水玩一下</button>
        <button onClick={() => { setSleeping(!sleeping); setPose(sleeping ? "idle" : "sleep"); setPanel(null); }}><Moon size={16} />{sleeping ? "起来活动" : "休息一下"}</button>
        <button onClick={() => setPanel("status")}><Bell size={16} />查看提醒（{pending.length}）</button>
        <button onClick={() => void work(() => client.move(0,0,true,true))}><Move size={16} />回到屏幕下沿</button>
        <button onClick={() => void work(() => client.open("resources"))}><Home size={16} />打开 CloudHub</button>
        <button onClick={() => void work(() => client.open("settings"))}><Settings size={16} />桌宠设置</button>
        <button onClick={() => void work(client.hide)}><EyeOff size={16} />隐藏桌宠（预警继续）</button>
      </div> : notice && !panel ? <div className={`pet-notice ${notice.severity}`}><strong>{notice.title}</strong><p>{notice.detail}</p><button onClick={() => void work(() => client.open(notice.section, notice.key))}>查看详情</button>{notice.active && <button onClick={() => void work(async () => { await client.snooze(notice.key); setNotice(null); setPose(sleeping ? "sleep" : "idle"); })}>一小时后提醒</button>}</div> : <><p>{settings.monitoring ? pending.length ? `${pending.length} 项待处理提醒` : "暂无待处理提醒" : "运维预警未开启"}</p><small>{snapshot.checkedAt ? `最近检查 ${new Date(snapshot.checkedAt*1000).toLocaleTimeString()}` : "尚未检查；未知状态不代表正常"}</small><AlertList snapshot={snapshot} onSnooze={key => void work(() => client.snooze(key))} /></>}
    </section>}
    {error && <div className="pet-inline-error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError("")}>关闭</button></div>}
    <div className="pet-avatar-wrap" onMouseEnter={() => { setHover(true); if (pose === "idle") setPose("curious"); }} onMouseLeave={() => { setHover(false); if (pose === "curious") setPose("idle"); }}>
      <button className="pet-avatar" aria-label="羊驼：点击查看状态，右键打开菜单，拖动可移动" title="点击查看状态 · 右键菜单 · 拖动移动"
        onContextMenu={e => { e.preventDefault(); setPanel("menu"); setPose("idle"); }}
        onPointerDown={e => { if (e.button !== 0) return; drag.current = { x: e.screenX, y: e.screenY, moved: false }; }}
        onPointerMove={e => { const start = drag.current; if (start && !start.moved && Math.hypot(e.screenX-start.x,e.screenY-start.y)>5) { start.moved = true; setPose("hanging"); void work(async () => { await getCurrentWindow().startDragging(); await client.move(0,0,false,true); setPose("idle"); }); } }}
        onPointerUp={() => { const d=drag.current; drag.current=null; if (d && !d.moved) { setPanel("status"); perform("happy",650); } }}
        onPointerCancel={() => { drag.current=null; setPose("idle"); }}
        onClick={e => { if (e.detail === 0) setPanel("status"); }}>
        <span className={`pet-sprite pet-pose-${pose}`} style={{ backgroundPosition: `${column*20}% ${row*100/3}%`, transform: `scaleX(${direction})` }} />
      </button>
      {pose === "spray" && !reduced && <div className={`pet-water ${direction < 0 ? "to-left" : ""}`} aria-hidden="true">{Array.from({ length: 7 },(_,i) => <i key={i} style={{ "--drop": i } as React.CSSProperties} />)}</div>}
      {pending.length > 0 && <button className="pet-alert-badge" aria-label={`${pending.length}项待处理提醒`} onClick={() => setPanel("status")}>{pending.length}</button>}
    </div>
  </main>;
}
