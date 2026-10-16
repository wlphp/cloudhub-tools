import { useEffect, useState } from "react";
import { CloudLightning, Coffee, Droplets, X } from "lucide-react";
import type { PetLifeNotice, PetSettings } from "../../platform/clients/desktopPet";
import { PetPortrait } from "./PetPortrait";

export function PetLifeBubble({ notice, action, roaming, appearance }: { notice: PetLifeNotice; action: (action: "ack" | "snooze" | "openWeather") => Promise<void>; roaming: boolean; appearance: PetSettings["appearance"] }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setExpanded(false), [notice.id]);
  const Icon = notice.kind === "weather" ? CloudLightning : notice.kind === "water" ? Droplets : Coffee;
  const run = async (kind: "ack" | "snooze" | "openWeather") => { setBusy(true); try { await action(kind); } finally { setBusy(false); } };
  return <div className={`pet-speech-bubble pet-life-bubble ${notice.level >= 2 ? "emergency" : ""}`} role="status" aria-label="宠物生活提醒" data-roaming={roaming}>
    <button className="pet-speech-open" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
      <span className="pet-speech-caption"><PetPortrait appearance={appearance} pose={notice.kind === "weather" ? "alert" : "happy"} /><Icon size={14} aria-hidden="true" />{notice.kind === "weather" ? "天气预警" : "宠物的小叮嘱"}</span><strong>{notice.title}</strong>
      <span className="pet-speech-detail">{notice.detail}</span>
      {expanded && <span className="pet-life-issued">{notice.kind === "weather" ? "发布于" : "提醒于"} {new Date(notice.createdAt * 1000).toLocaleString()}{notice.kind === "weather" && " · 中央气象台"}</span>}
    </button>
    <button className="pet-speech-close" aria-label="关闭生活提醒" title="关闭生活提醒" disabled={busy} onClick={() => void run("ack")}><X size={14} /></button>
    <div className="pet-life-bubble-actions">{notice.kind === "weather" && <button disabled={busy} onClick={() => void run("openWeather")}>查看预警原文</button>}<button disabled={busy} onClick={() => void run("snooze")}>10 分钟后</button><button disabled={busy} onClick={() => void run("ack")}>{notice.kind === "water" ? "喝过啦" : "知道了"}</button></div>
  </div>;
}
