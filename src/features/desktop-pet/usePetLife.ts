import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopPetClient as client, emptyPetLifeState, type PetLifeState, type PetSettings } from "../../platform/clients/desktopPet";

export function usePetLife({ settings, blocked, visible, reduced, setPose, setDirection, stopPose, onError }: {
  settings: PetSettings; blocked: boolean; visible: boolean; reduced: boolean;
  setPose: (pose: "idle" | "run") => void; setDirection: (direction: number) => void; stopPose: () => void; onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<PetLifeState>(emptyPetLifeState);
  const [now, setNow] = useState(Date.now() / 1000);
  const [roaming, setRoaming] = useState(false);
  const roamed = useRef(new Set<string>());
  const errorRef = useRef(onError); errorRef.current = onError;
  useEffect(() => {
    let disposed = false;
    void client.lifeState().then(s => { if (!disposed && Array.isArray(s?.notices)) setState(s); }).catch(e => errorRef.current(e));
    const sub = listen<PetLifeState>("pet-life-changed", e => { if (!disposed) { setState(e.payload); setNow(Date.now() / 1000); } });
    const timer = setInterval(() => setNow(Date.now() / 1000), 10000);
    return () => { disposed = true; clearInterval(timer); void sub.then(fn => fn()); };
  }, []);
  const config = settings.life;
  const notice = !config?.enabled || !settings.enabled || settings.quiet || !visible || blocked ? null : state.notices
    .filter(n => !n.acknowledged && n.dueAt <= now && n.expiresAt > now && (n.kind === "weather" ? config.weather : n.kind === "water" ? config.water || n.id.startsWith("preview:") : n.kind === "stretch" ? config.stretch : config.schedule))
    .sort((a, b) => b.level - a.level || a.dueAt - b.dueAt)[0] || null;
  useEffect(() => {
    if (!notice) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") void client.lifeAction(notice.id, "ack").then(setState).catch(error => errorRef.current(error)); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [notice?.id]);
  useEffect(() => {
    if (!notice || notice.kind !== "water" || !config.waterRoam || reduced || roamed.current.has(notice.id)) return;
    roamed.current.add(notice.id);
    if (roamed.current.size > 200) roamed.current.delete(roamed.current.values().next().value!);
    setRoaming(true); setPose("run");
    let step = 0, pending = false, stopped = false;
    const interval = setInterval(() => {
      if (pending || stopped) return;
      // Several diagonal turns make the reminder visibly different from ordinary edge roaming.
      const direction = Math.floor(step / 20) % 2 === 0 ? -1 : 1;
      const dy = Math.floor(step / 30) % 2 === 0 ? -5 : 5;
      step++; setDirection(direction); pending = true;
      void client.move(direction * 9, dy).catch(e => errorRef.current(e)).finally(() => { pending = false; });
    }, 100);
    const timeout = setTimeout(() => { stopped = true; clearInterval(interval); setRoaming(false); setPose("idle"); }, 12000);
    return () => { stopped = true; clearInterval(interval); clearTimeout(timeout); setRoaming(false); stopPose(); };
  }, [notice?.id, config?.waterRoam, reduced, setPose, setDirection, stopPose]);
  async function action(kind: "ack" | "snooze" | "openWeather") {
    if (!notice) return;
    try { setState(await client.lifeAction(notice.id, kind)); setNow(Date.now() / 1000); }
    catch (e) { errorRef.current(e); }
  }
  return { notice, action, roaming };
}
