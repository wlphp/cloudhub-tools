import { useEffect, useRef, useState } from "react";
import { FolderOpen, Play, RefreshCw, Trash2 } from "lucide-react";
import { pluginsClient, type WechatDataDetection, type WechatSession } from "../../platform/clients/plugins";

interface Props {
  enabled: boolean;
  busy: boolean;
  path: string;
  operate: (action: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
}

export function WechatSessionSettings({ enabled, busy, path, operate, notify }: Props) {
  const [items, setItems] = useState<WechatSession[]>([]);
  const [dataPath, setDataPath] = useState(() => {
    try { return localStorage.getItem("wechat-login-data-path") || ""; } catch { return ""; }
  });
  const [label, setLabel] = useState("");
  const [backupId, setBackupId] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [detected, setDetected] = useState<WechatDataDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [batchPace, setBatchPace] = useState("50");
  const batchStopped = useRef(false);
  useEffect(() => {
    batchStopped.current = false;
    return () => { batchStopped.current = true; };
  }, []);
  function matchesClient(family: string) {
    const executable = path.split(/[\\/]/).pop()?.toLowerCase();
    return executable === "weixin.exe" ? family === "微信 4.x" : executable === "wechat.exe" ? family === "微信 3.x" : true;
  }
  function rememberDataPath(selected: string) {
    setDataPath(selected);
    try { localStorage.setItem("wechat-login-data-path", selected); } catch { /* Path persistence is optional. */ }
  }
  async function detectData(browse = false) {
    setDetecting(true);
    try {
      const result = await pluginsClient.detectWechatData(browse);
      if (!result) return;
      setDetected(result);
      const compatible = result.candidates.filter(item => matchesClient(item.family));
      if (compatible.length === 1) {
        rememberDataPath(compatible[0].path);
        notify(`已匹配微信数据目录并填入。${result.limited ? "查找范围较大，仅展示本次已找到的结果。" : ""}`);
      } else if (compatible.length > 1) {
        notify(`找到 ${compatible.length} 个微信数据目录，请在下方选择要使用的目录。`);
      } else if (result.candidates.length > 0) {
        notify("找到了其他微信版本的数据目录，未自动选用。请点击“选择位置查找”，继续匹配当前客户端的数据目录。");
      } else {
        notify(result.limited ? "本次查找已达到范围或时间上限，尚未匹配；请选择更具体的位置继续查找。" : "尚未匹配到可用配置。可点击“选择位置查找”，选择 D 盘等大致位置；未登录过微信时请先登录一次。");
      }
    } finally { setDetecting(false); }
  }
  async function reload() {
    const values = await pluginsClient.wechatSessions();
    setItems(values);
    setBackupId(current => values.some(item => item.id === current && item.recovery) ? current : values.find(item => item.recovery)?.id || "");
    setLoadError(false);
  }
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void pluginsClient.wechatSessions().then(values => {
      if (!active) return;
      setItems(values);
      setBackupId(values.find(item => item.recovery)?.id || "");
      setLoadError(false);
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [enabled]);
  const profiles = items.filter(item => !item.recovery);
  const backups = items.filter(item => item.recovery);
  const launchableProfiles = profiles.filter(item => item.family && matchesClient(item.family));
  async function launchSavedProfiles() {
    const queue = [...launchableProfiles];
    const quickIntervalMs = batchPace === "wait" ? undefined : Number(batchPace);
    const resultUnit = quickIntervalMs === undefined ? "准备" : "提交";
    if (!queue.length || !path) throw new Error("没有与当前客户端匹配的已保存配置。");
    const status = await pluginsClient.wechatStatus();
    if (!status.supported) throw new Error("微信多开插件仅支持 Windows 桌面端");
    if (status.runningProcesses > 0) throw new Error("请先从托盘退出所有微信，再批量启动已保存配置。");
    if (batchStopped.current) return;
    let completed = 0;
    try {
      for (const item of queue) {
        if (batchStopped.current) throw new Error(`已停止后续启动，已${resultUnit} ${completed}/${queue.length} 个${quickIntervalMs === undefined ? "窗口" : "启动请求"}。关闭设置不会关闭已打开的微信。`);
        setBatchProgress({ current: completed + 1, total: queue.length });
        notify(`正在${resultUnit} ${completed + 1}/${queue.length}：“${item.label}”。请等批量任务完成后再检查窗口并登录微信。`);
        try { await pluginsClient.launchWechatSession(item.id, path, quickIntervalMs); }
        catch (reason) {
          throw new Error(`批量启动已停止：已${resultUnit} ${completed}/${queue.length} 个${quickIntervalMs === undefined ? "窗口" : "启动请求"}，在“${item.label}”处失败。${reason instanceof Error ? reason.message : "请检查微信窗口和配置占用状态。"}`);
        }
        completed++;
      }
      if (batchStopped.current) throw new Error(`已停止后续启动，已${resultUnit} ${completed}/${queue.length} 个${quickIntervalMs === undefined ? "窗口" : "启动请求"}。关闭设置不会关闭已打开的微信。`);
      notify(quickIntervalMs === undefined ? `已准备 ${completed}/${queue.length} 个微信窗口，请核对各自头像后分别登录；窗口出现不代表登录成功。` : `已提交 ${completed}/${queue.length} 个快速启动请求，额外间隔 ${quickIntervalMs} 毫秒。请检查实际窗口及头像；请求提交不代表多开或登录成功。`);
    } finally {
      setBatchProgress(null);
      if (!batchStopped.current) {
        try { await reload(); } catch { setLoadError(true); }
      }
    }
  }
  return <fieldset className="wechat-session-settings" disabled={!enabled || busy}>
    <legend>账号登录配置 · 实验性</legend>
    <p>先登录账号 A，从托盘退出全部微信后保存为“A”；再切换登录账号 B，退出后保存为“B”。使用时先逐个恢复并打开所有账号的登录窗口，确认头像后，最后再分别点击微信登录。</p>
    <p className="wechat-session-help">保存的是登录配置，不包含聊天记录。首次登录仍需微信验证，后续免扫码或自动登录由微信决定。配置被占用时请先退出微信。</p>
    <label htmlFor="wechat-data-path">微信数据根目录</label>
    <div className="official-plugin-path">
      <input id="wechat-data-path" readOnly value={dataPath} placeholder="选择 xwechat_files 或 WeChat Files 目录" />
      <button type="button" className="secondary" onClick={() => void operate(() => detectData())}><RefreshCw size={14} aria-hidden="true" />{detecting ? "正在检测…" : "自动检测数据目录"}</button>
      <button type="button" className="secondary" onClick={() => void operate(() => detectData(true))}><FolderOpen size={14} aria-hidden="true" />选择位置查找</button>
      <button type="button" className="secondary" onClick={() => void operate(async () => {
        const selected = await pluginsClient.selectWechatData();
        if (selected) {
          rememberDataPath(selected);
        }
      })}><FolderOpen size={14} aria-hidden="true" />选择数据目录</button>
    </div>
    <p className="wechat-session-help">自动匹配微信保存的位置、文档目录和本地磁盘浅层位置。只检查配置文件是否存在，不读取聊天记录；也可选择一个大致位置继续查找。</p>
    {detected && detected.candidates.length > 0 && <div className="wechat-detected-paths">
      <label htmlFor="wechat-detected-path">匹配的数据目录</label>
      <select id="wechat-detected-path" value={detected.candidates.some(item => item.path === dataPath) ? dataPath : ""} onChange={event => { if (event.target.value) rememberDataPath(event.target.value); }}>
        <option value="" disabled>请选择数据目录</option>
        {detected.candidates.map(item => <option key={item.path} value={item.path} disabled={!matchesClient(item.family)}>{item.family} · {item.path} · {item.source}{matchesClient(item.family) ? "" : " · 与当前客户端版本不匹配"}</option>)}
      </select>
      {dataPath && <small className="wechat-session-help">当前目录：{dataPath}</small>}
      {detected.limited && <small className="wechat-session-help">已达到本次查找上限，列表可能不完整，可缩小范围后继续查找。</small>}
    </div>}
    <div className="wechat-session-capture">
      <label htmlFor="wechat-session-label">配置名称</label>
      <input id="wechat-session-label" maxLength={40} value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：工作号、个人号" />
      <button type="button" className="secondary" disabled={!path || !dataPath || !label.trim() || loadError} onClick={() => void operate(async () => {
        await pluginsClient.captureWechatSession(dataPath, label.trim(), path);
        setLabel("");
        notify("当前账号登录配置已加密保存。请用不同账号分别保存配置。");
        await reload();
      })}>保存当前配置</button>
    </div>
    <div className="wechat-session-list-head"><strong>已保存配置（{profiles.length}）</strong><button type="button" className="secondary" onClick={() => void operate(reload)}><RefreshCw size={14} aria-hidden="true" />刷新配置</button></div>
    {loadError ? <p>配置列表读取失败，请点击“刷新配置”重试。</p> : profiles.length === 0 ? <p className="wechat-session-help">尚未保存账号配置。</p> : <ul className="wechat-session-list">{profiles.map(item => <li key={item.id}>
      <div><strong>{item.label}</strong><small>{item.family || "版本未知，请重启客户端并刷新配置"} · {new Date(item.createdAt * 1000).toLocaleString()} · {item.dataPath}</small>{item.family && !matchesClient(item.family) && <small>与当前客户端版本不匹配，请切换对应客户端或使用当前版本重新保存配置。</small>}</div>
      <div className="wechat-session-row-actions"><button type="button" className="primary" disabled={!path || !item.family || !matchesClient(item.family)} onClick={() => void operate(async () => {
        await pluginsClient.launchWechatSession(item.id, path);
        notify("配置已恢复，已检测到新的微信窗口。请核对头像与账号后再启动下一个；这不代表登录成功。");
        await reload();
      })}><Play size={14} aria-hidden="true" />恢复并启动</button>
      <button type="button" className="secondary" aria-label={`删除配置 ${item.label}`} onClick={() => {
        if (!window.confirm(`删除已保存配置“${item.label}”？仅删除 CloudHub 保存的这份配置快照，不影响微信数据、聊天记录或其他备份。`)) return;
        void operate(async () => {
          await pluginsClient.deleteWechatSession(item.id);
          setItems(current => current.filter(value => value.id !== item.id));
          notify("已删除所选配置快照，微信数据和其他备份未受影响。");
        });
      }}><Trash2 size={14} aria-hidden="true" />删除</button></div>
    </li>)}</ul>}
    <div className="wechat-session-batch">
      <label htmlFor="wechat-batch-pace">启动节奏</label>
      <select id="wechat-batch-pace" value={batchPace} onChange={event => setBatchPace(event.target.value)}>{[0, 20, 50, 100, 200].map(value => <option key={value} value={String(value)}>快速尝试 · {value} 毫秒</option>)}<option value="wait">等待窗口出现</option></select>
      <button type="button" className="primary" disabled={!path || loadError || launchableProfiles.length === 0} onClick={() => void operate(launchSavedProfiles)}><Play size={14} aria-hidden="true" />{batchProgress ? `正在${batchPace === "wait" ? "准备" : "提交"} ${batchProgress.current}/${batchProgress.total}…` : "批量启动已保存配置"}</button>
      <span className="wechat-session-help">按顺序处理 {launchableProfiles.length} 个兼容配置。快速模式不等待窗口，间隔是额外等待时间；可能重复头像，仍保留备份及文件锁检查。遇到失败停止，关闭设置停止后续启动。</span>
    </div>
    {backups.length > 0 && <div className="wechat-session-recovery"><label htmlFor="wechat-recovery">恢复前备份</label><select id="wechat-recovery" value={backupId} onChange={event => setBackupId(event.target.value)}>{backups.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt * 1000).toLocaleString()} · {item.dataPath}</option>)}</select><button type="button" className="secondary" disabled={!backupId} onClick={() => void operate(async () => {
      await pluginsClient.restoreWechatBackup(backupId);
      notify("已恢复所选备份；恢复前的配置也已另存为加密备份。");
      await reload();
    })}>恢复备份</button></div>}
    <small className="wechat-session-help">每次恢复前会在 CloudHub 本地数据目录的 wechat-login-configs 中保存加密备份。不会修改微信 DLL、强制关闭文件句柄或结束微信进程。</small>
  </fieldset>;
}
