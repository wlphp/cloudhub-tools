import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Download, Globe, HardDrive, Monitor, Play, Plus, RefreshCw, RotateCcw, Search, Square, Trash2, X, Pencil, Network, Database, Upload, Eye, EyeOff } from "lucide-react";
import { DialogHeaderActions } from "../../shared/DialogHeaderActions";
import { runningInTauri } from "../../platform/api";
import { browserClient, type BrowserConfig, type BrowserCookie, type BrowserEnvironment, type BrowserSnapshot } from "../../platform/clients/browser";
import "./browser-environments.css";

interface Props { open: boolean; onClose: () => void }
type Tab = "environments" | "kernel" | "trash";
type EditorTab = "basic" | "proxy" | "fingerprint";
const PHASES: Record<string, string> = { idle: "未安装", downloading: "正在下载", verifying: "正在校验", extracting: "正在解压", ready: "已安装", cancelled: "已取消", failed: "安装失败" };
const timestamp = (value: number | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未打开";
const mib = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] || 1;
const blankConfig = (version: string): BrowserConfig => ({ name: "", group: "", tags: "", note: "", kernelVersion: version, startUrls: [], proxy: { kind: "direct", host: "", port: 8080, username: "" }, language: "zh-CN", timezone: "Asia/Shanghai", width: 1280, height: 900, geolocation: null, fingerprint: null, identity: "native" });

export function BrowserEnvironments({ open, onClose }: Props) {
  const dialog = useRef<HTMLElement>(null);
  const cookieDialogRef = useRef<HTMLElement>(null);
  const cookieTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>("environments");
  const [kernelVersion, setKernelVersion] = useState("");
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<{ id: string | null; config: BrowserConfig; passwordSaved: boolean } | null>(null);
  const [editorTab, setEditorTab] = useState<EditorTab>("basic");
  const passwordDraft = useRef<string | null>(null);
  const passwordInput = useRef<HTMLInputElement | null>(null);
  function setPassword(value: string | null) {
    passwordDraft.current = value;
    if (passwordInput.current && (value === null || value === "")) passwordInput.current.value = "";
  }
  const [urls, setUrls] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const refreshRef = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [installing, setInstalling] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  const [proxyResults, setProxyResults] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<{ kind: "kernel" | "environment"; id?: string; name: string } | null>(null);
  const [cookieView, setCookieView] = useState<{ environmentId: string; name: string; items: BrowserCookie[]; revealed: Record<string, boolean> } | null>(null);
  const [confirmationName, setConfirmationName] = useState("");
  const confirmationRef = useRef(confirmation); confirmationRef.current = confirmation;
  const cookieViewRef = useRef(cookieView); cookieViewRef.current = cookieView;
  const cookieViewOpen = cookieView !== null;
  useEffect(() => {
    if (!cookieViewOpen) return;
    const previousFocus = cookieTriggerRef.current;
    const parent = dialog.current;
    if (parent) parent.inert = true;
    cookieDialogRef.current?.focus();
    return () => {
      if (parent) parent.inert = false;
      const fallback = Array.from(parent?.querySelectorAll<HTMLButtonElement>('[data-cookie-environment-id]') ?? [])
        .find(button => button.dataset.cookieEnvironmentId === cookieView?.environmentId);
      (previousFocus?.isConnected ? previousFocus : fallback)?.focus();
    };
  }, [cookieViewOpen]);
  const editorRef = useRef(editor); editorRef.current = editor;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const supported = runningInTauri && snapshot?.supported === true;
  const kernels = snapshot?.kernels ?? (snapshot ? [snapshot.kernel] : []);
  const selectedKernel = kernels.find(item => item.version === kernelVersion) ?? snapshot?.kernel;
  const installedFor = (version: string) => kernels.some(item => item.version === version && item.installed);

  async function refresh(silent = false) {
    if (refreshRef.current) return;
    refreshRef.current = true;
    try { setSnapshot(await browserClient.snapshot()); }
    catch (reason) { if (!silent) setError(reason instanceof Error ? reason.message : "无法读取浏览器环境"); }
    finally { refreshRef.current = false; }
  }
  useEffect(() => {
    if (!open || !runningInTauri) return;
    void refresh(); const timer = window.setInterval(() => void refresh(true), 1500);
    return () => window.clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const root = document.getElementById("root"), inert = root?.inert ?? false;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (root) root.inert = true;
    dialog.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (cookieViewRef.current) setCookieView(null);
      else if (confirmationRef.current) setConfirmation(null);
      else if (editorRef.current) { setEditor(null); setPassword(null); } else closeRef.current();
    };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); setPassword(null); if (root) root.inert = inert; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [open]);

  async function operate(action: () => Promise<void>, success: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); setMessage(success); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请重试"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function edit(environment?: BrowserEnvironment) {
    setEditor(environment ? { id: environment.id, config: structuredClone(environment.config), passwordSaved: environment.passwordSaved }
      : { id: null, config: blankConfig(snapshot?.kernel.version ?? ""), passwordSaved: false });
    setUrls(environment?.config.startUrls.join("\n") ?? ""); setPassword(null); setEditorTab("basic"); setError(""); setMessage("");
  }
  function patch(values: Partial<BrowserConfig>) { setEditor(current => current ? { ...current, config: { ...current.config, ...values } } : null); }
  function confirmRemove(environment?: BrowserEnvironment) { setConfirmation(environment ? { kind: "environment", id: environment.id, name: environment.config.name } : { kind: "kernel", name: selectedKernel?.version ?? "" }); setConfirmationName(""); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!editor) return;
    const config = { ...editor.config, startUrls: urls.split(/\r?\n/).map(v => v.trim()).filter(Boolean) };
    await operate(async () => { await browserClient.save({ id: editor.id, config, proxyPassword: passwordDraft.current }); if (editor.id) setProxyResults(current => { const next = { ...current }; delete next[editor.id!]; return next; }); setEditor(null); setPassword(null); }, "环境已保存");
  }
  async function openCookies(environment: BrowserEnvironment, trigger: HTMLButtonElement) {
    if (busyRef.current) return;
    cookieTriggerRef.current = trigger;
    await operate(async () => {
      const items = await browserClient.cookies(environment.id);
      setCookieView({ environmentId: environment.id, name: environment.config.name, items, revealed: {} });
    }, "已读取当前环境的 Cookie 数据");
  }
  async function install(offline = false) {
    if (installing) return;
    setInstalling(true); setError(""); setMessage("");
    try {
      if (!selectedKernel) throw new Error("请先读取内核目录");
      const result = offline ? await browserClient.importKernel(selectedKernel.version) : await browserClient.install(selectedKernel.version);
      if (result !== false) setMessage("浏览器内核已校验并安装，各环境共用此内核");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "内核安装失败"); }
    finally { setInstalling(false); await refresh(); }
  }
  const kernelBusy = installing || kernels.some(item => ["downloading", "verifying", "extracting"].includes(item.phase));
  const items = (snapshot?.environments ?? []).filter(item => Boolean(item.deletedAt) === (tab === "trash")
    && (!group || item.config.group === group) && `${item.config.name} ${item.config.group} ${item.config.tags} ${item.config.note}`.toLowerCase().includes(keyword.toLowerCase()));
  const groups = [...new Set((snapshot?.environments ?? []).filter(item => Boolean(item.deletedAt) === (tab === "trash")).map(item => item.config.group).filter(Boolean))];
  const selectedItems = items.filter(item => selected.includes(item.id));
  async function batch(action: "launch" | "stop" | "trash" | "restore") {
    const targets = selectedItems.slice();
    let completed = 0;
    await operate(async () => {
      for (const item of targets) {
        try {
          if (action === "launch" && !item.running) await browserClient.launch(item.id);
          else if (action === "stop" && item.running) await browserClient.stop(item.id);
          else if (action === "trash" || action === "restore") await browserClient.setDeleted(item.id, action === "trash");
          completed++;
        } catch (reason) { await refresh(); throw new Error(`已处理 ${completed}/${targets.length} 个环境。${reason instanceof Error ? reason.message : "操作失败"}`); }
      }
      setSelected([]);
    }, "批量操作已完成");
  }
  if (!open) return null;
  const config = editor?.config;
  const cookieDialog = cookieView ? createPortal(<div className="modal-backdrop ide-theme cookie-view-backdrop">
    <section ref={cookieDialogRef} className="modal modal-form-layout dialog-common-theme cookie-view-dialog" role="dialog" aria-modal="true" aria-labelledby="cookie-view-title" aria-label="Cookie 原始数据" tabIndex={-1} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setCookieView(null); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <header className="modal-head official-plugin-heading"><Database size={22} aria-hidden="true" /><div><h2 id="cookie-view-title">Cookie 原始数据</h2><p>{cookieView.name}</p></div><DialogHeaderActions><button type="button" className="icon-button" aria-label="关闭 Cookie 数据" title="关闭" onClick={() => setCookieView(null)}><X size={18} /></button></DialogHeaderActions></header>
      <div className="modal-body cookie-view-body">
        <p className="browser-notice" role="status">Cookie 值默认隐藏，包含登录凭据，请勿分享。</p>
        {cookieView.items.length === 0 ? <p role="status">当前环境还没有保存任何 Cookie。</p> : <div className="cookie-view-scroll"><table className="browser-table"><thead><tr><th>域名</th><th>名称</th><th>值</th><th>过期</th><th>标志</th></tr></thead><tbody>
          {cookieView.items.map((cookie, index) => { const key = `${index}:${cookie.domain}:${cookie.name}`; const shown = cookieView.revealed[key] === true; return <tr key={key}>
            <td data-label="域名">{cookie.domain}<small>{cookie.path}</small></td>
            <td data-label="名称"><code>{cookie.name}</code></td>
            <td data-label="值"><div className="cookie-value-cell">{cookie.valueUnavailable ? <em>无法解密此条目</em> : shown ? <code className="cookie-view-value">{cookie.value}</code> : <span aria-hidden="true">••••••</span>}{!cookie.valueUnavailable && <button type="button" aria-expanded={shown} onClick={() => setCookieView(current => current ? { ...current, revealed: { ...current.revealed, [key]: !shown } } : current)} aria-label={shown ? "隐藏" : "显示"} title={shown ? "隐藏 Cookie 值" : "显示 Cookie 值"}>{shown ? <EyeOff size={15} /> : <Eye size={15} />}</button>}</div></td>
            <td data-label="过期">{cookie.session ? "会话结束时" : cookie.expires ? new Date(cookie.expires * 1000).toLocaleString("zh-CN", { hour12: false }) : "—"}</td>
            <td data-label="标志">{cookie.secure ? "Secure " : ""}{cookie.httpOnly ? "HttpOnly " : ""}{cookie.sameSite ?? ""}</td>
          </tr>; })}
        </tbody></table></div>}
      </div>
      <footer className="modal-actions"><span>共 {cookieView.items.length} 条</span><button type="button" className="secondary" onClick={() => setCookieView(current => current ? { ...current, revealed: {} } : current)}>全部隐藏</button><button type="button" className="primary" onClick={() => setCookieView(null)}>关闭</button></footer>
    </section>
  </div>, document.body) : null;
  return <>{cookieDialog}{createPortal(<div className="modal-backdrop ide-theme">
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="browser-title" className="modal modal-form-layout browser-dialog" onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button,input,textarea,select,[tabindex="0"]')).filter(el => !el.matches(":disabled") && el.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
    }}>
      <header className="modal-head official-plugin-heading"><Globe size={22} aria-hidden="true" /><div><h2 id="browser-title">指纹浏览器</h2><p>本地环境管理</p></div><DialogHeaderActions><button type="button" className="icon-button" aria-label="关闭指纹浏览器" title="关闭" onClick={() => { setPassword(null); onClose(); }}><X size={18} /></button></DialogHeaderActions></header>
      <div className="modal-body browser-body">
        {!supported && <p className="browser-notice" role="status">{!runningInTauri ? "此功能需要 Windows x64 桌面客户端，浏览器预览不能下载或启动本机浏览器。" : snapshot ? "当前系统暂不支持浏览器环境，请使用 Windows x64 客户端。" : "正在读取本机浏览器环境…"}</p>}
        {error && <p className="browser-error" role="alert">{error}</p>}{message && <p className="browser-notice" role="status">{message}</p>}
        {confirmation && <section className="browser-confirm" aria-label="删除确认"><h3>{confirmation.kind === "kernel" ? `卸载浏览器内核 ${confirmation.name}` : `永久删除 ${confirmation.name}`}</h3><p>{confirmation.kind === "kernel" ? "卸载前需要关闭所有环境。环境配置、Cookie 和登录资料保留，可重新安装相同版本内核。" : "此操作将永久删除该环境的 Cookie、缓存及本地资料，无法恢复。请输入完整环境名称确认。"}</p>{confirmation.kind === "environment" && <label>确认环境名称<input aria-label="确认环境名称" value={confirmationName} onChange={e => setConfirmationName(e.target.value)} /></label>}<div className="browser-toolbar"><button type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消删除</button><button type="button" disabled={busy || confirmation.kind === "environment" && confirmationName !== confirmation.name} onClick={() => void operate(async () => { if (confirmation.kind === "kernel") await browserClient.uninstallKernel(confirmation.name); else await browserClient.remove(confirmation.id!, confirmationName); setConfirmation(null); }, confirmation.kind === "kernel" ? "内核已卸载，环境资料保留" : "环境及本地资料已永久删除")}>确认{confirmation.kind === "kernel" ? "卸载内核" : "永久删除"}</button></div></section>}
        {editor && config ? <form id="browser-environment-form" onSubmit={event => void save(event)} className="browser-editor">
          <div className="browser-toolbar"><button type="button" onClick={() => { setEditor(null); setPassword(null); }} disabled={busy}><ArrowLeft size={15} />环境列表</button><strong>{editor.id ? "编辑环境" : "新建环境"}</strong></div>
          <div className="browser-editor-grid"><div>
            <div className="browser-tabs" role="tablist" aria-label="环境设置">{([["basic", "基础设置"], ["proxy", "代理信息"], ["fingerprint", "环境参数"]] as const).map(([value, label]) => <button type="button" role="tab" aria-selected={editorTab === value} aria-controls={`browser-panel-${value}`} id={`browser-tab-${value}`} key={value} onClick={() => setEditorTab(value)}>{label}</button>)}</div>
            <fieldset disabled={busy || !supported} className="browser-fields" role="tabpanel" id={`browser-panel-${editorTab}`} aria-labelledby={`browser-tab-${editorTab}`}>
              {editorTab === "basic" && <>
                <label>名称<input required maxLength={100} value={config.name} onChange={e => patch({ name: e.target.value })} /></label>
                <label>分组<input maxLength={60} list="browser-groups" value={config.group} onChange={e => patch({ group: e.target.value })} /><datalist id="browser-groups">{groups.map(value => <option key={value} value={value} />)}</datalist></label>
                <label>浏览器内核<select aria-label="浏览器内核" value={config.kernelVersion} disabled={!!editor.id && !!snapshot?.environments.find(item => item.id === editor.id)?.lastOpenedAt} onChange={e => patch({ kernelVersion: e.target.value, fingerprint: kernels.find(item => item.version === e.target.value)?.experimental ? { seed: newSeed(), canvasNoise: true, hardwareConcurrency: 4, deviceMemory: 8 } : null })}>{kernels.map(item => <option key={item.version} value={item.version}>{item.version} · {item.label || "审核版本"}</option>)}</select><small>同版本环境共用内核；已打开过的环境固定版本。升级请新建环境，原环境及资料保留。</small></label>
                {config.fingerprint && <p className="browser-notice">实验版 Chromium 150 落后于推荐内核；仅用于测试环境。已验证 Canvas 种子与 CPU / 内存参数，GPU 保留真实值；音频、字体和矩形噪声未提供。</p>}
                <label>标签<input maxLength={250} value={config.tags} onChange={e => patch({ tags: e.target.value })} placeholder="多个标签用逗号分隔" /></label>
                <label>启动网址<textarea rows={4} value={urls} onChange={e => setUrls(e.target.value)} placeholder="每行一个 HTTP 或 HTTPS 地址，最多 20 个" /></label>
                <label>备注<textarea rows={3} maxLength={2000} value={config.note} onChange={e => patch({ note: e.target.value })} /></label>
              </>}
              {editorTab === "proxy" && <>
                <label>代理类型<select value={config.proxy.kind} onChange={e => { patch({ proxy: { ...config.proxy, kind: e.target.value as BrowserConfig["proxy"]["kind"] } }); setPassword(null); }}><option value="direct">直接连接</option><option value="http">HTTP</option><option value="https">HTTPS（TLS 上游，校验证书）</option><option value="socks5">SOCKS5（远程 DNS）</option></select></label>
                {config.proxy.kind !== "direct" && <>
                  <label>代理主机<input required value={config.proxy.host} onChange={e => patch({ proxy: { ...config.proxy, host: e.target.value } })} placeholder="127.0.0.1 或 proxy.example.com" /></label>
                  <label>代理端口<input required type="number" min={1} max={65535} value={config.proxy.port} onChange={e => patch({ proxy: { ...config.proxy, port: Number(e.target.value) } })} /></label>
                  <label>代理账号<input autoComplete="off" maxLength={255} value={config.proxy.username} onChange={e => patch({ proxy: { ...config.proxy, username: e.target.value } })} /></label>
                  <label>代理密码<input type="password" autoComplete="new-password" maxLength={255} ref={element => { passwordInput.current = element; if (element && element.value !== (passwordDraft.current ?? "")) element.value = passwordDraft.current ?? ""; }} onChange={e => setPassword(e.target.value)} placeholder={editor.passwordSaved ? "已保存，留空保留；修改代理地址或账号会清除旧密码" : "可选"} />{editor.passwordSaved && <button type="button" onClick={() => setPassword("")}>清除已保存密码</button>}</label>
                  <p className="browser-notice">此环境通过独立代理通道连接；代理失败不自动切换直连。WebRTC 限制非代理 UDP，QUIC 已关闭。</p>
                </>}
                {config.proxy.kind === "direct" && <p className="browser-notice">此环境使用本机网络，网站可以看到本机公网 IP。</p>}
              </>}
              {editorTab === "fingerprint" && <>
                <label>User-Agent 模板<select aria-label="User-Agent 模板" value={config.identity ?? "native"} onChange={e => patch({ identity: e.target.value as BrowserConfig["identity"] })}><option value="native">真实系统与内核</option><option value="windows10">Windows 10 / x64</option><option value="windows11">Windows 11 / x64</option></select><small>保留内核原生报告的版本和品牌；模板同步设置 Windows Client Hints，不模拟其他系统。</small></label>
                <label>语言<input required maxLength={35} value={config.language} onChange={e => patch({ language: e.target.value })} placeholder="zh-CN / en-US" /></label>
                <label>时区<input maxLength={80} value={config.timezone} onChange={e => patch({ timezone: e.target.value })} placeholder="留空使用本机时区，例如 Asia/Shanghai" /></label>
                <label>地理位置<select value={config.geolocation ? "custom" : "blocked"} onChange={e => patch({ geolocation: e.target.value === "custom" ? { latitude: 0, longitude: 0, accuracy: 100 } : null })}><option value="blocked">禁止获取位置</option><option value="custom">自定义位置（网站仍需询问权限）</option></select></label>
                {config.geolocation && <><label>纬度<input type="number" required min={-90} max={90} step="any" value={config.geolocation.latitude} onChange={e => patch({ geolocation: { ...config.geolocation!, latitude: Number(e.target.value) } })} /></label><label>经度<input type="number" required min={-180} max={180} step="any" value={config.geolocation.longitude} onChange={e => patch({ geolocation: { ...config.geolocation!, longitude: Number(e.target.value) } })} /></label><label>定位精度（米）<input type="number" required min={0} max={10000} step="any" value={config.geolocation.accuracy} onChange={e => patch({ geolocation: { ...config.geolocation!, accuracy: Number(e.target.value) } })} /></label></>}
                <label>窗口宽度<input required type="number" min={640} max={7680} value={config.width} onChange={e => patch({ width: Number(e.target.value) })} /></label>
                <label>窗口高度<input required type="number" min={480} max={4320} value={config.height} onChange={e => patch({ height: Number(e.target.value) })} /></label>
                {config.fingerprint ? <>
                  <label>指纹种子<input aria-label="指纹种子" required type="number" min={1} max={4294967295} step={1} value={config.fingerprint.seed} onChange={e => patch({ fingerprint: { ...config.fingerprint!, seed: Number(e.target.value) } })} /><button type="button" onClick={() => patch({ fingerprint: { ...config.fingerprint!, seed: newSeed() } })}>生成新种子</button><small>同一环境保留种子；更换种子不会清空 Cookie 或登录资料。</small></label>
                  <label>Canvas<select aria-label="Canvas" value={config.fingerprint.canvasNoise ? "seed" : "real"} onChange={e => patch({ fingerprint: { ...config.fingerprint!, canvasNoise: e.target.value === "seed" } })}><option value="seed">按固定种子生成噪声</option><option value="real">真实渲染结果</option></select></label>
                  <label>CPU 逻辑核数<input required type="number" min={1} max={64} step={1} value={config.fingerprint.hardwareConcurrency} onChange={e => patch({ fingerprint: { ...config.fingerprint!, hardwareConcurrency: Number(e.target.value) } })} /></label>
                  <label>设备内存（GB）<select aria-label="设备内存（GB）" value={config.fingerprint.deviceMemory} onChange={e => patch({ fingerprint: { ...config.fingerprint!, deviceMemory: Number(e.target.value) } })}>{[2,4,8,16,32].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
                  <p className="browser-notice">实验内核使用真实 GPU；音频、字体、ClientRects 噪声及跨系统模拟未开放。种子效果不能保证避免平台关联识别。</p>
                </> : <p className="browser-notice">浏览器 UA 及品牌跟随内核，系统版本按所选模板设置。硬件和字体使用真实值。需要种子配置时，可为新环境选择 Clearcote 实验内核。</p>}
              </>}
            </fieldset>
          </div><aside className="browser-summary"><h3>环境概要</h3><dl><dt>浏览器</dt><dd>Chrome {config.kernelVersion}</dd><dt>数据</dt><dd>独立 Cookie、缓存与本地存储</dd><dt>代理</dt><dd>{config.proxy.kind === "direct" ? "直接连接" : `${config.proxy.kind.toUpperCase()} · ${config.proxy.host || "待设置"}:${config.proxy.port}`}</dd><dt>系统模板</dt><dd>{config.identity === "windows10" ? "Windows 10 / x64" : config.identity === "windows11" ? "Windows 11 / x64" : "真实系统"}</dd><dt>语言</dt><dd>{config.language}</dd><dt>时区</dt><dd>{config.timezone || "本机时区"}</dd><dt>窗口</dt><dd>{config.width} × {config.height}</dd><dt>硬件参数</dt><dd>{config.fingerprint ? `${config.fingerprint.hardwareConcurrency} 核 / ${config.fingerprint.deviceMemory} GB · GPU 真实` : "真实值"}</dd><dt>Canvas</dt><dd>{config.fingerprint?.canvasNoise ? `固定种子 ${config.fingerprint.seed}` : "真实值"}</dd></dl><p>配置保存在本机。更改参数后需关闭并重新打开环境。</p></aside></div>
        </form> : <>
          <nav className="browser-tabs" aria-label="浏览器管理">{([["environments", "环境列表"], ["kernel", "内核管理"], ["trash", "回收站"]] as const).map(([value,label]) => <button key={value} type="button" aria-current={tab === value ? "page" : undefined} className={tab === value ? "is-active" : ""} onClick={() => { setTab(value); setSelected([]); setGroup(""); setKeyword(""); }}>{label}</button>)}</nav>
          {tab === "kernel" ? <div className="browser-kernel"><div className="browser-kernel-heading"><HardDrive size={24} aria-hidden="true" /><div><h3>浏览器内核</h3><span>Windows x64</span></div><span className={`browser-state ${selectedKernel?.installed ? "is-running" : ""}`}>{selectedKernel?.installed ? "已安装" : PHASES[selectedKernel?.phase ?? "idle"]}</span></div><label>内核版本<select aria-label="管理内核版本" value={selectedKernel?.version ?? ""} disabled={kernelBusy} onChange={e => setKernelVersion(e.target.value)}>{kernels.map(item => <option key={item.version} value={item.version}>{item.version} · {item.label || "审核版本"}{item.installed ? " · 已安装" : ""}</option>)}</select></label><h3>{selectedKernel?.experimental ? "Clearcote 实验内核" : "Chrome for Testing"} {selectedKernel?.version ?? ""}</h3><p>Windows x64 · {selectedKernel?.experimental ? "Clearcote 官方 GitHub Release · BSD-3-Clause" : "Google 官方来源"} · 固定 SHA-256 校验</p>{selectedKernel?.experimental && <p className="browser-notice">基于 Chromium 150，落后于推荐内核，仅用于测试。支持固定 Canvas 种子、CPU 核数与内存参数；其他深层能力未开放。Client Hints 原生报告补丁版本为 150.0.7871.115；安装目录附许可说明。</p>}<p>CloudHub 安装包不携带浏览器。内核下载一次，由多个环境共用。</p><dl><dt>下载大小</dt><dd>{selectedKernel ? mib(selectedKernel.total) : "约 197 MiB"}</dd><dt>磁盘空间</dt><dd>安装期间建议预留 1.5 GiB，环境缓存另计</dd><dt>状态</dt><dd>{selectedKernel?.installed ? "已安装" : PHASES[selectedKernel?.phase ?? "idle"]}</dd></dl>
            {kernelBusy && <div role="status"><progress max={selectedKernel?.total || 1} value={selectedKernel?.downloaded ?? 0} aria-label="内核下载进度" /><span>{PHASES[selectedKernel?.phase ?? "downloading"]} · {mib(selectedKernel?.downloaded ?? 0)}</span></div>}
            {selectedKernel?.error && <p role="alert" className="browser-error">{selectedKernel?.error}</p>}
            <div className="browser-toolbar"><button type="button" className="primary" disabled={!supported || kernelBusy || selectedKernel?.installed} onClick={() => void install()}><Download size={15} />{selectedKernel?.installed ? "已安装" : "下载并安装"}</button><button type="button" disabled={!supported || kernelBusy || selectedKernel?.installed} onClick={() => void install(true)}>导入匹配离线 ZIP</button>{kernelBusy && <button type="button" onClick={() => void operate(() => browserClient.cancelInstall(), "已请求取消安装")}>取消安装</button>}<button type="button" disabled={!supported || busy || kernelBusy} onClick={() => confirmRemove()}>清理 / 卸载内核</button></div>
            <small>离线包必须与上方版本和平台完全一致。内核升级随应用审核更新，已使用的环境固定版本，避免降级损坏资料。</small>
          </div> : <>
            {(tab !== "trash" || snapshot?.environments.some(item => item.deletedAt)) && <div className="browser-toolbar browser-list-toolbar"><label className="browser-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索浏览器环境" placeholder="搜索名称、分组、标签、备注" value={keyword} onChange={e => setKeyword(e.target.value)} /></label><select aria-label="筛选分组" value={group} onChange={e => setGroup(e.target.value)}><option value="">全部分组</option>{groups.map(value => <option key={value}>{value}</option>)}</select><button type="button" aria-label="刷新浏览器环境" title="刷新" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} /></button>{tab === "environments" && <button type="button" className="primary" disabled={!supported || busy} onClick={() => edit()}><Plus size={15} />新建环境</button>}</div>}
            {tab === "environments" && !kernels.some(item => item.installed) && <p className="browser-notice">首次打开环境前需要安装浏览器内核。<button type="button" onClick={() => setTab("kernel")}>前往内核管理</button></p>}
            {selectedItems.length > 0 && <div className="browser-toolbar"><span>已选 {selectedItems.length} 个</span>{tab === "trash" ? <button type="button" disabled={busy} onClick={() => void batch("restore")}><RotateCcw size={14} />恢复</button> : <><button type="button" disabled={busy || selectedItems.some(item => !installedFor(item.config.kernelVersion))} onClick={() => void batch("launch")}><Play size={14} />打开</button><button type="button" disabled={busy} onClick={() => void batch("stop")}><Square size={14} />关闭</button><button type="button" disabled={busy || selectedItems.some(i => i.running)} onClick={() => void batch("trash")}><Trash2 size={14} />移入回收站</button><input aria-label="目标分组" placeholder="目标分组，留空为未分组" maxLength={60} value={groupDraft} onChange={e => setGroupDraft(e.target.value)} /><button type="button" disabled={busy || selectedItems.some(i => i.running)} onClick={() => void operate(() => browserClient.moveGroup(selectedItems.map(i => i.id), groupDraft), "选中环境已移动分组")}>移动分组</button></>}</div>}
            <div className="browser-table-wrap">{items.length > 0 && <table className="browser-table"><thead><tr><th><input type="checkbox" aria-label="选择全部环境" checked={items.length > 0 && items.every(i => selected.includes(i.id))} onChange={e => setSelected(e.target.checked ? items.map(i => i.id) : [])} /></th><th>环境名称</th><th>分组 / 标签</th><th>代理</th><th>最近打开</th><th>状态</th><th>操作</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><input type="checkbox" aria-label={`选择 ${item.config.name}`} checked={selected.includes(item.id)} onChange={e => setSelected(current => e.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /></td><td data-label="环境名称"><strong>{item.config.name}</strong><small>{item.config.note || "无备注"}</small></td><td data-label="分组 / 标签">{item.config.group || "未分组"}<small>{item.config.tags || "—"}</small></td><td data-label="代理">{item.config.proxy.kind === "direct" ? "直接连接" : `${item.config.proxy.host}:${item.config.proxy.port}`}<small>{proxyResults[item.id] || "出口 IP 未检测"}</small></td><td data-label="最近打开">{timestamp(item.lastOpenedAt)}</td><td data-label="状态"><span className={`browser-state ${item.running ? "is-running" : item.recoveryRequired ? "needs-recovery" : ""}`}>{item.recoveryRequired ? "遗留进程待关闭" : item.running ? "运行中" : item.deletedAt ? "回收站" : "已关闭"}</span></td><td data-label="操作"><div className="browser-row-actions">{tab === "trash" ? <><button type="button" disabled={busy} onClick={() => void operate(() => browserClient.setDeleted(item.id, false), "环境已恢复")}>恢复</button><button type="button" disabled={busy} onClick={() => confirmRemove(item)}>永久删除</button></> : <><button type="button" disabled={busy || !supported || !item.running && !installedFor(item.config.kernelVersion)} onClick={() => void operate(() => item.running ? browserClient.stop(item.id) : browserClient.launch(item.id), item.running ? "浏览器已关闭" : "浏览器已打开")}>{item.recoveryRequired ? "关闭遗留进程" : item.running ? "关闭" : "打开"}</button><button type="button" className="browser-icon-action" aria-label="编辑" title="编辑" disabled={busy || item.running} onClick={() => edit(item)}><Pencil size={15} aria-hidden="true" /></button><button type="button" className="browser-icon-action" aria-label="回收" title="回收" disabled={busy || item.running} onClick={() => void operate(() => browserClient.setDeleted(item.id, true), "环境已移入回收站，资料保留")}><Trash2 size={15} aria-hidden="true" /></button><button type="button" className="browser-icon-action" aria-label="检测出口 IP" title="通过当前连接访问 ipify 检测出口 IP" disabled={busy || !supported} onClick={() => void operate(async () => { const ip = await browserClient.checkProxy(item.id); setProxyResults(current => ({ ...current, [item.id]: ip })); }, "出口 IP 检测完成")}><Network size={15} aria-hidden="true" /></button><button type="button" className="browser-icon-action" aria-label="查看数据" disabled={busy || !supported} title="查看当前环境已保存的 Cookie 原始数据（运行中读取实时数据，已关闭时读取本地资料）" data-cookie-environment-id={item.id} onClick={event => void openCookies(item, event.currentTarget)}><Database size={15} aria-hidden="true" /></button>{item.running && <><button type="button" className="browser-icon-action" aria-label="导入 Cookie" title="导入 Cookie" disabled={busy} onClick={() => void operate(async () => { await browserClient.cookieFile(item.id, false); }, "Cookie 文件操作已结束")}><Upload size={15} aria-hidden="true" /></button><button type="button" className="browser-icon-action" aria-label="导出 Cookie" title="导出 Cookie" disabled={busy} onClick={() => void operate(async () => { await browserClient.cookieFile(item.id, true); }, "Cookie 文件操作已结束；导出文件包含登录资料，请妥善保管")}><Download size={15} aria-hidden="true" /></button></>}</>}</div></td></tr>)}</tbody></table>}{items.length === 0 && <div className="browser-empty"><Monitor size={32} aria-hidden="true" /><strong>{keyword || group ? "未找到匹配环境" : tab === "trash" ? "回收站为空" : "创建第一个浏览器环境"}</strong><p>{tab === "trash" ? "移入回收站的环境可以恢复，登录资料保留。" : "每个环境拥有独立的登录状态、代理及本地资料。"}</p></div>}</div>
          </>}
        </>}
      </div>
      <footer className="modal-actions browser-footer"><span>{snapshot?.environments.filter(i => !i.deletedAt).length ?? 0} 个环境 · {snapshot?.environments.filter(i => i.running).length ?? 0} 个运行中</span>{editor ? <div className="browser-row-actions"><button type="button" disabled={busy} onClick={() => { setEditor(null); setPassword(null); }}>取消</button><button type="submit" form="browser-environment-form" className="primary" disabled={busy || !supported}>{busy ? "保存中…" : "保存环境"}</button></div> : <button type="button" onClick={onClose}>关闭</button>}</footer>
    </section>
  </div>, document.body)}</>;
}
