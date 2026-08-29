import type { FormEvent } from "react";
import { X } from "lucide-react";
import type { ManagedHostDraft } from "../../shared/types";

type ManagedHostDialogProps = {
  open: boolean;
  draft: ManagedHostDraft;
  saving: boolean;
  onClose: () => void;
  onDraftChange: (draft: ManagedHostDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function ManagedHostDialog({ open, draft, saving, onClose, onDraftChange, onSubmit }: ManagedHostDialogProps) {
  if (!open) return null;
  const update = (changes: Partial<ManagedHostDraft>) => onDraftChange({ ...draft, ...changes });
  return <div className="modal-backdrop"><form className="modal managed-host-modal" onSubmit={onSubmit} onClick={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">MANAGED SERVER</span><h2>{draft.id ? "编辑服务器" : "添加服务器"}</h2></div><button type="button" className="close" disabled={saving} onClick={onClose}><X size={20} /></button></div>
    <p className="security-tip">{draft.platform === "windows" ? "RDP 连接资料会使用本机密钥加密保存，打开连接时将调用 Windows 远程桌面。" : draft.auth_method === "private_key" ? "SSH 私钥与可选口令会使用本机密钥加密保存。首次成功连接时会记录服务器主机指纹。" : "SSH 密码会使用本机密钥加密保存。首次成功连接时会记录服务器主机指纹，后续变化将被拒绝。"}</p>
    <label>服务器名称<input required value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如：生产 Web 01" autoFocus /></label>
    <div className="managed-host-choice"><span>操作系统</span><div className="ssh-segmented"><button type="button" className={draft.platform === "linux" ? "active" : ""} onClick={() => update({ platform: "linux", auth_method: "password", port: draft.port === 3389 ? 22 : draft.port, username: draft.username === "administrator" ? "root" : draft.username })}>Linux</button><button type="button" className={draft.platform === "windows" ? "active" : ""} onClick={() => update({ platform: "windows", auth_method: "password", port: draft.port === 22 ? 3389 : draft.port, username: draft.username === "root" ? "administrator" : draft.username })}>Windows</button></div></div>
    <div className="form-grid"><label>主机 / IP<input required value={draft.host} onChange={(event) => update({ host: event.target.value })} placeholder="203.0.113.10 或 server.example.com" /></label><label>{draft.platform === "windows" ? "RDP 端口" : "SSH 端口"}<input required type="number" min={1} max={65535} value={draft.port} onChange={(event) => update({ port: Number(event.target.value) || (draft.platform === "windows" ? 3389 : 22) })} /></label><label>{draft.platform === "windows" ? "RDP 用户名" : "SSH 用户名"}<input required value={draft.username} onChange={(event) => update({ username: event.target.value })} placeholder={draft.platform === "windows" ? "administrator" : "root"} /></label></div>
    {draft.platform === "linux" && <div className="managed-host-choice"><span>验证方式</span><div className="ssh-segmented"><button type="button" className={draft.auth_method === "password" ? "active" : ""} onClick={() => update({ auth_method: "password" })}>密码验证</button><button type="button" className={draft.auth_method === "private_key" ? "active" : ""} onClick={() => update({ auth_method: "private_key", password: "" })}>私钥验证</button></div></div>}
    {draft.platform === "windows" || draft.auth_method === "password" ? <label>{draft.platform === "windows" ? "RDP 密码（可选）" : "SSH 密码"}<input required={draft.platform === "linux" && !draft.id} type="password" value={draft.password} onChange={(event) => update({ password: event.target.value })} placeholder={draft.platform === "windows" ? "留空时由 Windows 远程桌面验证" : draft.id ? "留空则保留已保存密码" : "首次添加必填"} autoComplete="new-password" /></label> : <><label>SSH 私钥<textarea required={!draft.id} rows={5} value={draft.private_key} onChange={(event) => update({ private_key: event.target.value })} placeholder={draft.id ? "留空则保留已保存私钥" : "粘贴 OpenSSH、PKCS#8 或 PEM 格式私钥"} spellCheck={false} /></label><label>私钥口令（可选）<input type="password" value={draft.key_passphrase} onChange={(event) => update({ key_passphrase: event.target.value })} placeholder="未加密私钥可留空" autoComplete="off" /></label></>}
    <div className="form-grid"><label>分组<input value={draft.group_name} onChange={(event) => update({ group_name: event.target.value })} placeholder="生产 / 测试 / 个人" /></label><label>标签<input value={draft.tags} onChange={(event) => update({ tags: event.target.value })} placeholder="web, nginx, cn" /></label></div><label>备注<textarea rows={2} value={draft.remark} onChange={(event) => update({ remark: event.target.value })} placeholder="可选" /></label>
    <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="layui-btn layui-btn-normal" disabled={saving}>{saving ? "保存中…" : draft.id ? "保存修改" : "加入服务器管理"}</button></div>
  </form></div>;
}
