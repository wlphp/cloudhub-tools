import { ToastNotice } from "../../shared/ToastNotice";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { invoke, runningInTauri } from "../../platform/api";
import { AlertTriangle, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SharedDialog } from "../../shared/SharedDialog";
import "./environment-variables.css";

type Scope = "user" | "system";
type Variable = { name: string; value: string; scope: Scope; valueKind: "String" | "ExpandString" };
type Snapshot = { isAdmin: boolean; variables: Variable[] };
const command = <T,>(name: string, args?: Record<string, unknown>) => invoke<T>(name, args);

function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  // Tauri serializes Rust `Result<_, String>` rejections as plain strings.
  if (typeof reason === "string" && reason.trim()) return reason;
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function pathParts(value: string) { return value.split(";"); }
function pathPreview(value: string) { return value.split(";").filter(Boolean); }

export function EnvironmentVariablesPlugin() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scopeFilter, setScopeFilter] = useState<"all" | Scope>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Variable>({ name: "", value: "", scope: "user", valueKind: "String" });
  const [editing, setEditing] = useState<Variable | null>(null);
  const [formValue, setFormValue] = useState("");
  const [formKind, setFormKind] = useState<Variable["valueKind"]>("String");
  const [deleteTarget, setDeleteTarget] = useState<Variable | null>(null);
  const [pathDraft, setPathDraft] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!runningInTauri) return;
    setBusy(true); setError("");
    try { setSnapshot(await command<Snapshot>("env_manager_list")); }
    catch (reason) { setError(errorMessage(reason, "读取环境变量失败。")); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const variables = useMemo(() => (snapshot?.variables ?? []).filter(item =>
    (scopeFilter === "all" || item.scope === scopeFilter)
    && (!query.trim() || `${item.name} ${item.value}`.toLowerCase().includes(query.trim().toLowerCase()))
  ).sort((left, right) => {
    const pathOrder = Number(right.name.toLowerCase() === "path") - Number(left.name.toLowerCase() === "path");
    return pathOrder || left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
  }), [snapshot, scopeFilter, query]);

  async function save(item: Variable, value: string, valueKind: Variable["valueKind"], deleteValue = false) {
    setBusy(true); setError(""); setMessage("");
    try {
      await command<void>("env_manager_write", { request: { name: item.name.trim(), value, valueKind, scope: item.scope, delete: deleteValue } });
      setMessage(`${item.scope === "system" ? "系统" : "用户"}变量 ${item.name} 已${deleteValue ? "删除" : "保存"}。新启动的程序才能读取更新值。`);
      setAdding(false); setEditing(null); setDeleteTarget(null);
      await refresh();
    } catch (reason) { setError(errorMessage(reason, "保存环境变量失败。")); }
    finally { setBusy(false); }
  }

  async function openElevated() {
    setBusy(true); setError(""); setMessage("");
    try {
      await command<void>("env_manager_relaunch_elevated");
      setMessage("已请求 Windows 管理员授权并打开新窗口。完成系统提示后，请切换到新窗口并重新进入环境变量管理。");
    } catch (reason) { setError(errorMessage(reason, "无法打开管理员窗口。")); }
    finally { setBusy(false); }
  }

  function openAdd() {
    setError(""); setMessage(""); setEditing(null);
    setDraft({ name: "", value: "", scope: "user", valueKind: "String" });
    setFormValue(""); setFormKind("String"); setPathDraft([]); setAdding(true);
  }

  function beginEdit(item: Variable) {
    setError(""); setMessage(""); setDraft(item); setEditing(item);
    setFormValue(item.value); setFormKind(item.valueKind);
    setPathDraft(pathParts(item.value)); setDeleteTarget(null);
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const item = editing ?? draft;
    if (!item.name.trim()) { setError("请填写变量名称。"); return; }
    const isPath = Boolean(editing && editing.name.toLowerCase() === "path");
    void save(item, isPath ? pathDraft.join(";") : formValue, isPath ? item.valueKind : formKind);
  }

  const formItem = editing ?? draft;
  const editingPath = Boolean(editing && editing.name.toLowerCase() === "path");
  const dialogTitle = editing ? `编辑环境变量：${editing.name}` : "新增环境变量";

  return <section className="env-manager" aria-busy={busy}>
    <div className="env-manager-warning" role="note"><AlertTriangle size={18} aria-hidden="true" /><div><strong>直接管理 Windows 环境变量</strong><p>变量值（包括密钥）会以明文显示并可直接修改。系统变量写入需要管理员权限；修改通常只对新启动的程序生效。错误或误删可能导致软件无法运行。</p></div></div>
    {snapshot && <div className={`env-manager-admin ${snapshot.isAdmin ? "is-admin" : ""}`} role="status"><span>{snapshot.isAdmin ? "当前以管理员权限运行，可修改用户与系统变量。" : "当前不是管理员。用户变量可正常修改；系统变量修改需经 Windows 管理员授权。"}</span>{!snapshot.isAdmin && <button type="button" className="secondary" disabled={busy} onClick={() => void openElevated()}>以管理员身份重新打开</button>}</div>}
    {error && <ToastNotice message={error} tone="error" />}{message && <ToastNotice message={message} />}
    <div className="env-manager-toolbar"><div className="env-manager-filters" role="group" aria-label="变量范围">{([["all", "全部"], ["user", "用户变量"], ["system", "系统变量"]] as const).map(([key, label]) => <button key={key} type="button" className={scopeFilter === key ? "is-active" : "secondary"} aria-pressed={scopeFilter === key} onClick={() => setScopeFilter(key)}>{label}</button>)}</div><div className="env-manager-tools"><label className="env-manager-search">搜索变量<input value={query} onChange={event => setQuery(event.target.value)} placeholder="名称或值" /></label><button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />刷新</button><button type="button" disabled={busy} onClick={openAdd}><Plus size={14} aria-hidden="true" />新增变量</button></div></div>
    <div className="env-manager-table-wrap"><table className="env-manager-table"><thead><tr><th scope="col">变量名</th><th scope="col">范围</th><th scope="col">类型</th><th scope="col">变量值（明文）</th><th scope="col">操作</th></tr></thead><tbody>
      {variables.map(item => {
        const key = `${item.scope}:${item.name.toLowerCase()}`;
        return <tr key={key} className={item.name.toLowerCase() === "path" ? "env-manager-path-row" : undefined}>
          <th scope="row"><code>{item.name}</code>{item.name.toLowerCase() === "path" && <span className="env-manager-path-badge">常用</span>}</th><td><span className={`env-manager-scope env-manager-scope--${item.scope}`}>{item.scope === "user" ? "用户" : "系统"}</span></td><td>{item.valueKind === "ExpandString" ? "可展开文本" : "普通文本"}</td>
          <td className="env-manager-value">{item.name.toLowerCase() === "path" ? <><div className="env-manager-path-preview">{pathPreview(item.value).slice(0, 2).map((part, index) => <code key={`${index}:${part}`} title={part}>{part}</code>)}</div>{pathPreview(item.value).length > 2 && <small>另有 {pathPreview(item.value).length - 2} 项，编辑时可查看全部</small>}</> : <pre>{item.value}</pre>}</td>
          <td className="env-manager-actions-cell"><div className="env-manager-row-actions"><button type="button" className="table-link" disabled={busy} onClick={() => beginEdit(item)}>编辑</button><button type="button" className="table-link env-manager-delete" disabled={busy} onClick={() => setDeleteTarget(item)}><Trash2 size={14} aria-hidden="true" />删除</button></div></td>
        </tr>;
      })}
      {!variables.length && <tr><td colSpan={5} className="env-manager-empty">{snapshot ? "没有匹配的环境变量。" : busy ? "正在读取环境变量…" : "环境变量尚未加载。"}</td></tr>}
    </tbody></table></div>
    <p className="env-manager-footnote">系统和用户变量值直接读取 Windows 注册表并按原始文本显示；`Path` 使用分段编辑。修改 `Path` 时会用分号重新组合保存。更改会广播给 Windows，但已运行的程序通常需要重启。</p>

    {(adding || editing) && <SharedDialog sizeStorageKey="features/plugins/environment-variables-plugin/environment-variables-plugin" title={dialogTitle} subtitle={editing ? "修改后会直接写入 Windows 环境变量" : "新增后会直接写入 Windows 环境变量"} className="env-manager-dialog" bodyClassName="env-manager-dialog-body" size="large" closeLabel="关闭环境变量编辑" closeDisabled={busy} busy={busy} onClose={() => { setAdding(false); setEditing(null); setError(""); }} initialFocus=".env-manager-name" onSubmit={submitForm} footer={<><button type="button" className="secondary" disabled={busy} onClick={() => { setAdding(false); setEditing(null); setError(""); }}><X size={14} aria-hidden="true" />取消</button><button type="submit" className="primary" disabled={busy}><Save size={14} aria-hidden="true" />{busy ? "保存中…" : "保存变量"}</button></>}>
      {error && <p className="hardware-info-error" role="alert">{error}</p>}
      <label>变量名称<input className="env-manager-name" autoComplete="off" value={formItem.name} disabled={Boolean(editing)} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} /></label>
      <div className="env-manager-dialog-grid"><label>范围<select value={formItem.scope} disabled={Boolean(editing)} onChange={event => setDraft(value => ({ ...value, scope: event.target.value as Scope }))}><option value="user">用户变量</option><option value="system">系统变量</option></select></label><label>变量类型<select value={formKind} onChange={event => setFormKind(event.target.value as Variable["valueKind"])}><option value="String">普通文本</option><option value="ExpandString">可展开文本（%变量%）</option></select></label></div>
      {editingPath ? <div className="env-manager-dialog-path"><span className="env-manager-dialog-label">Path 路径项</span><div className="env-manager-path-editor">{pathDraft.map((part, index) => <div className="env-manager-path-item" key={index}><span>{index + 1}</span><input aria-label={`Path 第 ${index + 1} 项`} value={part} onChange={event => setPathDraft(value => value.map((entry, at) => at === index ? event.target.value : entry))} /><button type="button" className="table-link env-manager-delete" aria-label={`删除 Path 第 ${index + 1} 项`} onClick={() => setPathDraft(value => value.filter((_, at) => at !== index))}><X size={14} aria-hidden="true" /></button></div>)}</div><button type="button" className="secondary env-manager-add-path" onClick={() => setPathDraft(value => [...value, ""])}><Plus size={14} aria-hidden="true" />添加 Path 项</button></div> : <label>变量值<textarea value={formValue} onChange={event => setFormValue(event.target.value)} rows={Math.min(8, Math.max(3, formValue.split("\n").length))} /></label>}
    </SharedDialog>}
    {deleteTarget && <ConfirmDialog title="删除环境变量" confirmLabel="确认删除" busy={busy} message={`将直接删除${deleteTarget.scope === "system" ? "系统" : "用户"}变量“${deleteTarget.name}”，该操作无法自动恢复。确认继续吗？`} onResolve={confirmed => {
      const target = deleteTarget;
      if (!confirmed) { setDeleteTarget(null); return; }
      if (target) void save(target, "", target.valueKind, true);
    }} />}
  </section>;
}
