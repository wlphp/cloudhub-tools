import { useState } from "react";
import { FolderPlus } from "lucide-react";
import type { CodexAccount } from "../../platform/clients/codex";
import { OverviewDialog } from "./OverviewDialogs";
import type { AccountGroup } from "./overviewPreferences";

export function AccountGroupsDialog({ groups, accounts, busy, error, onSave, onClose }: { groups: AccountGroup[]; accounts: CodexAccount[]; busy: boolean; error: string; onSave: (groups: AccountGroup[]) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(groups);
  const [active, setActive] = useState(groups[0]?.id ?? "");
  const [name, setName] = useState("");
  const current = draft.find(group => group.id === active);
  return <OverviewDialog title="管理 Codex 分组" busy={busy} onClose={onClose} className="codex-groups-dialog" footer={<><button disabled={busy} onClick={onClose}>取消</button><button className="codex-dialog-primary" disabled={busy || draft.some(group => !group.name.trim()) || new Set(draft.map(group => group.name.trim())).size !== draft.length} onClick={() => void onSave(draft.map(group => ({ ...group, name: group.name.trim() })))}>保存分组</button></>}>
    <p className="codex-groups-help">一个账号可加入多个分组。移除分组不会删除账号，修改在保存后生效。</p>
    <form className="codex-group-create-form" onSubmit={event => { event.preventDefault(); const trimmed = name.trim(); if (!trimmed || draft.length >= 100 || draft.some(group => group.name === trimmed)) return; const id = crypto.randomUUID(); setDraft([...draft, { id, name: trimmed, accountIds: [] }]); setActive(id); setName(""); }}>
      <label>新分组名称<input aria-label="新分组名称" value={name} maxLength={40} disabled={busy} onChange={event => setName(event.target.value)} /></label><button className="codex-dialog-primary" disabled={busy || !name.trim() || draft.length >= 100 || draft.some(group => group.name === name.trim())}>创建分组</button>
    </form>
    {!draft.length ? <div className="codex-groups-empty"><FolderPlus size={26} /><strong>还没有分组</strong><span>创建一个分组，再为它选择账号。</span></div> : <>
      <label className="codex-group-select-label">编辑分组<select aria-label="编辑分组" value={active} disabled={busy} onChange={event => setActive(event.target.value)}>{draft.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      {current && <><label>分组名称<input aria-label="分组名称" value={current.name} maxLength={40} disabled={busy} onChange={event => setDraft(draft.map(group => group.id === active ? { ...group, name: event.target.value } : group))} /></label>
        <fieldset className="codex-group-picker" disabled={busy}><legend>分组成员 <span>{current.accountIds.length} 个账号</span></legend>{accounts.length ? accounts.map(account => <label key={account.id}><input type="checkbox" aria-label={`将 ${account.label} 加入分组`} checked={current.accountIds.includes(account.id)} onChange={event => setDraft(draft.map(group => group.id === active ? { ...group, accountIds: event.target.checked ? [...group.accountIds, account.id] : group.accountIds.filter(id => id !== account.id) } : group))} />{account.label}</label>) : <small>添加账号后，可在这里管理分组成员。</small>}</fieldset>
        <button className="codex-group-remove" disabled={busy} onClick={() => { setDraft(draft.filter(group => group.id !== active)); setActive(draft.find(group => group.id !== active)?.id ?? ""); }}>移除当前分组</button></>}
    </>}
    {error && <p className="codex-card-error" role="alert">{error}</p>}
  </OverviewDialog>;
}
