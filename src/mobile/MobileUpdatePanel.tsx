import { Download, ExternalLink, RefreshCw } from "lucide-react";
import type { useMobileUpdates } from "./useMobileUpdates";

export function MobileUpdatePanel({ update }: { update: ReturnType<typeof useMobileUpdates> }) {
  const { info, phase, message, progress, android } = update;
  const percentage = progress.total > 0 ? Math.min(100, Math.floor(progress.downloaded / progress.total * 100)) : 0;
  const label = phase === "checking" ? "正在检查 GitHub 最新稳定版本…"
    : phase === "available" ? `发现新版本 v${info?.version}`
    : phase === "current" ? `最新稳定版 v${info?.version}，当前版本无需更新。`
    : phase === "downloading" ? `正在下载 ${percentage}% · ${(progress.downloaded / 1048576).toFixed(1)} MB`
    : phase === "ready" || phase === "installing" ? `更新 v${info?.version} 已下载`
    : android ? "启动时自动检查 GitHub 稳定版本。" : "检查 GitHub 稳定版本，安装请在 Android App 中进行。";
  return <section className="mobile-about-update" aria-label="客户端更新">
    <div className="mobile-about-update-copy"><strong>应用更新</strong><small role="status" aria-live="polite">{message || label}</small></div>
    {phase === "downloading" && <progress aria-label="更新下载进度" max={100} value={percentage} />}
    {info?.available && info.notes && <details className="mobile-update-notes"><summary>v{info.version} 更新说明</summary><p>{info.notes}</p></details>}
    <div className="mobile-update-buttons">
      {phase === "downloading" ? <button type="button" onClick={() => void update.cancel()}>取消下载</button>
        : phase === "ready" || phase === "installing" ? <button type="button" className="mobile-primary" disabled={phase === "installing"} onClick={() => void update.install()}><Download size={15} aria-hidden="true" />{phase === "installing" ? "启动安装中…" : "安装更新"}</button>
        : <>
          <button type="button" disabled={phase === "checking"} onClick={() => void update.check()}><RefreshCw size={15} aria-hidden="true" />{phase === "checking" ? "检查中…" : "检查更新"}</button>
          {info?.available && (android && info.downloadable
            ? <button type="button" className="mobile-primary" onClick={() => void update.download()}><Download size={15} aria-hidden="true" />下载更新{info.size > 0 ? ` · ${(info.size / 1048576).toFixed(0)} MB` : ""}</button>
            : <button type="button" onClick={() => void update.openReleases()}><ExternalLink size={15} aria-hidden="true" />发布页</button>)}
        </>}
    </div>
    {android && info?.available && !info.downloadable && <small>Android 安装包尚未就绪，请稍后重新检查。</small>}
    {!android && <small>{/iPhone|iPad/i.test(navigator.userAgent) ? "iOS 版本需通过 Apple 签名渠道安装。" : "网页预览仅检查版本，不下载或安装 APK。"}</small>}
  </section>;
}
