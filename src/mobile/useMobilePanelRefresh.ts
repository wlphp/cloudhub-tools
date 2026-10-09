import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { runningInTauri } from "../platform/api";
import { remoteClient } from "../platform/clients";
import type { PanelConnection } from "../shared/types";

const preferenceKey = "aliyun-mobile-panel-refresh-seconds";
export const panelRefreshIntervals = [0, 5, 10, 30, 60];

export function useMobilePanelRefresh(active: boolean, paused: boolean, panels: PanelConnection[], setPanels: Dispatch<SetStateAction<PanelConnection[]>>) {
  const [seconds, setSeconds] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(preferenceKey));
      return panelRefreshIntervals.includes(saved) ? saved : 0;
    } catch { return 0; }
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const latest = useRef({ paused, panels });
  latest.current = { paused, panels };

  useEffect(() => {
    try { localStorage.setItem(preferenceKey, String(seconds)); } catch { /* Storage may be unavailable. */ }
  }, [seconds]);

  useEffect(() => {
    if (!active || paused || seconds <= 0) return;
    let disposed = false;
    let generation = 0;
    let timer: number | undefined;
    const schedule = () => {
      if (!disposed && !document.hidden) timer = window.setTimeout(() => void refresh(), seconds * 1000);
    };
    const refresh = async () => {
      if (disposed || document.hidden) return;
      if (latest.current.paused || inFlight.current || !latest.current.panels.length) { schedule(); return; }
      inFlight.current = true;
      setBusy(true);
      const round = generation;
      const valid = () => !disposed && round === generation && !document.hidden && !latest.current.paused;
      let errors = false;
      try {
        if (!runningInTauri) {
          const cached = await remoteClient.listPanels();
          if (valid()) setPanels(cached);
        } else {
          const queue = latest.current.panels.filter((panel) => panel.api_key_saved);
          let index = 0;
          const worker = async () => {
            while (valid() && index < queue.length) {
              const panel = queue[index++];
              try {
                const updated = await remoteClient.refreshPanel(panel.id);
                if (valid()) setPanels((current) => current.map((item) => item.id === updated.id ? updated : item));
                if (updated.status !== "online") errors = true;
              } catch { errors = true; }
            }
          };
          await Promise.all([worker(), worker()]);
        }
      } catch { errors = true; }
      finally {
        inFlight.current = false;
        setBusy(false);
        if (valid()) setFailed(errors);
        schedule();
      }
    };
    const visibilityChanged = () => {
      generation += 1;
      window.clearTimeout(timer);
      if (!document.hidden && !inFlight.current) schedule();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [active, paused, seconds, setPanels]);

  return { seconds, setSeconds, busy, failed, inFlight };
}
