import { useEffect, useState } from "react";
import { FolderOpen, Plus, RotateCcw } from "lucide-react";
import { piAddResource, piInspect, piOpenSkillsDirectory, type PiResource, type PiResourceSnapshot } from "../../platform/clients/piConfig";
import { SharedDialog } from "../../shared/SharedDialog";

export const piResourceTabs: { id: PiResource; name: string }[] = [
  { id: "usage", name: "用量" },
  { id: "mcp", name: "MCP" },
  { id: "prompts", name: "提示词" },
  { id: "skills", name: "技能" },
  { id: "sessions", name: "会话" },
];

const description: Record<PiResource, string> = {
  usage: "统计默认目录最近 30 个会话里的 token 记录，包括历史分支。",
  mcp: "查看用户级 mcp.json 中声明的服务器。",
  prompts: "查看 Pi 用户目录和用户设置中指定的 Markdown 模板。",
  skills: "查看 Pi 用户目录、用户共享目录和用户设置中指定的技能。",
  sessions: "查看默认会话目录最近更新的 100 条记录。使用 Pi 的 /resume 继续会话。",
};
const empty: Record<PiResource, string> = {
  usage: "最近的会话中没有可显示的用量记录。",
  mcp: "用户级 mcp.json 中没有服务器。可以添加 HTTP MCP。",
  prompts: "没有提示词模板。新建模板后，可在 Pi 中用 /模板名 调用。",
  skills: "没有找到用户级技能。可打开技能目录，将含 SKILL.md 的技能文件夹放进去。",
  sessions: "默认会话目录还没有会话记录。",
};

export function PiResourcePanel({ resource, title, nativeDesktop, onOpenDirectory }: {
  resource: PiResource; title: string; nativeDesktop: boolean; onOpenDirectory: () => void;
}) {
  const [snapshot, setSnapshot] = useState<PiResourceSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(nativeDesktop);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<{ name: string; value: string } | null>(null);
  const [draftError, setDraftError] = useState("");
  const [saving, setSaving] = useState(false);
  const mcp = resource === "mcp";

  async function saveResource() {
    if (!draft || saving) return;
    const name = draft.name.trim();
    const validName = mcp ? /^[A-Za-z0-9_-]{1,64}$/.test(name) : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !name.endsWith(".");
    const url = mcp && URL.canParse(draft.value.trim()) ? new URL(draft.value.trim()) : null;
    if (!validName || !draft.value.trim() || (mcp && (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash))) {
      setDraftError(mcp ? "请填写有效名称和不含凭据、查询参数及片段的 HTTP(S) 地址。" : "请填写有效的模板名称和正文。");
      return;
    }
    setSaving(true);
    setDraftError("");
    try {
      if (nativeDesktop) {
        setSnapshot(await piAddResource(mcp ? { type: "add_mcp", name, url: draft.value.trim() } : { type: "add_prompt", name, content: draft.value }));
      } else {
        setSnapshot({ skipped: 0, rows: [...rows, { name, detail: mcp ? "HTTP" : `prompts/${name}.md`, enabled: mcp ? false : undefined, source: "浏览器调试" }] });
      }
      setQuery("");
      setDraft(null);
    } catch (cause) {
      setDraftError(typeof cause === "string" ? cause : "保存 Pi 配置失败。");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!nativeDesktop) return;
    let active = true;
    setLoading(true);
    setError("");
    void piInspect(resource).then(value => {
      if (active) setSnapshot(value);
    }).catch(cause => {
      if (active) setError(typeof cause === "string" ? cause : "读取 Pi 本机记录失败。");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [nativeDesktop, resource, revision]);

  const rows = snapshot?.rows ?? [];
  const keyword = query.trim().toLowerCase();
  const shown = rows.filter(row => `${row.name} ${row.detail ?? ""}`.toLowerCase().includes(keyword));
  const number = (value: number) => value.toLocaleString("zh-CN");
  return <section className="pi-resource-panel" aria-label={title}>
    <div className="claude-status-bar">
      <span>{description[resource]}</span>
      <div className="claude-status-bar-actions">
        <button type="button" className="secondary" disabled={!nativeDesktop || loading} onClick={() => setRevision(value => value + 1)}><RotateCcw size={14} aria-hidden="true" />刷新</button>
        <button type="button" className="secondary" disabled={!nativeDesktop} onClick={onOpenDirectory}><FolderOpen size={14} aria-hidden="true" />打开配置目录</button>
        {resource === "skills" && <button type="button" className="secondary" disabled={!nativeDesktop} onClick={() => {
          setError("");
          void piOpenSkillsDirectory().catch(cause => setError(typeof cause === "string" ? cause : "无法打开技能目录。"));
        }}><FolderOpen size={14} aria-hidden="true" />打开技能目录</button>}
        {(mcp || resource === "prompts") && <button type="button" className="primary" onClick={() => {
          setDraftError("");
          setDraft({ name: "", value: "" });
        }}><Plus size={14} aria-hidden="true" />{mcp ? "添加 MCP" : "新建提示词"}</button>}
      </div>
    </div>
    {error && <p className="claude-error" role="alert">{error}</p>}
    {!nativeDesktop && <p className="claude-config-help" role="status">浏览器预览没有本机 Pi 数据。</p>}
    {!!rows.length && <>
      <div className="pi-resource-summary">
        <label className="claude-field">搜索{title}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <span role="status">{shown.length} / {rows.length} 条{resource === "usage" && ` · ${number(rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0))} tokens`}</span>
      </div>
    </>}
    {!!snapshot?.skipped && <p className="claude-config-help">有 {snapshot.skipped} 个会话因超过 2 MB 或无法读取，未计入用量。</p>}
    {!!shown.length && <ul className="claude-backup-history">{shown.map((row, index) => <li className="pi-resource-row" key={`${row.name}:${row.detail ?? index}`}>
      <strong>{row.name}</strong>
      {row.detail && <span>{row.detail}</span>}
      {row.source && <span className="claude-tag">{row.source}</span>}
      {row.enabled !== undefined && <span>{row.enabled ? "已启用" : "已停用"}</span>}
      {row.tokens !== undefined && <span>{number(row.tokens)} tokens · {number(row.calls ?? 0)} 条用量记录</span>}
      {row.modifiedAt !== undefined && <time dateTime={new Date(row.modifiedAt).toISOString()}>{new Date(row.modifiedAt).toLocaleString("zh-CN")}</time>}
    </li>)}</ul>}
    {!error && !shown.length && <p className="claude-empty-line">{loading ? "正在读取 Pi 记录…" : keyword ? "没有匹配的记录。" : empty[resource]}</p>}
    {draft && <SharedDialog title={mcp ? "添加 HTTP MCP" : "新建提示词模板"} size="small" sizeStorageKey={`features/plugins/pi-config/${resource}-editor`}
      bodyClassName="claude-provider-body" closeDisabled={saving} onClose={() => setDraft(null)}
      onSubmit={event => { event.preventDefault(); void saveResource(); }}
      footer={<><button type="button" className="secondary" disabled={saving} onClick={() => setDraft(null)}>取消</button><button type="submit" className="primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button></>}>
      <label className="claude-field">{mcp ? "服务器名称" : "模板名称"}<input value={draft.name} maxLength={64} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      {mcp
        ? <><label className="claude-field">服务器地址<input placeholder="https://example.com/mcp" value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} /></label>
          <p className="claude-config-help">服务器以停用状态保存。在 Pi 中运行 /reload 后，可在 /mcp 中启用。</p></>
        : <label className="claude-field">模板正文<textarea rows={8} value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} /></label>}
      {draftError && <p className="claude-error" role="alert">{draftError}</p>}
    </SharedDialog>}
  </section>;
}
