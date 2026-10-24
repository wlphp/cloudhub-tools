import { useEffect, useRef, useState } from "react";
import { FolderOpen, Play, RefreshCw } from "lucide-react";
import { runningInTauri } from "../../platform/api";
import { pluginsClient, type WechatPluginStatus } from "../../platform/clients/plugins";
import { officialPlugins } from "./registry";
import { WechatSessionSettings } from "./WechatSessionSettings";

type Config = { enabled: boolean; path: string; count: number };
const plugin = officialPlugins[0];
function readConfig(): Config {
  try { const value = JSON.parse(localStorage.getItem(`${plugin.id}.config`) || "{}"); return { enabled: value.enabled !== false, path: typeof value.path === "string" ? value.path : "", count: Number.isInteger(value.count) && value.count >= 2 && value.count <= 5 ? value.count : 2 }; }
  catch { return { enabled: true, path: "", count: 2 }; }
}
export function WechatPluginSettings({ open = true, onNotify, onError }: { open?: boolean; onNotify?: (message: string) => void; onError?: (message: string) => void }) {
  const [config, setConfig] = useState(readConfig);
  const [status, setStatus] = useState<WechatPluginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const notify = (text: string) => { if (onNotify) onNotify(text); else setMessage(text); };
  const supported = runningInTauri && status?.supported === true;
  useEffect(() => { if (open && runningInTauri) void operate(() => refresh()); }, [open]);
  useEffect(() => { try { localStorage.setItem(`${plugin.id}.config`, JSON.stringify(config)); } catch { setError("无法保存插件设置，请检查本地存储空间。"); } }, [config]);
  async function operate(action: () => Promise<void>) { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(""); setMessage(""); try { await action(); } catch (reason) { const text = reason instanceof Error ? reason.message : "插件操作失败，请重试"; if (onError) onError(text); else setError(text); } finally { busyRef.current = false; setBusy(false); } }
  async function refresh(detect = false) { const next = await pluginsClient.wechatStatus(); setStatus(next); if (detect && next.detectedPath) setConfig(current => ({ ...current, path: next.detectedPath! })); if (detect) notify(next.detectedPath ? "已检测到微信客户端。" : "未找到默认安装位置，请手动选择微信客户端。"); }
  async function launch() { const current = await pluginsClient.wechatStatus(); setStatus(current); if (!current.supported) throw new Error("微信多开插件仅支持 Windows 桌面端"); if (current.runningProcesses > 0) throw new Error("请先从微信托盘菜单退出所有微信，再点击批量启动。不会自动结束已有微信。"); const result = await pluginsClient.launchWechat(config.path || current.detectedPath || "", config.count); notify(`已提交 ${result.started}/${result.requested} 个启动请求${result.failed ? `，${result.failed} 个未能启动，请检查客户端权限` : ""}。请查看实际微信窗口；启动请求数不代表多开成功。`); }
  const canLaunch = supported && config.enabled && !busy && !!(config.path || status?.detectedPath);
  if (!open) return null;
  const body = <><p>同时启动多个已安装的微信客户端，用于尝试登录不同账号。“官方”指云枢工具箱出品。</p><label className="official-plugin-toggle"><input type="checkbox" aria-label="启用微信多开" checked={config.enabled} disabled={busy} onChange={event => setConfig(current => ({ ...current, enabled: event.target.checked }))} />启用插件</label>{!runningInTauri && <p role="status">浏览器预览不支持启动本地软件，请在 Windows 桌面客户端使用。</p>}{runningInTauri && status && !status.supported && <p role="status">微信多开插件仅支持 Windows 桌面端。</p>}<p className="official-plugin-note">批量启动只重复打开当前配置，无法区分账号。需要不同头像时，请使用下方“账号登录配置”逐个恢复并启动；部分版本仍可能合并窗口。</p>{!config.enabled && <p role="status">插件已停用，启用后可使用启动功能。</p>}{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}<fieldset disabled={!supported || !config.enabled || busy}><legend>微信启动设置</legend><label htmlFor="wechat-client-path">客户端路径</label><div className="official-plugin-path"><input id="wechat-client-path" value={config.path || status?.detectedPath || ""} readOnly placeholder="选择 Weixin.exe 或 WeChat.exe"/><button type="button" className="secondary" onClick={() => void operate(() => refresh(true))}><RefreshCw size={14} aria-hidden="true"/>自动检测</button><button type="button" className="secondary" onClick={() => void operate(async () => { const path = await pluginsClient.selectWechat(); if (path) setConfig(current => ({ ...current, path })); })}><FolderOpen size={14} aria-hidden="true"/>选择文件</button></div><div className="official-plugin-actions wechat-setting-row"><label htmlFor="wechat-window-count">启动数量</label><select id="wechat-window-count" value={config.count} onChange={event => setConfig(current => ({ ...current, count: Number(event.target.value) }))}>{[2,3,4,5].map(count => <option key={count} value={count}>{count} 个</option>)}</select><button type="button" className="primary" disabled={!canLaunch} onClick={() => void operate(launch)}><Play size={14} aria-hidden="true"/>{busy ? "正在处理…" : "批量启动"}</button></div><div className="official-plugin-actions wechat-setting-row"><span className="wechat-setting-label">运行状态</span><span className="wechat-process-count">{busy ? "检查中…" : status?.supported ? `${status.runningProcesses} 个进程` : "不可用"}</span><button type="button" className="secondary" disabled={!runningInTauri || busy} onClick={() => void operate(() => refresh())}><RefreshCw size={14} aria-hidden="true"/>刷新状态</button></div></fieldset><WechatSessionSettings enabled={supported && config.enabled} busy={busy} path={config.path || status?.detectedPath || ""} operate={operate} notify={notify}/>{!busy && supported && !(config.path || status?.detectedPath) && <p>未找到微信客户端，请先点击“自动检测”或“选择文件”指定客户端路径。</p>}<details><summary>插件权限与说明</summary><ul>{plugin.permissions.map(permission => <li key={permission}>{permission}</li>)}</ul><p>运行状态统计包含微信辅助进程，不代表账号数量。保存配置会读取限定的微信登录配置文件，恢复会写回这些文件；备份使用本机加密保存，不上传，也不在界面显示内容。不读取聊天数据库，不修改客户端程序，不自动结束微信进程。此方式不提供完整的独立聊天数据环境，兼容性需按微信版本实测。</p></details></>;
  return <section id="wechat-store-settings" className="plugin-content wechat-settings-dialog" aria-label="微信多开内容" aria-busy={busy}><div className="plugin-content-body">{body}</div></section>;
}
