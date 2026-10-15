import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { petSeverityLabel, desktopPetClient as client, type PetAlert, type PetSnapshot } from "../../platform/clients/desktopPet";
import { platformErrorMessage } from "../../platform/api";
import "./desktop-pet.css";

export function PetAlertWindow() {
  const [alert, setAlert] = useState<PetAlert | null>(null);
  const [error, setError] = useState("");
  const work = async (action: () => Promise<void>) => { try { await action(); } catch (e) { setError(platformErrorMessage(e)); } };
  useEffect(() => {
    void client.notice().then(setAlert).catch(e => setError(platformErrorMessage(e)));
    const event = listen<PetAlert>("pet-notification", e => setAlert(e.payload));
    const changed = listen<PetSnapshot>("pet-alerts-changed", e => setAlert(current => current && e.payload.alerts.some(a => a.key === current.key && a.ignored) ? { ...current, ignored: true } : current));
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") void work(client.dismiss); };
    window.addEventListener("keydown", key);
    return () => { void event.then(fn => fn()); void changed.then(fn => fn()); window.removeEventListener("keydown",key); };
  }, []);
  useEffect(() => { if (alert?.ignored) void work(client.dismiss); }, [alert?.ignored]);
  return <main className="pet-desktop-notice" role="dialog" aria-label="CloudHub 运维提醒"><header><Bell size={16} /><strong>CloudHub 运维提醒</strong><button onClick={() => void work(client.dismiss)} aria-label="关闭提醒"><X size={16} /></button></header>
    {error && <p role="alert" className="pet-error">{error}</p>}
    {alert ? <><span className={`pet-notice-level ${alert.active ? alert.severity : "recovered"}`}>{alert.active ? petSeverityLabel(alert.severity) : "已解除"}</span><strong>{alert.active ? alert.title : `已解除 · ${alert.title}`}</strong><p>{alert.detail}</p><div><button onClick={() => void work(() => client.open(alert.section, alert.key))}>查看详情</button>{alert.active && <><button onClick={() => void work(async () => { await client.snooze(alert.key); await client.dismiss(); })}>一小时后提醒</button><button onClick={() => void work(async () => { await client.ignore([alert.key]); await client.dismiss(); })}>忽略</button></>}<button onClick={() => void work(() => client.open("settings"))}>提醒记录</button></div></> : <p>暂无提醒</p>}
  </main>;
}
