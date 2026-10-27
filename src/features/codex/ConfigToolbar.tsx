import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, FolderOpen, RefreshCw, RotateCcw, Server } from "lucide-react";
import { codexClient, type CodexConfigSource } from "../../platform/clients/codex";
import { platformErrorMessage } from "../../platform/api";
import { OverviewDialog } from "./OverviewDialogs";

export function ConfigToolbar({ busy, onRestore }: {
  busy: boolean;
  onRestore: () => void;
}) {
  const [source, setSource] = useState<CodexConfigSource | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const alive = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    alive.current = true;
    void run("state", null);
    return () => { alive.current = false; };
  }, []);
  async function run(action: "state" | "select_project" | "open_directory", workspace = source?.workspace ?? null) {
    if (working.current) return;
    working.current = true; setPending(true); setError("");
    try {
      const next = await codexClient.configSource(action, workspace);
      if (next && alive.current) {
        setSource(next);
      }
    } catch (reason) {
      if (alive.current) setError(platformErrorMessage(reason, "读取 Codex 配置失败，请重试"));
    } finally {
      working.current = false;
      if (alive.current) setPending(false);
    }
  }
  const locked = busy || pending;
  return <>
    <div className="codex-config-bar" aria-label="Codex 配置工具栏" aria-busy={pending}>
      <div className="codex-config-source">
        <span className={source?.exists ? "is-present" : ""}><Server size={14} aria-hidden="true" /><span>配置文件 <code title={source?.path}>{source?.path ?? (error ? "读取失败" : "正在读取…")}</code>{source && !source.exists && <small>（尚未创建）</small>}</span></span>
        <div className="codex-config-actions">
          <button type="button" disabled={locked || !source} onClick={() => setPreviewOpen(true)} title="查看完整配置、auth.json 和模型目录文件，敏感值默认隐藏"><Eye size={13} aria-hidden="true" />预览配置</button>
        </div>
      </div>
      <span className="codex-config-scope" title={source?.workspace ?? "用户全局"}><FolderOpen size={14} aria-hidden="true" />{source?.workspace ? `项目 ${source.workspace}` : "用户全局"}</span>
      <div className="codex-config-actions">
        <button type="button" disabled={locked} onClick={onRestore} title="查看账号与供应商切换的统一备份历史，按时间选择恢复"><RotateCcw size={13} aria-hidden="true" />备份与恢复</button>
        <button type="button" disabled={locked || !source} onClick={() => void run("open_directory")} title={source && !source.exists ? "配置目录尚未创建时打开项目或用户目录" : "打开当前配置文件所在目录"}><FolderOpen size={13} aria-hidden="true" />打开配置目录</button>
        <button type="button" disabled={locked} onClick={() => void run("select_project")}>选择项目</button>
        <button type="button" disabled={locked || !source?.workspace} onClick={() => void run("state", null)}>不使用项目</button>
        <button type="button" disabled={locked} onClick={() => void run("state")} title="刷新配置文件状态" aria-label="刷新配置文件状态"><RefreshCw size={13} aria-hidden="true" /></button>
      </div>
    </div>
    {error && <p className="codex-feedback error" role="alert">{error}</p>}
    {previewOpen && source && <ConfigPreviewDialog source={source} onClose={() => setPreviewOpen(false)} />}
  </>;
}

function ConfigPreviewDialog({ source, onClose }: { source: CodexConfigSource; onClose: () => void }) {
  const files = ["config", "auth", "catalog"] as const;
  const [file, setFile] = useState<typeof files[number]>("config");
  const [reveal, setReveal] = useState(false);
  const requestId = useRef(0);
  const [result, setResult] = useState<CodexConfigSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  function changePreview(nextFile: typeof files[number], nextReveal = false) {
    if (nextFile === file && nextReveal === reveal) return;
    requestId.current += 1;
    setResult(null); setError(""); setLoading(true);
    setFile(nextFile); setReveal(nextReveal);
  }
  useEffect(() => {
    let cancelled = false;
    const id = ++requestId.current;
    setLoading(true); setResult(null); setError("");
    void codexClient.configSource(file === "catalog" ? reveal ? "reveal_catalog" : "preview_catalog" : file === "config" ? reveal ? "reveal_config" : "preview_config" : reveal ? "reveal_auth" : "preview_auth", source.workspace).then(value => {
      if (cancelled || id !== requestId.current) return;
      if (!value) throw new Error("未能读取配置预览");
      setResult(value);
    }).catch(reason => {
      if (!cancelled && id === requestId.current) setError(platformErrorMessage(reason, "读取配置预览失败，请重试"));
    }).finally(() => { if (!cancelled && id === requestId.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [file, reveal, source.workspace]);
  const auth = file === "auth";
  const catalog = file === "catalog";
  const filename = catalog ? "cloudhub-model-catalog.json" : auth ? "auth.json" : "config.toml";
  const current = result ?? source;
  const content = catalog ? result?.catalogPreview : auth ? result?.authPreview : result?.configPreview;
  const formatted = file !== "config" ? JSON.stringify(content, null, 2) : formatConfigToml(result?.configPreview ?? {});
  return <OverviewDialog title="Codex 配置预览" busy={false} onClose={onClose} className="codex-config-preview" footer={<button type="button" onClick={onClose}>关闭</button>}>
    <div className="codex-config-preview-tabs" role="tablist" aria-label="选择预览文件">
      {files.map((value, index) => <button key={value} type="button" id={`codex-config-preview-tab-${value}`} role="tab" aria-selected={file === value} aria-controls="codex-config-preview-content" tabIndex={file === value ? 0 : -1} onClick={() => changePreview(value)} onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? files.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + files.length) % files.length;
          changePreview(files[next]);
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }
      }}>{value === "catalog" ? "cloudhub-model-catalog.json" : value === "config" ? "config.toml" : "auth.json"}</button>)}
    </div>
    <div id="codex-config-preview-content" role="tabpanel" aria-labelledby={`codex-config-preview-tab-${file}`} aria-busy={loading} tabIndex={0}>
      <code className="codex-config-preview-path">{catalog ? current.catalogPath : auth ? current.authPath : current.path}</code>
      <p>{catalog ? "用户全局配置目录中由 CloudHub 生成的模型列表文件，包含模型 ID、显示名称、上下文窗口等字段；应用供应商配置时生成或更新。" : auth ? "用户全局 auth.json 的全部字段。" : "官方 CLI 解析后的完整有效配置，包含供应商 API 地址、请求头和 MCP；不保留原文件注释与排版。"}{reveal ? "敏感值以明文显示。" : "敏感值默认隐藏。"}</p>
      <div className="codex-config-actions"><button type="button" aria-pressed={reveal} onClick={() => changePreview(file, !reveal)}>{reveal ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}{reveal ? "隐藏密钥" : "显示密钥"}</button></div>
      {loading ? <p role="status">正在读取 {filename}…</p> : error ? <p role="alert" className="codex-card-error">{error}</p> : content ? catalog ? <CatalogPreview content={content} formatted={formatted ?? ""} reveal={reveal} /> : <pre tabIndex={0} aria-label={`${filename} ${reveal ? "明文内容" : "脱敏内容"}`}>{formatted || "# 当前没有可展示的配置"}</pre> : <p role="status">{catalog ? "模型列表文件尚未生成，请先在默认实例应用供应商配置。" : auth ? "auth.json 尚未创建，或登录凭据保存在系统凭据库中。" : "当前没有可展示的配置。"}</p>}
    </div>
  </OverviewDialog>;
}

function CatalogPreview({ content, formatted, reveal }: { content: Record<string, unknown>; formatted: string; reveal: boolean }) {
  const models = Array.isArray(content.models) ? content.models.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)) : [];
  const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "—";
  const tokens = (value: unknown) => typeof value === "number" ? `${value.toLocaleString("zh-CN")} tokens` : "—";
  return <div className="codex-catalog-preview">
    <section aria-label="模型列表">
      <h3>模型列表（{models.length}）</h3>
      {models.length ? <ul className="codex-catalog-models">{models.map((model, index) => <li key={index}>
        <strong>{text(model.display_name ?? model.slug)}</strong>
        <code>{text(model.slug)}</code>
        <dl><div><dt>上下文窗口</dt><dd>{tokens(model.context_window)}</dd></div><div><dt>自动压缩阈值</dt><dd>{tokens(model.auto_compact_token_limit)}</dd></div></dl>
      </li>)}</ul> : <p role="status">文件中没有可展示的模型条目。</p>}
    </section>
    <details className="codex-launch-help"><summary>完整 JSON（含模型提示词与能力字段）</summary><pre tabIndex={0} aria-label={`模型目录 ${reveal ? "明文内容" : "脱敏内容"}`}>{formatted}</pre></details>
  </div>;
}

function formatConfigToml(config: Record<string, unknown>): string {
  const key = (name: string) => /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  const table = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  function scalar(value: unknown): string {
    if (Array.isArray(value)) return `[${value.filter(item => item !== null).map(scalar).join(", ")}]`;
    if (table(value)) return `{ ${Object.entries(value).filter(([, item]) => item !== null).map(([name, item]) => `${key(name)} = ${scalar(item)}`).join(", ")} }`;
    return JSON.stringify(value);
  }
  const lines: string[] = [];
  function section(value: Record<string, unknown>, path: string[]) {
    if (path.length) lines.push("", `[${path.map(key).join(".")}]`);
    for (const [name, item] of Object.entries(value)) {
      if (item !== null && !table(item)) lines.push(`${key(name)} = ${scalar(item)}`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (table(item)) section(item, [...path, name]);
    }
  }
  section(config, []);
  return lines.join("\n").trim();
}
