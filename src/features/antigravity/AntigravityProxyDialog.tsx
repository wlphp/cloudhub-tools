import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { platformErrorMessage, runningInTauri } from "../../platform/api";
import { codexClient } from "../../platform/clients/codex";
import { SharedDialog } from "../../shared/SharedDialog";

export function AntigravityProxyDialog({ label, initialUrl, mixed, onSave, onClose }: {
  label: string;
  initialUrl: string;
  mixed: boolean;
  onSave: (url: string) => Promise<void>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<"detect" | "save" | null>(null);
  const [candidates, setCandidates] = useState<Awaited<ReturnType<typeof codexClient.detectProxies>>>([]);

  function changeUrl(value: string) {
    setUrl(value);
    setEdited(true);
    setError("");
  }

  async function detect() {
    setError("");
    setStatus("");
    setCandidates([]);
    if (!runningInTauri) {
      setStatus("浏览器预览可手动填写代理地址，本机检测由桌面客户端提供。");
      return;
    }
    setPending("detect");
    try {
      const rows = await codexClient.detectProxies();
      setCandidates(rows);
      if (!rows.length) setStatus("未检测到 HTTP/HTTPS 代理，请手动填写。");
    } catch {
      setError("读取本机代理配置失败，请手动填写。");
    } finally {
      setPending(null);
    }
  }

  async function save() {
    if (pending || (mixed && !edited)) return;
    setError("");
    setPending("save");
    try {
      await onSave(url);
    } catch (reason) {
      setError(platformErrorMessage(reason, "保存账号代理失败"));
      setPending(null);
    }
  }

  return <SharedDialog sizeStorageKey="features/antigravity/account-proxy"
    title="账号代理" className="codex-dialog" onClose={onClose} closeDisabled={!!pending}>
    <p className="codex-account-dialog-label">{label}</p>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>HTTP/HTTPS 代理地址
        <input value={url} maxLength={512} disabled={!!pending} aria-invalid={!!error}
          placeholder="http://127.0.0.1:7890" onChange={event => changeUrl(event.target.value)} />
      </label>
      {mixed && <p>所选账号的代理配置不同。填写地址可统一设置，留空保存可清除。</p>}
      <div className="codex-proxy-detection">
        <button type="button" disabled={!!pending} onClick={() => void detect()}>
          <RefreshCw size={14} aria-hidden="true" />{pending === "detect" ? "正在检测…" : "检测本机代理"}
        </button>
        <span>读取本机配置和环境变量，选定后可手动保存。</span>
      </div>
      {candidates.length > 0 && <div className="codex-proxy-candidates">
        <label>检测到的代理
          <select value="" disabled={!!pending} onChange={event => { if (event.target.value) changeUrl(event.target.value); }}>
            <option value="">选择地址填入</option>
            {candidates.map(({ url: candidate, source, enabled }, index) =>
              <option key={index} value={candidate}>{candidate} · {source}{enabled ? "" : "（系统代理已关闭）"}</option>
            )}
          </select>
        </label>
      </div>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert" className="codex-card-error">{error}</p>}
      <p>用于此账号的配额刷新，留空沿用系统网络。</p>
      <details><summary>支持的代理格式</summary><p>支持无账号密码的 HTTP/HTTPS 代理地址。请填写协议、主机和端口。</p></details>
      <div className="codex-dialog-actions">
        {mixed && !edited && <button type="button" disabled={!!pending}
          onClick={() => changeUrl("")}>清除所选代理</button>}
        <button type="button" disabled={!!pending} onClick={onClose}>取消</button>
        <button type="submit" disabled={!!pending || (mixed && !edited)}>{pending === "save" ? "正在保存…" : "保存代理"}</button>
      </div>
    </form>
  </SharedDialog>;
}
