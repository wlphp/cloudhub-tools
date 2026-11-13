import { useRef, useState } from "react";
import { cloudflareClient } from "../../platform/clients/cloudflare";
import { SharedDialog } from "../../shared/SharedDialog";

export function CloudflareWorkerCreate({ accountId, onClose, onCreated, onConfirm }: {
  accountId: number; onClose: () => void; onCreated: () => Promise<void>; onConfirm: (message: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ url?: string; warning?: string } | null>(null);
  const [syncWarning, setSyncWarning] = useState("");
  const lock = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const closing = useRef(false);

  async function close() {
    if (busy || closing.current) return;
    closing.current = true;
    try {
      if (!result && (name.trim() || code.trim()) && !(await onConfirm("代码尚未部署，关闭后填写的名称和代码将丢失。确定放弃并关闭？"))) return;
      onClose();
    } finally { closing.current = false; }
  }

  async function create() {
    if (lock.current || result) return;
    if (!code.trim() || new TextEncoder().encode(code).length > 1024 * 1024 || code.includes("\0")) {
      setError("代码不能为空，且不能超过 1 MiB 或包含空字符。");
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    lock.current = true; setBusy(true); setError("");
    try {
      const created = await cloudflareClient.manage(accountId, "worker_create", { name, code });
      setResult(created);
      setCode("");
      try { await onCreated(); }
      catch { setSyncWarning("Worker 已创建，但列表刷新失败，请关闭后同步当前分类。"); }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message.includes("不支持的 Cloudflare 操作")
        ? "当前运行的后端尚不支持新建 Worker。请重新编译并重启桌面开发程序；若使用浏览器预览，请重启本地 API 服务后重试。"
        : /超时|timeout|网络请求失败/i.test(message)
          ? `${message}。请先同步 Workers 确认云端状态，再决定是否重试。`
          : message);
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally { lock.current = false; setBusy(false); }
  }

  return <SharedDialog title="新建 Worker" className="cloudflare-worker-create" sizeStorageKey="cloudflare-worker-create"
    onClose={() => void close()} closeDisabled={busy} busy={busy} initialFocus="input[name=workerName]"
    onSubmit={event => { event.preventDefault(); void create(); }}
    footer={<><button type="button" className="secondary" disabled={busy} onClick={() => void close()}>{result ? "关闭" : "取消"}</button>
      {!result && <button type="submit" className="primary" disabled={busy}>{busy ? "正在创建并部署…" : "创建并部署"}</button>}</>}>
    {error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-text">{error}</p>}
    {result ? <div className="cloudflare-worker-result">
      <p role="status">Worker {name} 代码已创建并部署。</p>
      {result.url && <label>访问地址<input aria-label="Worker 访问地址" readOnly value={result.url} onFocus={event => event.target.select()} /></label>}
      {result.url && <p>地址已启用，首次访问可能需要等待生效。</p>}
      {result.warning && <p role="alert">{result.warning}</p>}
      {syncWarning && <p role="alert">{syncWarning}</p>}
      <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">前往 Cloudflare 控制台 ↗</a>
    </div> : <>
      <p className="security-tip">将向当前账号部署代码并开启公开的 workers.dev 地址。Token 需具备 Workers Scripts Read / Write 权限；同名资源会阻止创建。</p>
      <div className="cloudflare-worker-fields">
        <label>Worker 名称<input name="workerName" required maxLength={63} pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" title="1–63 位小写字母、数字或连字符，首尾不能为连字符" placeholder="例如 my-worker" value={name} disabled={busy} onChange={event => setName(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        <label>JavaScript 模块代码<textarea required rows={14} value={code} disabled={busy} onChange={event => setCode(event.target.value)} placeholder="在此粘贴完整的 Worker JavaScript 模块代码" spellCheck={false} autoComplete="off" /></label>
      </div>
      <details><summary>代码格式与部署说明</summary><p>请粘贴完整的单文件 JavaScript ES 模块，入口使用 export default。暂不支持多文件、npm 依赖构建、传统 addEventListener 格式、资源绑定或自定义域名。粘贴的代码只用于本次部署，不写入本地缓存或日志。首次使用 Workers 时，请先在控制台配置账号的 workers.dev 子域名。使用受 Cloudflare 套餐配额和计费规则约束。</p></details>
    </>}
  </SharedDialog>;
}
