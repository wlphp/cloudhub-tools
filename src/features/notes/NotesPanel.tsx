import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bell, BellOff, Copy, Edit3, Eye, EyeOff, FolderCog, KeyRound, NotebookPen, Pin, PinOff, Plus, Search, StickyNote, Tag, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SharedDialog } from "../../shared/SharedDialog";
import { GroupNameInput } from "../../shared/GroupNameInput";
import { RecycleBin, type TrashKind } from "../../shared/RecycleBin";
import { SecretField } from "../../shared/SecretField";
import { notesClient, type Note, type NoteInput } from "../../platform/clients/notes";
import "./notes.css";

const REPEATS = [
  { value: "none", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
] as const;
type Repeat = (typeof REPEATS)[number]["value"];

const pad = (value: number) => String(value).padStart(2, "0");
/** `<input type="datetime-local">` expects local wall-clock time without a zone. */
function toLocalInput(timestamp: number | null): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const repeatLabel = (value: string) => REPEATS.find(item => item.value === value)?.label ?? "不重复";

const emptyDraft = (group: string): NoteInput => ({
  title: "", body: "", group, tags: [], account: "", password: "", pinned: false, remindAt: null, remindRepeat: "none",
});
const draftOf = (note: Note): NoteInput => ({
  id: note.id, title: note.title, body: note.body, group: note.group, tags: note.tags, account: note.account,
  password: note.password, pinned: note.pinned, remindAt: note.remindAt, remindRepeat: note.remindRepeat,
});

/** Shared dialog base: `.modal-backdrop` + `.modal.modal-form-layout` + `.modal-head` / `.modal-body` / `.modal-actions`. */
function Dialog({ title, subtitle, icon, children, onClose, footer, onSubmit }: { title: string; subtitle?: string; icon: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; onSubmit?: (event: FormEvent<HTMLFormElement>) => void }) {
  return <SharedDialog title={title} subtitle={subtitle} icon={icon} className="notes-dialog" bodyClassName="notes-dialog-content" onClose={onClose} footer={footer} onSubmit={onSubmit}>{children}</SharedDialog>;
}

async function copyText(value: string, setMessage: (text: string) => void, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    setMessage(`已复制${what}`);
  } catch {
    setMessage(`无法复制${what}，请手动选择文本`);
  }
}

type EditorProps = { draft: NoteInput; groups: string[]; onClose: () => void; onSaved: (id: number) => void };

function NoteEditor({ draft: initial, groups, onClose, onSaved }: EditorProps) {
  const [draft, setDraft] = useState(initial);
  const [tagText, setTagText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (value: Partial<NoteInput>) => setDraft(current => ({ ...current, ...value }));
  const addTag = () => {
    const tag = tagText.trim();
    if (!tag) return;
    if (!draft.tags.includes(tag)) patch({ tags: [...draft.tags, tag] });
    setTagText("");
  };
  const toggleRepeat = (remindRepeat: Repeat) => patch({ remindRepeat, remindAt: remindRepeat === "none" ? null : draft.remindAt });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!draft.title.trim()) { setError("请填写标题"); return; }
    if (!draft.group.trim()) { setError("请选择或填写分组"); return; }
    setBusy(true); setError("");
    try {
      const id = await notesClient.save({ ...draft, remindAt: draft.remindRepeat === "none" ? null : draft.remindAt });
      onSaved(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存备忘录失败");
    } finally { setBusy(false); }
  }

  return <Dialog title={initial.id ? "编辑备忘录" : "新建备忘录"} subtitle="内容与凭据仅保存在本机数据库" icon={<StickyNote size={20} aria-hidden="true" />} onClose={onClose} onSubmit={event => void submit(event)}
    footer={<><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? "保存中…" : "保存"}</button></>}>
      <div className="notes-dialog-body">
        <label className="notes-field">标题<input value={draft.title} maxLength={200} required autoFocus onChange={event => patch({ title: event.target.value })} placeholder="例如：生产环境 SSH 账号" /></label>
        <label className="notes-field">正文<textarea className="notes-body-input" aria-label="正文" value={draft.body} maxLength={200000} onChange={event => patch({ body: event.target.value })} placeholder="记录详情、命令、注意事项……" /></label>
        <div className="notes-field-row">
          <label className="notes-field">分组<GroupNameInput groups={groups} value={draft.group} maxLength={20} onChange={event => patch({ group: event.target.value })} /></label>
          <label className="notes-check"><input type="checkbox" checked={draft.pinned} onChange={event => patch({ pinned: event.target.checked })} /><span>置顶显示</span></label>
        </div>
        <div className="notes-field notes-field-block">
          <span className="notes-field-label" id="notes-tag-label">标签</span>
          <div className="notes-tag-input">
            <input aria-labelledby="notes-tag-label" value={tagText} maxLength={16} onChange={event => setTagText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addTag(); } }} placeholder="输入后按回车添加，如 代码、账号密码" />
            <button type="button" className="secondary" onClick={addTag} disabled={!tagText.trim() || draft.tags.length >= 20}><Tag size={14} aria-hidden="true" />添加</button>
          </div>
          {draft.tags.length > 0 ? <div className="notes-tags" aria-label="已添加标签">{draft.tags.map(tag => <span key={tag} className="notes-tag is-removable">{tag}<button type="button" aria-label={`移除标签 ${tag}`} title="移除标签" onClick={() => patch({ tags: draft.tags.filter(item => item !== tag) })}><X size={11} aria-hidden="true" /></button></span>)}</div>
            : <small className="notes-field-help">最多 20 个标签，用于检索时快速定位。</small>}
        </div>
        <fieldset className="notes-group">
          <legend><KeyRound size={12} aria-hidden="true" /> 账号密码</legend>
          <small className="notes-field-help">明文保存在本地数据库，不做加密；请勿存放生产环境高权限凭据。</small>
          <div className="notes-field-row">
            <label className="notes-field">账号<input value={draft.account} maxLength={512} autoComplete="off" spellCheck={false} onChange={event => patch({ account: event.target.value })} placeholder="可选" /></label>
            <label className="notes-field">密码<SecretField secretLabel="密码" value={draft.password} maxLength={2048} autoComplete="new-password" spellCheck={false} onChange={event => patch({ password: event.target.value })} placeholder="可选" /></label>
          </div>
        </fieldset>
        <fieldset className="notes-group">
          <legend><Bell size={12} aria-hidden="true" /> 定时提醒</legend>
          <div className="notes-schedule-row">
            <label className="notes-field">提醒时间<input type="datetime-local" aria-label="提醒时间" value={toLocalInput(draft.remindAt)} onChange={event => patch({ remindAt: fromLocalInput(event.target.value) })} /></label>
            <label className="notes-field">重复<select aria-label="提醒重复方式" value={draft.remindRepeat} onChange={event => toggleRepeat(event.target.value as Repeat)}>{REPEATS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <button type="button" className="secondary" onClick={() => patch({ remindAt: Date.now() + 60 * 60 * 1000 })}>一小时后</button>
            {(draft.remindAt || draft.remindRepeat !== "none") && <button type="button" className="secondary" onClick={() => patch({ remindAt: null, remindRepeat: "none" })}><BellOff size={14} aria-hidden="true" />清除</button>}
          </div>
          <small className="notes-field-help">到点通过桌宠提醒。提醒时间需晚于当前时间；在桌宠提醒里点“完成”后，重复提醒会自动安排下一次。</small>
        </fieldset>
        {error && <p className="notes-error" role="alert">{error}</p>}
      </div>
  </Dialog>;
}

function NoteViewer({ note, due, onClose, onEdit, setMessage }: { note: Note; due: boolean; onClose: () => void; onEdit: () => void; setMessage: (text: string) => void }) {
  const [revealed, setRevealed] = useState(false);
  return <Dialog title={note.title} subtitle={`${note.group} · 更新于 ${formatTime(note.updatedAt)}`} icon={<StickyNote size={20} aria-hidden="true" />} onClose={onClose}
    footer={<><button type="button" className="secondary" onClick={onClose}>关闭</button><button type="button" className="primary" onClick={onEdit}><Edit3 size={14} aria-hidden="true" />编辑</button></>}>
    <div className="notes-view-body">
      <div className="notes-view-meta">
        {note.pinned && <span className="notes-view-flag"><Pin size={12} aria-hidden="true" />已置顶</span>}
        {due && <span className="notes-badge"><Bell size={11} aria-hidden="true" />待提醒</span>}
        {note.remindAt && <span className="notes-view-flag"><Bell size={12} aria-hidden="true" />{repeatLabel(note.remindRepeat)} {formatTime(note.remindAt)}</span>}
        {note.tags.map(tag => <span key={tag} className="notes-tag">{tag}</span>)}
      </div>
      {note.body ? <div className="notes-view-text">{note.body}</div> : <p className="notes-view-empty">这条备忘录没有正文。</p>}
      {(note.account || note.password) && <div className="notes-view-secrets">
        <small className="notes-field-help">账号密码为明文保存在本机数据库，不做加密。</small>
        {note.account && <div className="notes-secret">
          <KeyRound size={13} aria-hidden="true" /><span className="notes-secret-label">账号</span>
          <code>{note.account}</code>
          <button type="button" aria-label={`复制账号 ${note.title}`} title="复制账号" onClick={() => void copyText(note.account, setMessage, "账号")}><Copy size={13} aria-hidden="true" /></button>
        </div>}
        {note.password && <div className="notes-secret">
          <Eye size={13} aria-hidden="true" /><span className="notes-secret-label">密码</span>
          <code className={revealed ? "" : "is-masked"}>{revealed ? note.password : "••••••••"}</code>
          <button type="button" aria-label={revealed ? `隐藏密码 ${note.title}` : `显示密码 ${note.title}`} title={revealed ? "隐藏密码" : "显示密码"} aria-pressed={revealed} onClick={() => setRevealed(value => !value)}>{revealed ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}</button>
          <button type="button" aria-label={`复制密码 ${note.title}`} title="复制密码" onClick={() => void copyText(note.password, setMessage, "密码")}><Copy size={13} aria-hidden="true" /></button>
        </div>}
      </div>}
    </div>
  </Dialog>;
}

function GroupManager({ groups, onClose, onChanged }: { groups: string[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState(groups.find(group => group !== "") ?? "");
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const targets = groups.filter(group => group !== pending && group !== name.trim());

  async function run(action: () => Promise<void>, failure: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : failure); }
    finally { setBusy(false); }
  }

  return <Dialog title="管理分组" subtitle="删除分组时，其备忘录会迁移到目标分组" icon={<FolderCog size={20} aria-hidden="true" />} onClose={onClose}
    onSubmit={event => { event.preventDefault(); void run(async () => { await notesClient.saveGroup(name); setName(""); }, "保存分组失败"); }}
    footer={<button type="button" className="secondary" onClick={onClose}>关闭</button>}>
      <div className="notes-dialog-body">
        <div className="notes-field-row notes-field-row-tight">
          <label className="notes-field">新建分组<input value={name} maxLength={20} onChange={event => setName(event.target.value)} placeholder="例如：公司、个人、运维" /></label>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>创建分组</button>
        </div>
        <ul className="notes-group-list" aria-label="分组列表">
          {groups.map(group => <li key={group} className="notes-group-item">
            {pending === group ? <>
              <strong>删除“{group}”，笔记移动到</strong>
              <div className="notes-schedule-row">
                <select aria-label="目标分组" value={target} onChange={event => setTarget(event.target.value)}>{targets.map(item => <option key={item} value={item}>{item}</option>)}</select>
                <button type="button" className="notes-danger" disabled={busy || !target || targets.length === 0} onClick={() => void run(async () => { await notesClient.deleteGroup(group, target); setPending(""); }, "删除分组失败")}>确认删除</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setPending("")}>取消</button>
              </div>
            </> : <>
              <span className="notes-group-name">{group}</span>
              <button type="button" className="secondary" aria-label={`删除分组 ${group}`} disabled={busy || groups.length <= 1} title={groups.length <= 1 ? "至少保留一个分组" : "删除分组并迁移笔记"} onClick={() => { setTarget(groups.find(item => item !== group) ?? ""); setPending(group); }}><Trash2 size={14} aria-hidden="true" />删除</button>
            </>}
          </li>)}
        </ul>
        {error && <p className="notes-error" role="alert">{error}</p>}
      </div>
  </Dialog>;
}

function ReminderActions({ busy, complete, snooze }: { busy: boolean; complete: () => void; snooze: (minutes: number) => void }) {
  return <div className="notes-reminder-actions">
    <span className="notes-badge"><Bell size={11} aria-hidden="true" />待提醒</span>
    <button type="button" className="secondary" disabled={busy} onClick={complete}>完成</button>
    <button type="button" className="secondary" disabled={busy} onClick={() => snooze(10)}>10 分钟后</button>
    <button type="button" className="secondary" disabled={busy} onClick={() => snooze(60)}>1 小时后</button>
  </div>;
}

interface NotesPanelProps { mobile?: boolean; openSignal?: number }

export function NotesPanel({ openSignal = 0 }: NotesPanelProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [dueIds, setDueIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState("all");
  const [editor, setEditor] = useState<NoteInput | null>(null);
  const [viewerId, setViewerId] = useState<number | null>(null);
  const [managing, setManaging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Note | null>(null);
  const [trashed, setTrashed] = useState<Note[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const snapshot = await notesClient.snapshot();
      if (!alive.current) return;
      setNotes(snapshot.notes);
      setGroups(snapshot.groups);
      setDueIds(snapshot.reminders.map(item => item.noteId));
      setTrashed(snapshot.trashed ?? []);
      setError("");
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "读取备忘录失败");
    } finally { if (alive.current) setLoading(false); }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [load]);

  // Coming back from the pet alert refreshes the reminder badges.
  useEffect(() => { if (openSignal > 0) void load(true); }, [openSignal, load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);
  useEffect(() => {
    if (!message && !error) return;
    const timer = window.setTimeout(() => { setMessage(""); setError(""); }, error ? 10000 : 6000);
    return () => window.clearTimeout(timer);
  }, [message, error]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const note of notes) map.set(note.group, (map.get(note.group) ?? 0) + 1);
    return map;
  }, [notes]);
  const tags = useMemo(() => [...new Set(notes.flatMap(note => note.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [notes]);
  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    const inGroup = notes.filter(note => group === "all" || note.group === group);
    if (!needle) return inGroup;
    const terms = needle.split(/\s+/);
    return inGroup.filter(note => {
      const haystack = [note.title, note.body, note.account, ...note.tags].join("\n").toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
  }, [notes, keyword, group]);

  async function act(action: () => Promise<unknown>, failure: string, done?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      if (done) setMessage(done);
      await load(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : failure); }
    finally { setBusy(false); }
  }

  const startEdit = (note: Note) => setEditor(draftOf(note));
  const startCreate = () => setEditor(emptyDraft(group === "all" ? groups[0] ?? "" : group));
  // Resolved at render so the viewer always shows the latest loaded copy after a refresh.
  const viewer = viewerId === null ? null : notes.find(note => note.id === viewerId) ?? null;

  return <section className="notes-panel" aria-busy={loading}>
    <header className="notes-header">
      <div className="notes-heading">
        <h1><NotebookPen size={19} aria-hidden="true" />备忘录</h1>
        <p>本机存储 · {notes.length} 条笔记 · {groups.length} 个分组{notes.some(note => note.password) && " · 账号密码为明文存储"}</p>
      </div>
      <div className="notes-header-actions">
        <button type="button" className="secondary" onClick={() => setShowTrash(true)} aria-label={`回收站，${trashed.length} 项`}><Trash2 size={14} aria-hidden="true" />回收站{trashed.length > 0 ? ` (${trashed.length})` : ""}</button>
        <button type="button" className="secondary" onClick={() => setManaging(true)}><FolderCog size={14} aria-hidden="true" />管理分组</button>
        <button type="button" className="primary" onClick={startCreate}><Plus size={14} aria-hidden="true" />新建备忘录</button>
      </div>
    </header>
    <div className="notes-toolbar">
      <label className="notes-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="检索备忘录" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="检索标题、正文、账号和标签" /></label>
      <span className="notes-result-count" role="status">{visible.length} / {notes.length}</span>
    </div>
    {(groups.length > 0 || tags.length > 0) && <div className="notes-filter-bar">
      {groups.length > 0 && <div className="notes-filters" role="group" aria-label="按分组筛选">
        <button type="button" className="notes-chip" aria-pressed={group === "all"} onClick={() => setGroup("all")}>全部 <small>{notes.length}</small></button>
        {groups.map(item => <button type="button" key={item} className="notes-chip" aria-pressed={group === item} onClick={() => setGroup(item)}>{item} <small>{counts.get(item) ?? 0}</small></button>)}
      </div>}
      {tags.length > 0 && <div className="notes-filters notes-tag-filters" aria-label="按标签筛选">
        <span className="notes-filter-label"><Tag size={12} aria-hidden="true" />标签</span>
        {tags.map(tag => <button type="button" key={tag} className="notes-chip" aria-pressed={keyword === tag} onClick={() => setKeyword(current => current === tag ? "" : tag)}>{tag}</button>)}
      </div>}
    </div>}
    {(message || error) && <p className={`notes-status${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{error || message}</p>}
    {loading && notes.length === 0 ? <div className="notes-empty">
      <StickyNote size={26} aria-hidden="true" />
      <strong>正在读取备忘录…</strong>
    </div> : visible.length === 0 ? <div className="notes-empty">
      <StickyNote size={26} aria-hidden="true" />
      <strong>{notes.length === 0 ? "还没有备忘录" : "没有符合条件的备忘录"}</strong>
      <p>{notes.length === 0 ? "新建第一条笔记，按分组整理，并用标签检索。" : "尝试调整检索词、切换分组或取消标签筛选。"}</p>
      {notes.length === 0 && <button type="button" className="primary" onClick={startCreate}><Plus size={14} aria-hidden="true" />新建备忘录</button>}
    </div> : <div className="notes-grid">
      {visible.map(note => <article key={note.id} className={`notes-card${note.pinned ? " is-pinned" : ""}`}>
        <div className="notes-card-head">
          <div className="notes-card-title">
            {note.pinned && <Pin size={13} aria-hidden="true" />}
            <strong>{note.title}</strong>
          </div>
          {dueIds.includes(note.id) && <span className="notes-badge"><Bell size={11} aria-hidden="true" />待提醒</span>}
        </div>
        <div className="notes-card-meta">
          <span className="notes-card-group">{note.group}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(note.updatedAt).toISOString()}>{formatTime(note.updatedAt)}</time>
          {note.remindAt && <><span aria-hidden="true">·</span><span className="notes-card-remind"><Bell size={11} aria-hidden="true" />{repeatLabel(note.remindRepeat)} {formatTime(note.remindAt)}</span></>}
        </div>
        {note.body && <p className="notes-card-body">{note.body}</p>}
        {note.tags.length > 0 && <div className="notes-tags">{note.tags.map(tag => <span key={tag} className="notes-tag">{tag}</span>)}</div>}
        {(note.account || note.password) && <div className="notes-secrets">
          {note.account && <div className="notes-secret"><KeyRound size={12} aria-hidden="true" /><code>{note.account}</code><button type="button" aria-label={`复制账号 ${note.title}`} title="复制账号" onClick={() => void copyText(note.account, setMessage, "账号")}><Copy size={12} aria-hidden="true" /></button></div>}
          {note.password && <div className="notes-secret"><Eye size={12} aria-hidden="true" /><code aria-label="密码已隐藏">••••••••</code><button type="button" aria-label={`复制密码 ${note.title}`} title="复制密码" onClick={() => void copyText(note.password, setMessage, "密码")}><Copy size={12} aria-hidden="true" /></button></div>}
        </div>}
        {dueIds.includes(note.id) && <ReminderActions busy={busy} complete={() => void act(() => notesClient.completeReminder(note.id), "完成提醒失败", "已完成本次提醒")} snooze={minutes => void act(() => notesClient.snoozeReminder(note.id, minutes), "稍后提醒失败", `已推迟 ${minutes} 分钟`)} />}
        <div className="notes-card-actions">
          <button type="button" className="secondary" aria-label={`查看 ${note.title}`} onClick={() => setViewerId(note.id)}><Eye size={13} aria-hidden="true" />查看</button>
          <button type="button" className="secondary" aria-label={`编辑 ${note.title}`} disabled={busy} onClick={() => startEdit(note)}><Edit3 size={13} aria-hidden="true" />编辑</button>
          <button type="button" className="secondary" aria-label={note.pinned ? `取消置顶 ${note.title}` : `置顶 ${note.title}`} disabled={busy} onClick={() => void act(() => notesClient.save({ ...draftOf(note), pinned: !note.pinned }), "更新置顶失败")}>{note.pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}{note.pinned ? "取消置顶" : "置顶"}</button>
          <button type="button" className="secondary notes-danger" aria-label={`删除 ${note.title}`} disabled={busy} onClick={() => setConfirmDelete(note)}><Trash2 size={13} aria-hidden="true" />删除</button>
        </div>
      </article>)}
    </div>}
    {editor && <NoteEditor draft={editor} groups={groups} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setMessage("已保存备忘录"); void load(true); }} />}
    {viewer && <NoteViewer note={viewer} due={dueIds.includes(viewer.id)} setMessage={setMessage} onClose={() => setViewerId(null)} onEdit={() => { setEditor(draftOf(viewer)); setViewerId(null); }} />}
    {managing && <GroupManager groups={groups} onClose={() => setManaging(false)} onChanged={() => load(true)} />}
    {showTrash && <Dialog title="回收站" subtitle="删除的数据永久保留，可恢复或彻底删除" icon={<Trash2 size={20} aria-hidden="true" />} onClose={() => setShowTrash(false)}>
      <RecycleBin
        busy={busy}
        kinds={[{ id: "notes", label: "备忘录", items: trashed.map(note => ({ id: String(note.id), title: note.title, detail: note.group, deletedAt: note.deletedAt ?? note.updatedAt })) } satisfies TrashKind]}
        actions={{
          restore: async (_kind, ids) => { await act(() => notesClient.restore(ids.map(Number)), "恢复备忘录失败", "已恢复备忘录"); },
          purge: async (_kind, ids) => { await act(() => notesClient.purge(ids.map(Number)), "彻底删除失败", "已彻底删除"); },
          confirmPurge: () => window.confirm("彻底删除后无法恢复，确定继续吗？"),
          // Restoring is the terminal action here, so the bin closes itself.
          onRestored: () => setShowTrash(false),
        }}
        onClose={() => setShowTrash(false)} />
    </Dialog>}
    {confirmDelete && createPortal(<ConfirmDialog title="删除备忘录" message={`确定删除“${confirmDelete.title}”吗？删除后会进入回收站，可以随时恢复。`} confirmLabel="移到回收站" busy={busy} error={error || undefined}
      onResolve={confirmed => {
        if (!confirmed) { setConfirmDelete(null); return; }
        void act(() => notesClient.remove([confirmDelete.id]), "删除备忘录失败", "已删除备忘录").then(() => setConfirmDelete(null));
      }} />, document.body)}
  </section>;
}
