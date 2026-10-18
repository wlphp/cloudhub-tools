import { useCallback, useEffect, useState } from "react";
import { Copy, Eye, FolderOpen, Pencil, Plus, RefreshCw, RotateCcw, Trash2, Upload } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { claudeWorkbenchClient as client, type ClaudePrompt, type ClaudeWorkspaceAction, type ClaudeWorkspaceState } from "../../platform/clients/claudeProviders";
import { runningInTauri } from "../../platform/api";

type View = "mcp" | "prompts" | "skills" | "sessions" | "config";
type Confirm = (message: string, action: () => Promise<unknown>) => void;
const parseObject = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请输入 JSON 对象");
  return value as Record<string, unknown>;
};

function McpEditor({ existing, onClose, onSave }: { existing?: ClaudeWorkspaceState["mcp"][number]; onClose: () => void; onSave: (name: string, config: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [transport, setTransport] = useState(existing?.transport ?? "stdio");
  const [command, setCommand] = useState(existing?.command ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [args, setArgs] = useState(existing ? "" : "[]");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <SharedDialog title={existing ? "编辑 MCP 服务器" : "添加 MCP 服务器"} onClose={onClose} closeDisabled={busy} size="small"
    onSubmit={event => {
      event.preventDefault(); if (busy) return;
      let config: Record<string, unknown>;
      try {
        config = transport === "stdio" ? { type: transport, command } : { type: transport, url };
        if (transport === "stdio" && args.trim()) { const list: unknown = JSON.parse(args); if (!Array.isArray(list) || list.some(v => typeof v !== "string")) throw new Error("参数必须为字符串数组"); config.args = list; }
        if (env.trim()) config.env = parseObject(env);
        if (headers.trim()) config.headers = parseObject(headers);
      } catch (reason) { setError(reason instanceof Error ? reason.message : "JSON 格式无效"); return; }
      setBusy(true); setError(""); void onSave(name, config).then(onClose).catch(reason => setError(reason instanceof Error ? reason.message : "保存失败")).finally(() => setBusy(false));
    }}
    footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy}>保存</button></>}>
    <div className="claude-work-form">
      {!existing && <details><summary>从 JSON 导入 MCP 配置</summary>
        <label className="claude-field">MCP 配置 JSON<textarea rows={6} autoComplete="off" spellCheck={false} value={importText} onChange={event => setImportText(event.target.value)} placeholder={'{"mcpServers":{"my-server":{"command":"npx","args":[]}}}'} /></label>
        <button type="button" className="secondary" disabled={busy || !importText.trim()} onClick={() => {
          try {
            const document = parseObject(importText);
            const servers = parseObject(JSON.stringify(document.mcpServers ?? document));
            const entries = Object.entries(servers);
            if (entries.length !== 1) throw new Error("请每次导入一个 MCP 服务器");
            const [serverName, raw] = entries[0];
            if (!/^[A-Za-z0-9_.-]{1,100}$/.test(serverName)) throw new Error("服务器名称只能包含字母、数字、下划线、点和横线");
            const config = parseObject(JSON.stringify(raw));
            if (Object.keys(config).some(key => !["type", "command", "url", "args", "env", "headers"].includes(key))) throw new Error("包含表单不支持的字段，请手动检查配置");
            const kind = config.type ?? (config.url ? "http" : "stdio");
            if (!["stdio", "http", "sse"].includes(String(kind))) throw new Error("不支持的 MCP 传输方式");
            if (kind === "stdio" && (typeof config.command !== "string" || !config.command.trim())) throw new Error("STDIO 配置需要命令");
            if (kind !== "stdio") {
              const address = new URL(String(config.url ?? ""));
              if (!["http:", "https:"].includes(address.protocol)) throw new Error("HTTP / SSE 配置需要 HTTP(S) 地址");
            }
            if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(value => typeof value !== "string"))) throw new Error("参数必须为字符串数组");
            for (const key of ["env", "headers"]) {
              if (config[key] === undefined) continue;
              const values = parseObject(JSON.stringify(config[key]));
              if (Object.values(values).some(value => typeof value !== "string")) throw new Error("环境变量和请求头的值必须为字符串");
            }
            setName(serverName); setTransport(String(kind));
            setCommand(typeof config.command === "string" ? config.command : "");
            setUrl(typeof config.url === "string" ? config.url : "");
            setArgs(JSON.stringify(config.args ?? [], null, 2));
            setEnv(config.env ? JSON.stringify(config.env, null, 2) : "");
            setHeaders(config.headers ? JSON.stringify(config.headers, null, 2) : "");
            setImportText(""); setError("");
          } catch { setError("无法导入：每次仅支持一个服务器；检查名称、传输方式、地址和参数，不能包含表单不支持的字段"); }
        }}>填入表单</button>
        <p>仅填入下方表单；确认保存后才写入配置，不会执行命令。每次导入一个服务器。</p>
      </details>}
      <label className="claude-field">服务器名称<input required pattern="[A-Za-z0-9_.-]+" maxLength={100} disabled={Boolean(existing)} value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="claude-field">传输方式<select value={transport} onChange={e => setTransport(e.target.value)}><option value="stdio">STDIO</option><option value="http">HTTP</option><option value="sse">SSE</option></select></label>
      {transport === "stdio" ? <><label className="claude-field">命令<input required value={command} onChange={e => setCommand(e.target.value)} /></label><label className="claude-field">参数（JSON 数组）<textarea rows={3} value={args} placeholder={existing ? "留空保留原参数" : '["server.js"]'} onChange={e => setArgs(e.target.value)} /></label></> : <label className="claude-field">服务器地址<input required type="url" value={url} onChange={e => setUrl(e.target.value)} /></label>}
      <label className="claude-field">环境变量（JSON 对象）<textarea rows={3} value={env} autoComplete="off" spellCheck={false} placeholder={existing ? "留空保留已保存的环境变量" : "{}"} onChange={e => setEnv(e.target.value)} /></label>
      {transport !== "stdio" && <label className="claude-field">请求头（JSON 对象）<textarea rows={3} value={headers} autoComplete="off" spellCheck={false} placeholder={existing ? "留空保留已保存的请求头" : "{}"} onChange={e => setHeaders(e.target.value)} /></label>}
      {error && <p role="alert" className="claude-error">{error}</p>}
    </div>
  </SharedDialog>;
}

function PromptEditor({ draft, onClose, onSave }: { draft: ClaudePrompt; onClose: () => void; onSave: (prompt: ClaudePrompt) => Promise<void> }) {
  const [value, setValue] = useState(draft);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <SharedDialog title={draft.id ? "编辑提示词" : "新建提示词"} onClose={onClose} closeDisabled={busy}
    onSubmit={e => { e.preventDefault(); if (busy) return; setBusy(true); void onSave({ ...value, id: value.id || `prompt-${crypto.randomUUID()}` }).then(onClose).catch(reason => setError(reason instanceof Error ? reason.message : "保存失败")).finally(() => setBusy(false)); }}
    footer={<><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy}>保存</button></>}>
    <div className="claude-work-form"><label className="claude-field">提示词名称<input required maxLength={240} autoFocus value={value.name} onChange={e => setValue({ ...value, name: e.target.value })} /></label>
      <label className="claude-field">内容<textarea rows={18} required value={value.content} onChange={e => setValue({ ...value, content: e.target.value })} /></label>
      {error && <p role="alert" className="claude-error">{error}</p>}
    </div>
  </SharedDialog>;
}

export function ClaudeWorkspacePanel({ view, confirm, onScopeChanged }: { view: View; confirm: Confirm; onScopeChanged: () => void }) {
  const [state, setState] = useState<ClaudeWorkspaceState | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [trash, setTrash] = useState(false);
  const [mcpEditor, setMcpEditor] = useState<{ existing?: ClaudeWorkspaceState["mcp"][number] } | null>(null);
  const [promptEditor, setPromptEditor] = useState<ClaudePrompt | null>(null);
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null);
  const load = useCallback(async () => { const next = await client.workspace(); if (next && Array.isArray(next.mcp)) setState(next); }, []);
  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : "读取工作区失败")); }, [load]);
  const run = async (action: () => Promise<unknown>, done: string) => {
    if (busy) return; setBusy(true); setError(""); setMessage("");
    try { await action(); await load(); setMessage(done); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); }
  };
  const act = async (action: ClaudeWorkspaceAction) => { await client.workspaceAction(action); await load(); setMessage("已保存"); };
  const matches = (text: string) => text.toLowerCase().includes(keyword.toLowerCase());
  return <section className="claude-workspace" aria-busy={busy}>
    {(error || message) && <p role={error ? "alert" : "status"} className={error ? "claude-error" : "claude-status"}>{error || message}</p>}
    {view !== "config" && <div className="claude-work-toolbar"><input type="search" aria-label="搜索 Claude 工作区" placeholder="搜索" value={keyword} onChange={e => setKeyword(e.target.value)} />
      {["skills", "sessions"].includes(view) && <label className="claude-check"><input type="checkbox" checked={trash} onChange={e => setTrash(e.target.checked)} />回收站</label>}
      <button type="button" className="secondary claude-icon-button" aria-label="刷新工作区" title="刷新" disabled={busy} onClick={() => void run(load, "已刷新")}><RefreshCw size={14} /></button>
      {view === "mcp" && <><button type="button" className="secondary" disabled={busy} onClick={() => confirm("将恢复 MCP 配置的上一份备份。", () => run(() => client.workspaceAction({ type: "restore_file", kind: "mcp" }), "MCP 配置已恢复"))}><RotateCcw size={14} />恢复上一份</button><button type="button" className="primary" onClick={() => setMcpEditor({})}><Plus size={14} />添加服务器</button></>}
      {view === "prompts" && <><button type="button" className="secondary" onClick={() => confirm("将恢复 CLAUDE.md 的上一份内容。", () => run(() => client.workspaceAction({ type: "restore_file", kind: "prompt" }), "CLAUDE.md 已恢复"))}><RotateCcw size={14} />恢复 CLAUDE.md</button><button type="button" className="primary" onClick={() => setPromptEditor({ id: "", name: "", content: "" })}><Plus size={14} />新建提示词</button></>}
      {view === "skills" && <button type="button" className="primary" disabled={busy || !runningInTauri} onClick={() => void run(() => client.installSkill(), "技能安装操作已结束")}><Upload size={14} />从文件夹安装</button>}
    </div>}
    {view === "mcp" && <><code className="claude-work-path">{state?.mcpPath}</code><ul className="claude-work-list">{state?.mcp.filter(s => matches(s.name)).map(server => <li key={server.name}>
      <div><strong>{server.name}</strong><small>{server.transport.toUpperCase()} · {server.command || server.url}</small>{server.hasSecrets && <small>已保存认证配置</small>}</div>
      <div className="claude-provider-actions"><label className="claude-check"><input type="checkbox" aria-label={`启用 ${server.name}`} checked={server.enabled} disabled={busy} onChange={e => void run(() => client.workspaceAction({ type: "toggle_mcp", name: server.name, enabled: e.target.checked }), "MCP 状态已更新")} />启用</label>
        <button type="button" className="secondary claude-icon-button" title="编辑" aria-label={`编辑 MCP ${server.name}`} onClick={() => setMcpEditor({ existing: server })}><Pencil size={14} /></button>
        <button type="button" className="secondary claude-icon-button" title="删除" aria-label={`删除 MCP ${server.name}`} onClick={() => confirm(`删除 MCP 服务器“${server.name}”？配置会先备份。`, () => run(() => client.workspaceAction({ type: "delete_mcp", name: server.name }), "MCP 已删除"))}><Trash2 size={14} /></button></div>
    </li>)}</ul>{state?.mcp.length === 0 && <p role="status">暂无 MCP 服务器</p>}</>}
    {view === "prompts" && <><code className="claude-work-path">{state?.promptPath}</code><ul className="claude-work-list">{state?.prompts.filter(p => matches(p.name)).map(prompt => <li key={prompt.id}>
      <div><strong>{prompt.name}</strong>{state.activePrompt === prompt.id && <span className="claude-tag">已启用</span>}<small>{prompt.content.slice(0, 140)}</small></div>
      <div className="claude-provider-actions"><button type="button" className="secondary" disabled={busy || state.activePrompt === prompt.id} onClick={() => confirm(`将“${prompt.name}”写入当前作用域的 CLAUDE.md，原文件会先备份。`, () => run(() => client.workspaceAction({ type: "activate_prompt", id: prompt.id }), "提示词已启用"))}>启用</button>
        <button type="button" className="secondary claude-icon-button" title="编辑" aria-label={`编辑提示词 ${prompt.name}`} onClick={() => setPromptEditor(prompt)}><Pencil size={14} /></button>
        <button type="button" className="secondary claude-icon-button" title="删除" aria-label={`删除提示词 ${prompt.name}`} disabled={state.activePrompt === prompt.id} onClick={() => confirm(`删除提示词“${prompt.name}”？`, () => run(() => client.workspaceAction({ type: "delete_prompt", id: prompt.id }), "提示词已删除"))}><Trash2 size={14} /></button></div>
    </li>)}</ul>{state?.prompts.length === 0 && <p role="status">暂无提示词</p>}</>}
    {view === "skills" && <ul className="claude-work-list">{state?.skills.filter(s => s.trashed === trash && matches(`${s.name} ${s.description}`)).map(skill => <li key={skill.key}><div><strong>{skill.name}</strong><small>{skill.description}</small></div><div className="claude-provider-actions"><button type="button" className="secondary" disabled={busy} onClick={() => confirm(skill.trashed ? `恢复技能“${skill.name}”？` : `卸载技能“${skill.name}”？原文件会移入技能回收站。`, () => run(() => client.workspaceAction({ type: skill.trashed ? "restore_skill" : "trash_skill", key: skill.key }), skill.trashed ? "技能已恢复" : "技能已卸载"))}>{skill.trashed ? <RotateCcw size={14} /> : <Trash2 size={14} />}{skill.trashed ? "恢复" : "卸载"}</button></div></li>)}</ul>}
    {view === "sessions" && <ul className="claude-work-list">{state?.sessions.filter(s => s.trashed === trash && matches(`${s.title} ${s.project} ${s.id}`)).map(session => <li key={session.key}><div><strong>{session.title || session.id}</strong><small>{session.project}</small><small>{new Date(session.modifiedAt).toLocaleString()} · {(session.bytes / 1024).toFixed(1)} KB</small></div><div className="claude-provider-actions">
      <button type="button" className="secondary claude-icon-button" title="查看会话" aria-label={`查看会话 ${session.id}`} disabled={busy} onClick={() => void run(async () => setPreview({ title: session.title, text: await client.sessionPreview(session.key) }), "")}><Eye size={14} /></button>
      {!trash && <button type="button" className="secondary claude-icon-button" title="复制恢复命令" aria-label={`复制恢复命令 ${session.id}`} onClick={() => void run(() => navigator.clipboard.writeText(`claude --resume ${session.id}`), "恢复命令已复制")}><Copy size={14} /></button>}
      <button type="button" className="secondary claude-icon-button" title={trash ? "恢复" : "删除"} aria-label={`${trash ? "恢复" : "删除"}会话 ${session.id}`} onClick={() => confirm(trash ? "恢复此会话？" : "将此会话移入回收站？", () => run(() => client.workspaceAction({ type: trash ? "restore_session" : "trash_session", key: session.key }), trash ? "会话已恢复" : "会话已移入回收站"))}>{trash ? <RotateCcw size={14} /> : <Trash2 size={14} />}</button>
    </div></li>)}</ul>}
    {view === "config" && <div className="claude-work-config"><dl><dt>当前作用域</dt><dd>{state?.project || "用户全局"}</dd><dt>Claude Code 配置</dt><dd><code>{state?.settingsPath}</code></dd><dt>MCP 配置</dt><dd><code>{state?.mcpPath}</code></dd><dt>提示词文件</dt><dd><code>{state?.promptPath}</code></dd></dl>
      <div className="claude-work-toolbar"><button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => { await client.chooseProject(); onScopeChanged(); }, "项目作用域已更新")}><FolderOpen size={14} />选择项目</button><button type="button" className="secondary" disabled={busy || !state?.project} onClick={() => void run(async () => { await client.chooseProject(true); onScopeChanged(); }, "已切回用户全局")}><RotateCcw size={14} />用户全局</button></div>
      <h3>环境变量冲突</h3>{state?.environmentConflicts.length ? <ul>{state.environmentConflicts.map(name => <li key={name}><code>{name}</code></li>)}</ul> : <p>未检测到进程环境变量冲突</p>}
    </div>}
    {mcpEditor && <McpEditor existing={mcpEditor.existing} onClose={() => setMcpEditor(null)} onSave={(name, config) => act({ type: "save_mcp", name, config })} />}
    {promptEditor && <PromptEditor draft={promptEditor} onClose={() => setPromptEditor(null)} onSave={prompt => act({ type: "save_prompt", prompt })} />}
    {preview && <SharedDialog title="Claude Code 会话" subtitle={preview.title} onClose={() => setPreview(null)}><pre className="claude-session-preview">{preview.text || "未读取到文本消息"}</pre></SharedDialog>}
  </section>;
}
