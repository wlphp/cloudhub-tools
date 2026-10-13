import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Pencil, Play, Plus, Send, Terminal, Trash2, X } from "lucide-react";
import { AiAssistButton } from "../ai/AiAssistButton";

export type TerminalQuickCommand = { id: string; name: string; command: string };

type Props = {
  commands: TerminalQuickCommand[];
  connected: boolean;
  onChange: (commands: TerminalQuickCommand[]) => void;
  onInsert: (command: string, execute: boolean) => void;
};

export function TerminalQuickCommands({ commands, connected, onChange, onInsert }: Props) {
  const [editing, setEditing] = useState<TerminalQuickCommand | null>(null);
  const [draft, setDraft] = useState({ name: "", command: "" });

  function openEditor(command?: TerminalQuickCommand) {
    setEditing(command || { id: crypto.randomUUID(), name: "", command: "" });
    setDraft(command ? { name: command.name, command: command.command } : { name: "", command: "" });
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const name = draft.name.trim();
    const command = draft.command.trim();
    if (!editing || !name || !command) return;
    const nextCommand = { ...editing, name, command };
    const next = commands.some((item) => item.id === editing.id)
      ? commands.map((item) => item.id === editing.id ? nextCommand : item)
      : [...commands, nextCommand];
    onChange(next);
    setEditing(null);
  }

  return <section className="terminal-quick-commands" aria-label="常用命令">
    <div className="terminal-quick-toolbar">
      <span><Terminal size={14} />点击“填入”写入当前终端</span>
      <button type="button" className="terminal-quick-add" disabled={commands.length >= 30} title={commands.length >= 30 ? "最多保存 30 条命令" : undefined} onClick={() => openEditor()}><Plus size={14} />添加命令</button>
    </div>
    <AiAssistButton task="command" title="AI 生成命令" disabled={commands.length>=30} onApply={({fields})=>{const command=String(fields.command||"");if(!command.trim()||command.length>2000)throw new Error("请提供不超过2000字的命令草稿");setEditing({id:crypto.randomUUID(),name:"",command:""});setDraft({name:String(fields.name||"AI命令草稿").slice(0,80),command});}} />
    <div className="terminal-quick-list">
      {commands.map((item) => <article className="terminal-quick-card" key={item.id}>
        <div className="terminal-quick-copy"><strong title={item.name}>{item.name}</strong><code title={item.command}>{item.command}</code></div>
        <div className="terminal-quick-actions">
          <button type="button" title="编辑命令" aria-label={`编辑命令 ${item.name}`} onClick={() => openEditor(item)}><Pencil size={13} /></button>
          <button type="button" className="terminal-quick-delete" title="删除命令" aria-label={`删除命令 ${item.name}`} onClick={() => onChange(commands.filter((command) => command.id !== item.id))}><Trash2 size={13} /></button>
          <button type="button" className="terminal-quick-fill" disabled={!connected} title={connected ? "填入当前终端，不执行" : "先连接 SSH 服务器"} onClick={() => onInsert(item.command, false)}><Send size={13} />填入</button>
          <button type="button" className="terminal-quick-run" disabled={!connected} title={connected ? "立即执行此命令" : "先连接 SSH 服务器"} onClick={() => onInsert(item.command, true)}><Play size={13} />执行</button>
        </div>
      </article>)}
      {commands.length === 0 && <div className="terminal-quick-empty"><Terminal size={25} /><strong>还没有常用命令</strong><span>把常用的安装或维护命令保存在这里</span><button type="button" onClick={() => openEditor()}><Plus size={14} />添加第一条命令</button></div>}
    </div>
    {editing && createPortal(<div className="ide-theme terminal-quick-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}>
      <form className="terminal-quick-dialog" role="dialog" aria-modal="true" aria-labelledby="terminal-quick-dialog-title" onSubmit={save} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setEditing(null); } }}>
        <div className="terminal-quick-dialog-head"><strong id="terminal-quick-dialog-title">{commands.some((item) => item.id === editing.id) ? "编辑常用命令" : "添加常用命令"}</strong><button type="button" title="关闭" aria-label="关闭" onClick={() => setEditing(null)}><X size={16} /></button></div>
        <label>名称<input autoFocus maxLength={80} value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} placeholder="例如：查看磁盘空间" /></label>
        <label>命令<textarea required rows={5} maxLength={2000} spellCheck={false} value={draft.command} onChange={(event) => setDraft((value) => ({ ...value, command: event.target.value }))} placeholder="输入要保存的终端命令" /></label>
        <p>命令会随“数据库迁移 · 导出全部 / 导入全部”迁移。填入不会执行；执行操作需要单独点击。</p>
        <div className="terminal-quick-dialog-actions"><button type="button" onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={!draft.name.trim() || !draft.command.trim()}>保存</button></div>
      </form>
    </div>, document.body)}
  </section>;
}
