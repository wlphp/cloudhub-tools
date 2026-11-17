import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { sourceLabel, updatesClient, type UpdateProbe, type UpdateRoute, type UpdateSource } from "../../platform/clients/updates";
import type { useUpdateSource } from "./useUpdateSource";
import "./updates.css";

export function UpdateSourceControl({ settings, locked, route, message }: { settings: ReturnType<typeof useUpdateSource>; locked: boolean; route?: UpdateRoute; message?: string }) {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<Partial<Record<UpdateRoute, UpdateProbe>>>({});
  const busy = useRef(false);
  async function test() {
    if (busy.current) return;
    busy.current = true; setTesting(true); setResults({});
    try {
      await Promise.all((["accelerated", "mirror705810", "direct"] as const).map(async candidate => {
        let result: UpdateProbe;
        try { result = await updatesClient.probe(candidate); }
        catch (e) { result = { route: candidate, available: false, responseMs: 0, bytesPerSecond: 0, message: platformErrorMessage(e, "测速失败") }; }
        setResults(previous => ({ ...previous, [candidate]: result }));
      }));
    } finally { busy.current = false; setTesting(false); }
  }
  const disabled = locked || settings.saving || !settings.loaded || testing;
  return <div className="update-source-control">
    <div className="update-source-toolbar"><label>下载线路<select aria-label="更新下载线路" value={settings.source} disabled={disabled} onChange={e => void settings.save(e.target.value as UpdateSource)}><option value="auto">自动选择（加速失败后直连）</option><option value="accelerated">gh-proxy.com</option><option value="mirror705810">github.705810.xyz</option><option value="direct">GitHub 官方直连</option></select></label><button type="button" className="secondary" disabled={locked || settings.saving} onClick={() => setOpen(true)}>测速 / 切换</button></div>
    <p role="status">{message || (route ? `当前线路：${sourceLabel(route)}` : "自动模式优先加速，失败后尝试 GitHub 官方直连。")}</p>
    {settings.error && <p role="alert">{settings.error}</p>}
    {!runningInTauri && <p>浏览器线路偏好与原生隔离；测速经本地预览 API 执行，不执行原生安装。</p>}
    {open && <SharedDialog title="软件更新 · 选择下载线路" size="small" sizeStorageKey="app/update-source" onClose={() => setOpen(false)} footer={<button type="button" className="secondary" onClick={() => setOpen(false)}>关闭</button>}>
      <div className="update-source-dialog">
        <div className="update-source-toolbar"><button type="button" className="secondary" disabled={testing} onClick={() => void test()}><RefreshCw size={14} aria-hidden="true" />{testing ? "测速中…" : "重新测速"}</button><button type="button" className="secondary" disabled={disabled} onClick={() => void settings.save("auto")}>恢复自动选择</button></div>
        <p>当前选择：{sourceLabel(settings.source)}</p>
        <div role="status" aria-live="polite">{testing ? "正在测试三条线路…" : Object.keys(results).length ? "测速完成" : "点击测速后检测可用性及抽样速度。"}</div>
        {(["accelerated", "mirror705810", "direct"] as const).map(candidate => <div className="update-source-node" key={candidate}><strong>{sourceLabel(candidate)}</strong><div>{results[candidate] ? <><span>{results[candidate]!.available ? "可用" : "不可用"}</span><small>{results[candidate]!.available ? `${results[candidate]!.responseMs} ms · ${(results[candidate]!.bytesPerSecond / 1024).toFixed(1)} KiB/s` : results[candidate]!.message}</small></> : <span>{testing ? "正在测速…" : "未测速"}</span>}</div><button type="button" className="secondary" disabled={disabled} onClick={() => void settings.save(candidate)}>使用此线路</button></div>)}
        {settings.error && <p role="alert">{settings.error}</p>}
        <details><summary>线路与校验说明</summary><p>测速读取每条线路的版本信息和最多 256 KiB 安装包样本，实际速度随网络变化。手机使用移动网络时也会产生流量，仅在点击后测速。</p><p>自动模式依次尝试 gh-proxy.com、github.705810.xyz 和官方直连；手动指定时仅使用所选线路。下载失败后切换线路会重新下载同一版本。桌面保留更新签名校验，Android 保留摘要、包名与签名证书校验。</p><p>设置仅影响本应用更新，不修改系统代理。iOS 仍须通过 Apple 签名渠道安装。</p></details>
      </div>
    </SharedDialog>}
  </div>;
}
