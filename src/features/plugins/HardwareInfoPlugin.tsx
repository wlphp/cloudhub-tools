import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Camera, Copy, Cpu, Download, Eye, HardDrive, LayoutDashboard, Monitor, Network, RefreshCw, ShieldCheck, X } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { pluginsClient, type HardwareInfo, type WifiPasswordReveal } from "../../platform/clients/plugins";

interface Props { open: boolean; onOpened: () => void }

const infoPanels = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "hardware", label: "硬件", icon: Cpu },
  { id: "network", label: "网络", icon: Network },
  { id: "devices", label: "设备与电源", icon: ShieldCheck },
] as const;

const hardwareInfoCacheKey = "cloudhub-computer-info-cache-v1";
const autoRefreshRowLabels = new Set(["显示器", "当前 Wi-Fi", "局域网 IPv4"]);

function wifiQrPayload(ssid: string, password: string) {
  const escape = (value: string) => value.replace(/[\\;,:]/g, character => `\\${character}`);
  return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;`;
}

function readHardwareInfoCache(): HardwareInfo | null {
  try {
    const raw = localStorage.getItem(hardwareInfoCacheKey);
    if (!raw || raw.length > 256 * 1024) return null;
    const value = JSON.parse(raw) as HardwareInfo;
    if (typeof value.model !== "string" || typeof value.os !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.sections)) return null;
    return {
      ...value,
      wifiPasswordSupported: value.wifiPasswordSupported === true,
      sections: value.sections.map(section => ({
        ...section,
        rows: section.rows.map(row => ({
          ...row,
          value: row.value || (autoRefreshRowLabels.has(row.label) ? "正在自动更新…" : "未检测到"),
        })),
      })),
    };
  } catch { return null; }
}

function hardwareValues(value: string) {
  return value.split(/[；;\r\n]+/).map(item => item.trim()).filter(Boolean);
}

function formatText(info: HardwareInfo) {
  return [
    "电脑信息",
    "设备型号：" + info.model,
    "系统信息：" + info.os,
    "运行时间：" + info.uptime,
    ...info.sections.flatMap(section => ["", section.title, ...section.rows.flatMap(row => hardwareValues(row.value).map((value, index) => `${index === 0 ? `${row.label}：` : "    "}${value}`))]),
    "",
    "采集时间：" + info.updatedAt,
  ].join("\n");
}

function wrap(ctx: CanvasRenderingContext2D, value: string, maxWidth: number) {
  const result: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = "";
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > maxWidth) { result.push(line); line = char; }
      else line += char;
    }
    result.push(line);
  }
  return result;
}

function renderImage(info: HardwareInfo) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法生成电脑信息图片");
  const width = 1600;
  const panelWidth = 716;
  const groups = [info.sections.slice(0, 2), info.sections.slice(2)];
  // Reserve enough room for CJK strings, which are wider than the Latin-heavy
  // character count estimate; the final renderer still wraps by measured width.
  const estimatedColumnHeight = groups.map(group => group.reduce((total, section) =>
    total + 86 + section.rows.reduce((rows, row) => rows + Math.max(1, Math.ceil(row.value.length / 26)) * 44, 0), 0));
  const height = Math.max(760, 390 + Math.max(...estimatedColumnHeight) + 70);
  canvas.width = width;
  canvas.height = height;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#172b4d");
  gradient.addColorStop(1, "#243b62");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#b9a6ff";
  ctx.font = "700 18px 'Microsoft YaHei', sans-serif";
  ctx.fillText("CLOUDHUB TOOLS  /  SYSTEM", 72, 62);
  ctx.fillStyle = "#f7f8ff";
  ctx.font = "700 38px 'Microsoft YaHei', sans-serif";
  ctx.fillText("电脑信息", 72, 112);
  ctx.fillStyle = "#b9c5d9";
  ctx.font = "16px 'Microsoft YaHei', sans-serif";
  ctx.fillText("采集时间：" + info.updatedAt, 72, 145);

  const summary = [["设备型号", info.model], ["系统信息", info.os], ["运行时间", info.uptime]];
  const gap = 20;
  const cardWidth = (width - 144 - gap * 2) / 3;
  summary.forEach(([label, value], index) => {
    const x = 72 + index * (cardWidth + gap);
    ctx.fillStyle = "rgba(255,255,255,.09)";
    ctx.beginPath(); ctx.roundRect(x, 178, cardWidth, 142, 12); ctx.fill();
    ctx.fillStyle = "#b9a6ff";
    ctx.font = "600 17px 'Microsoft YaHei', sans-serif";
    ctx.fillText(label, x + 24, 215);
    ctx.fillStyle = "#f7f8ff";
    ctx.font = "20px 'Microsoft YaHei', sans-serif";
    wrap(ctx, value, cardWidth - 48).slice(0, 3).forEach((line, row) => ctx.fillText(line, x + 24, 258 + row * 28));
  });

  groups.forEach((group, column) => {
    const x = 72 + column * (panelWidth + 24);
    let y = 350;
    group.forEach(section => {
      const rowLines = section.rows.map(row => wrap(ctx, hardwareValues(row.value).join("\n"), panelWidth - 170));
      const panelHeight = 72 + rowLines.reduce((total, lines) => total + Math.max(1, lines.length) * 44, 0);
      ctx.fillStyle = "rgba(255,255,255,.08)";
      ctx.beginPath(); ctx.roundRect(x, y, panelWidth, panelHeight, 12); ctx.fill();
      ctx.fillStyle = "#f7f8ff";
      ctx.font = "700 21px 'Microsoft YaHei', sans-serif";
      ctx.fillText(section.title, x + 26, y + 42);
      let rowY = y + 82;
      section.rows.forEach((row, index) => {
        const label = row.label + "：";
        ctx.font = "16px 'Microsoft YaHei', sans-serif";
        ctx.fillStyle = "#b9c5d9";
        ctx.fillText(label, x + 28, rowY);
        const labelWidth = ctx.measureText(label).width;
        ctx.fillStyle = "#f7f8ff";
        const lines = wrap(ctx, hardwareValues(row.value).join("\n"), panelWidth - labelWidth - 72);
        lines.forEach((line, lineIndex) => ctx.fillText(line, x + 28 + labelWidth, rowY + lineIndex * 25));
        rowY += Math.max(1, lines.length) * 44;
        if (index < section.rows.length - 1) {
          ctx.strokeStyle = "rgba(255,255,255,.12)";
          ctx.beginPath(); ctx.moveTo(x + 26, rowY - 12); ctx.lineTo(x + panelWidth - 26, rowY - 12); ctx.stroke();
        }
      });
      y += panelHeight + 18;
    });
  });
  ctx.fillStyle = "#aab8d0";
  ctx.font = "14px 'Microsoft YaHei', sans-serif";
  ctx.fillText("由云枢工具箱电脑信息插件生成 · 不含序列号、MAC 地址或 Wi-Fi 密码", 72, height - 34);
  return canvas.toDataURL("image/png");
}

export function HardwareInfoPlugin({ open, onOpened }: Props) {
  const [info, setInfo] = useState<HardwareInfo | null>(() => readHardwareInfoCache());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const [wifiPassword, setWifiPassword] = useState<WifiPasswordReveal | null>(null);
  const [wifiBusy, setWifiBusy] = useState(false);
  const [wifiCopied, setWifiCopied] = useState(false);
  const [wifiError, setWifiError] = useState("");
  const [cameraState, setCameraState] = useState("");
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<(typeof infoPanels)[number]["id"]>("overview");
  const wifiRequestRef = useRef(0);
  const infoRequestRef = useRef(0);
  const cameraRequestRef = useRef(0);
  const panelTabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const dialogRef = useRef<HTMLElement>(null);
  const wifiPasswordButtonRef = useRef<HTMLButtonElement>(null);
  const cameraReturnFocusRef = useRef<HTMLElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const plainText = useMemo(() => info ? formatText(info) : "", [info]);

  function hideWifiPassword() {
    setWifiPassword(null);
    setWifiCopied(false);
    requestAnimationFrame(() => { if (wifiPasswordButtonRef.current?.isConnected) wifiPasswordButtonRef.current.focus(); });
  }
  function stopCamera() {
    cameraRequestRef.current += 1;
    cameraStreamRef.current?.getTracks().forEach(track => track.stop());
    cameraStreamRef.current = null;
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    setCameraOpen(false);
    setCameraBusy(false);
    requestAnimationFrame(() => { if (cameraReturnFocusRef.current?.isConnected) cameraReturnFocusRef.current.focus(); });
  }
  useEffect(() => () => {
    cameraRequestRef.current += 1;
    wifiRequestRef.current += 1;
    infoRequestRef.current += 1;
    cameraStreamRef.current?.getTracks().forEach(track => track.stop());
    cameraStreamRef.current = null;
  }, []);
  useEffect(() => {
    if (!cameraOpen || !cameraVideoRef.current || !cameraStreamRef.current) return;
    cameraVideoRef.current.srcObject = cameraStreamRef.current;
    void cameraVideoRef.current.play().catch(() => setCameraState("预览未能播放，请检查摄像头权限或设备状态。"));
  }, [cameraOpen]);

  async function refresh() {
    const requestId = ++infoRequestRef.current;
    wifiRequestRef.current += 1;
    setBusy(true); setMessage(""); setFailure(""); setWifiPassword(null); setWifiBusy(false); setWifiError(""); setCameraState(""); stopCamera();
    try {
      const latest = await pluginsClient.hardwareInfo();
      if (requestId !== infoRequestRef.current || !open) return;
      setInfo(latest);
      try { localStorage.setItem(hardwareInfoCacheKey, JSON.stringify(latest)); } catch { /* Cache is optional; retain the fresh result in this view. */ }
    }
    catch (reason) { if (requestId === infoRequestRef.current && open) setFailure(reason instanceof Error ? reason.message : "读取电脑信息失败，请重试"); }
    finally { if (requestId === infoRequestRef.current) setBusy(false); }
  }
  async function refreshAutoUpdatedRows() {
    const requestId = ++infoRequestRef.current;
    try {
      const latest = await pluginsClient.hardwareInfo();
      if (requestId !== infoRequestRef.current || !open) return;
      const cached = readHardwareInfoCache();
      if (!cached) return;
      const latestValues = new Map(latest.sections.flatMap(section => section.rows).filter(row => autoRefreshRowLabels.has(row.label)).map(row => [row.label, row.value]));
      const updated: HardwareInfo = {
        ...cached,
        sections: cached.sections.map(section => ({
          ...section,
          rows: section.rows.map(row => latestValues.has(row.label) ? { ...row, value: latestValues.get(row.label)! } : row),
        })),
      };
      setInfo(updated);
      try { localStorage.setItem(hardwareInfoCacheKey, JSON.stringify(updated)); } catch { /* Keep the live values in this view even if the cache cannot be written. */ }
    } catch (reason) {
      if (requestId === infoRequestRef.current && open) setFailure(reason instanceof Error ? `易变信息自动更新失败：${reason.message}` : "易变信息自动更新失败，请稍后手动刷新");
    }
  }
  async function revealWifiPassword() {
    const requestId = ++wifiRequestRef.current;
    setWifiBusy(true); setWifiError(""); setFailure(""); setWifiCopied(false); setWifiPassword(null);
    try { const result = await pluginsClient.revealWifiPassword(); if (requestId === wifiRequestRef.current && open) setWifiPassword(result); }
    catch (reason) { if (requestId === wifiRequestRef.current && open) setFailure(reason instanceof Error ? reason.message : "无法读取当前 Wi-Fi 密码，请确认系统允许查看已保存密码"); }
    finally { if (requestId === wifiRequestRef.current) setWifiBusy(false); }
  }
  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { setCameraState("当前环境不支持摄像头预览。"); return; }
    if (cameraStreamRef.current) stopCamera();
    cameraReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const requestId = ++cameraRequestRef.current;
    setCameraBusy(true); setCameraState("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (requestId === cameraRequestRef.current && open) {
        cameraStreamRef.current = stream;
        setCameraOpen(true);
        setCameraState("");
      } else stream.getTracks().forEach(track => track.stop());
    } catch (reason) {
      const name = reason instanceof DOMException ? reason.name : "";
      if (requestId === cameraRequestRef.current && open) setCameraState(name === "NotAllowedError" || name === "SecurityError" ? "摄像头权限被拒绝。请在系统设置中允许云枢工具箱使用摄像头后重试。" : name === "NotFoundError" ? "未检测到可用摄像头。" : name === "NotReadableError" ? "摄像头被其他应用占用，或设备暂不可用。" : "摄像头无法打开，请检查设备连接和系统权限。");
    } finally { if (requestId === cameraRequestRef.current) setCameraBusy(false); }
  }
  function handlePanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, index: number) {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % infoPanels.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + infoPanels.length) % infoPanels.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = infoPanels.length - 1;
    else return;
    event.preventDefault();
    setActivePanel(infoPanels[nextIndex].id);
    panelTabsRef.current[nextIndex]?.focus();
  }
  useEffect(() => {
    if (!open) {
      infoRequestRef.current += 1;
      setInfo(readHardwareInfoCache());
      wifiRequestRef.current += 1;
      setWifiPassword(null); setWifiBusy(false); setCameraState(""); stopCamera();
      return;
    }
    onOpened();
    const cached = readHardwareInfoCache();
    if (cached) { setInfo(cached); setBusy(false); setFailure(""); void refreshAutoUpdatedRows(); }
    else { setInfo(null); void refresh(); }
  }, [open]);

  async function copyWifiPassword() {
    if (!wifiPassword) return;
    try { await navigator.clipboard.writeText(wifiPassword.password); setWifiCopied(true); setWifiError(""); }
    catch { setWifiError("复制 Wi-Fi 密码失败，请检查系统剪贴板权限。"); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(plainText); setMessage("电脑信息已复制。Wi-Fi 密码不会复制。"); setFailure(""); }
    catch { setFailure("复制失败，请检查系统剪贴板权限。"); }
  }
  async function exportImage() {
    if (!info) return;
    setBusy(true); setMessage(""); setFailure("");
    try {
      const path = await pluginsClient.exportHardwareImage(renderImage(info));
      if (path) setMessage("图片已导出。Wi-Fi 密码不会导出。");
    } catch (reason) { setFailure(reason instanceof Error ? reason.message : "导出图片失败，请重试"); }
    finally { setBusy(false); }
  }
  if (!open) return null;
  const shell = <section ref={dialogRef} className="plugin-content hardware-info-dialog" aria-label="电脑信息内容" aria-busy={busy}>
      <div className="plugin-content-toolbar">
        <button type="button" className="secondary hardware-info-refresh" onClick={() => void refresh()} disabled={busy} aria-label="刷新电脑信息"><RefreshCw size={15} aria-hidden="true" />刷新</button>
      </div>
      <div className="plugin-content-body hardware-info-body">
        <p className="hardware-info-cache-note" role="note">电脑信息会缓存在本设备本地；打开面板先显示缓存，并自动更新外接显示器、当前 Wi-Fi 和局域网 IP。点击右上角“刷新”会重新采集全部信息并更新缓存。{info?.updatedAt && <span> 最近一次完整采集：{info.updatedAt}</span>}</p>
        {failure && <p className="hardware-info-error" role="alert">{failure}</p>}
        {message && <p className="hardware-info-message" role="status">{message}</p>}
        {busy && !info ? <p role="status">正在读取本机电脑信息…</p> : info && <>
          {(() => {
            const hardwareSections = info.sections.filter(section => ["处理器与主板", "内存与显卡", "显示与存储"].includes(section.title));
            const networkSections = info.sections.filter(section => section.title.includes("网络"));
            const deviceSections = info.sections.filter(section => section.title.includes("音频"));
            const getValue = (label: string) => info.sections.flatMap(section => section.rows).find(row => row.label === label)?.value || "未检测到";
            const renderSections = (sections: HardwareInfo["sections"], layout: "hardware" | "single") => <div className={`hardware-info-sections hardware-info-sections--${layout}`}>{sections.map(section => <section key={section.title} aria-label={section.title}>
              <h3>{section.title}</h3>
              <dl>{section.rows.map(row => {
                const values = hardwareValues(row.value);
                return <div key={row.label}><dt>{row.label}</dt><dd>{values.length > 1 ? <ul>{values.map((value, index) => <li key={`${row.label}-${index}`}>{value}</li>)}</ul> : values[0] || "未检测到"}</dd></div>;
              })}</dl>
            </section>)}</div>;
            return <>
              <div className="hardware-info-tabs" role="tablist" aria-label="电脑信息面板" onKeyDown={event => {
                const index = infoPanels.findIndex(panel => panel.id === activePanel);
                handlePanelKeyDown(event, index);
              }}>
                {infoPanels.map((panel, index) => {
                  const Icon = panel.icon;
                  return <button key={panel.id} ref={element => { panelTabsRef.current[index] = element; }} type="button" role="tab" id={`computer-info-tab-${panel.id}`} aria-selected={activePanel === panel.id} aria-controls="computer-info-current-panel" tabIndex={activePanel === panel.id ? 0 : -1} className={activePanel === panel.id ? "is-active" : ""} onClick={() => setActivePanel(panel.id)}>
                    <Icon size={15} aria-hidden="true" />{panel.label}
                  </button>;
                })}
              </div>
              <section className="hardware-info-panel" role="tabpanel" id="computer-info-current-panel" aria-labelledby={`computer-info-tab-${activePanel}`} tabIndex={0}>
                {activePanel === "overview" && <>
                  <div className="hardware-info-summary">
                    <article><span><Monitor size={16} aria-hidden="true" />设备型号</span><strong>{info.model}</strong></article>
                    <article><span><Cpu size={16} aria-hidden="true" />系统信息</span><strong>{info.os}</strong></article>
                    <article><span><HardDrive size={16} aria-hidden="true" />运行时间</span><strong>{info.uptime}</strong></article>
                  </div>
                  <div className="hardware-info-highlights">{[["处理器", getValue("处理器")], ["内存", getValue("内存")], ["显卡", getValue("显卡")], ["当前 Wi-Fi", getValue("当前 Wi-Fi")], ["局域网 IPv4", getValue("局域网 IPv4")], ["电池", getValue("电池")]].map(([label, value]) => <article key={label}><span>{label}</span><strong>{hardwareValues(value).join(" · ")}</strong></article>)}</div>
                </>}
                {activePanel === "hardware" && renderSections(hardwareSections, "hardware")}
                {activePanel === "network" && <>{renderSections(networkSections, "single")}
                  <section className="hardware-info-tool"><div><strong>当前 Wi-Fi 密码</strong><small>点击后显示网络名、密码和连接二维码；关闭弹窗前仅在本机显示，不会进入电脑信息复制或图片导出。</small></div>
                    <button ref={wifiPasswordButtonRef} type="button" className="secondary" onClick={() => void revealWifiPassword()} disabled={!info.wifiPasswordSupported || wifiBusy}><Eye size={14} aria-hidden="true" />{wifiBusy ? "读取中…" : info.wifiPasswordSupported ? "显示密码" : "当前平台暂不支持"}</button>
                  </section>
                </>}
                {activePanel === "devices" && <>{renderSections(deviceSections, "single")}
                  <section className="hardware-info-tool"><div><strong>摄像头预览</strong><small>点击后打开实时预览；不会录制或保存，关闭窗口后立即释放摄像头。</small></div>
                    <button type="button" className="secondary" onClick={() => void openCamera()} disabled={cameraBusy}><Camera size={14} aria-hidden="true" />{cameraBusy ? "正在打开…" : "打开摄像头"}</button>
                    {cameraState && <small className="hardware-info-camera-status" role="status">{cameraState}</small>}
                  </section>
                </>}
              </section>
            </>;
          })()}
          <small className="hardware-info-footnote">电脑型号、系统、硬件、局域网 IP、Wi-Fi 名称与系统代理会在你点击后复制或导出；不含序列号、MAC 地址、Wi-Fi 密码、文件或聊天记录。</small>
          <div className="hardware-info-actions">
            <button type="button" className="secondary" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />复制信息</button>
            <button type="button" className="primary" onClick={() => void exportImage()} disabled={busy}><Download size={14} aria-hidden="true" />导出图片</button>
          </div>
        </>}
      </div>
    </section>;
  return <>{shell}
    {cameraOpen && <SharedDialog title="摄像头实时预览" subtitle="本机实时画面" icon={<Camera size={22} aria-hidden="true" />} className="computer-camera-dialog" bodyClassName="computer-camera-preview" closeLabel="关闭摄像头预览" onClose={stopCamera}
      footer={<><small><ShieldCheck size={14} aria-hidden="true" />实时画面仅在本机显示，不录制、不保存。</small><button type="button" className="secondary" onClick={stopCamera}><X size={15} aria-hidden="true" />关闭预览</button></>}>
      <video ref={cameraVideoRef} autoPlay playsInline muted aria-label="摄像头画面预览" />
    </SharedDialog>}
    {wifiPassword && <SharedDialog title={`${wifiPassword.ssid} 属性`} subtitle="当前已保存的 Wi-Fi 网络" className="wifi-password-dialog" bodyClassName="wifi-password-body" size="small" closeLabel="关闭 Wi-Fi 密码" onClose={hideWifiPassword}
      footer={<button type="button" className="secondary" onClick={hideWifiPassword}>关闭</button>}>
          <div className="wifi-password-value"><span>Wi-Fi 网络密码</span><code>{wifiPassword.password}</code><button type="button" className="secondary" onClick={() => void copyWifiPassword()}><Copy size={14} aria-hidden="true" />复制密码</button></div>
          <div className="wifi-password-qr"><strong>扫描以连接</strong><div><QRCodeSVG value={wifiQrPayload(wifiPassword.ssid, wifiPassword.password)} size={184} level="M" marginSize={2} title="Wi-Fi 连接二维码" /></div><small>使用手机相机扫描二维码即可加入此网络</small></div>
          {wifiCopied && <p className="wifi-password-copied" role="status">密码已复制到剪贴板</p>}
          {wifiError && <p className="hardware-info-error" role="alert">{wifiError}</p>}
          <small className="wifi-password-expiry">密码和二维码仅在本机显示；关闭弹窗后立即清除。</small>
    </SharedDialog>}
  </>;
}
