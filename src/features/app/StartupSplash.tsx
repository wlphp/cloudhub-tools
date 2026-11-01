import { useEffect } from "react";
import { emit } from "@tauri-apps/api/event";

export function StartupSplash({ onComplete }: { onComplete?: () => void }) {
  useEffect(() => {
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 250 : 2200;
    const timer = window.setTimeout(() => {
      if (onComplete) onComplete();
      else void emit("startup-animation-finished");
    }, duration);
    return () => window.clearTimeout(timer);
  }, [onComplete]);

  return <main className="startup-splash" aria-label="云枢工具箱正在启动">
    <div className="startup-splash-orbit" aria-hidden="true"><span /><span /><span /></div>
    <img className="startup-splash-logo" src="/cloudhub-logo.png" alt="" />
    <strong>云枢工具箱</strong>
    <span className="startup-splash-caption">本地多云资源管理</span>
    <div className="startup-splash-progress" role="status" aria-label="正在启动"><span /></div>
  </main>;
}
