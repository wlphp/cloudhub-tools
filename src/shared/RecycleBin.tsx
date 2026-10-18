import { useMemo, useState, type ReactNode } from "react";
import { RotateCcw, Trash2, TriangleAlert } from "lucide-react";

/** Credential retention options offered in the settings panel. */
export const SCRUB_DAY_OPTIONS = [
  { value: 0, label: "永久保留" },
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
  { value: 365, label: "1 年" },
];

export type TrashKind = {
  /** Stable machine id, e.g. `notes`. */
  id: string;
  label: string;
  items: TrashItem[];
};

export type TrashItem = {
  id: string;
  title: string;
  detail?: string;
  deletedAt: number;
};

export type TrashActions = {
  restore: (kindId: string, ids: string[]) => Promise<void>;
  purge: (kindId: string, ids: string[]) => Promise<void>;
  /** Optional confirmation before irreversible purge; omit when not required. */
  confirmPurge?: (kindId: string, count: number) => boolean;
  /** Called after a successful restore so the host can close the panel. */
  onRestored?: (kindId: string, count: number) => void;
};

const KIND_ICONS: Record<string, ReactNode> = {
  notes: <Trash2 size={14} aria-hidden="true" />,
};

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Shared recycle bin surface. Every soft-deleted data type renders one entry in
 * `kinds`; the panel groups them, and restore/purge dispatch back through the
 * owning feature so each type keeps its own command contract.
 */
export function RecycleBin({ kinds, actions, busy, onClose, scrubDays, onScrubDaysChange, onScrubNow, scrubbedNow }: {
  kinds: TrashKind[];
  actions: TrashActions;
  busy: boolean;
  onClose: () => void;
  /** Credential retention in days; `0` keeps them forever. */
  scrubDays?: number;
  onScrubDaysChange?: (days: number) => void;
  onScrubNow?: () => void;
  /** Rows whose credentials were cleared by the last list call. */
  scrubbedNow?: number;
}) {
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [error, setError] = useState("");
  const total = kinds.reduce((sum, kind) => sum + kind.items.length, 0);

  const groups = useMemo(() => kinds.filter(kind => kind.items.length > 0), [kinds]);

  const run = async (kindId: string, mode: "restore" | "purge") => {
    const ids = [...(selected[kindId] ?? [])];
    if (ids.length === 0) return;
    if (mode === "purge" && actions.confirmPurge && !actions.confirmPurge(kindId, ids.length)) return;
    setError("");
    try {
      if (mode === "restore") {
        await actions.restore(kindId, ids);
        actions.onRestored?.(kindId, ids.length);
      } else {
        await actions.purge(kindId, ids);
      }
      setSelected(current => ({ ...current, [kindId]: new Set() }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : mode === "restore" ? "恢复失败" : "彻底删除失败");
    }
  };

  const toggle = (kindId: string, id: string) => setSelected(current => {
    const next = new Set(current[kindId] ?? []);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { ...current, [kindId]: next };
  });

  return <div className="recycle-bin">
    <div className="recycle-bin-head">
      <strong>回收站</strong>
      <span>{total === 0 ? "暂无已删除的数据" : `${total} 项已删除数据 · 永久保留，手动清空`}</span>
    </div>
    {error && <p className="notes-error" role="alert">{error}</p>}
    {groups.length === 0 ? <p className="recycle-bin-empty">删除的云账号、面板、证书和备忘录会出现在这里，可随时恢复。</p> : groups.map(kind => {
      const chosen = selected[kind.id] ?? new Set<string>();
      const all = kind.items.length;
      return <section key={kind.id} className="recycle-bin-group">
        <header>
          <span className="recycle-bin-kind">{KIND_ICONS[kind.id]}{kind.label}<small>{all}</small></span>
          <span className="recycle-bin-group-actions">
            <button type="button" className="secondary" disabled={busy || chosen.size === 0} onClick={() => void run(kind.id, "restore")}><RotateCcw size={13} aria-hidden="true" />恢复{chosen.size > 0 ? ` (${chosen.size})` : ""}</button>
            <button type="button" className="secondary notes-danger" disabled={busy || chosen.size === 0} onClick={() => void run(kind.id, "purge")}><TriangleAlert size={13} aria-hidden="true" />彻底删除{chosen.size > 0 ? ` (${chosen.size})` : ""}</button>
          </span>
        </header>
        <ul>
          {kind.items.map(item => <li key={item.id}>
            <label className="recycle-bin-item">
              <input type="checkbox" checked={chosen.has(item.id)} onChange={() => toggle(kind.id, item.id)} aria-label={`选择 ${item.title}`} />
              <span className="recycle-bin-item-copy">
                <strong>{item.title}</strong>
                {item.detail && <small>{item.detail}</small>}
              </span>
              <time dateTime={new Date(item.deletedAt).toISOString()}>{formatWhen(item.deletedAt)}</time>
            </label>
          </li>)}
        </ul>
      </section>;
    })}
    {onScrubDaysChange && onScrubNow && scrubDays !== undefined && <section className="recycle-bin-scrub">
      <div className="recycle-bin-scrub-copy">
        <strong>凭据自动清理</strong>
        <small>已删除的数据会永久保留，但其中的账号密钥、证书私钥和登录令牌会在删除超过下面的天数后清空，缩小本机密钥留存面。清理后仍可恢复记录本身，密钥需要重新填写。</small>
      </div>
      <div className="recycle-bin-scrub-actions">
        <select aria-label="凭据保留天数" value={scrubDays} disabled={busy} onChange={event => onScrubDaysChange(Number(event.target.value))}>
          {SCRUB_DAY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <button type="button" className="secondary" disabled={busy} onClick={onScrubNow} title="立即清空回收站中所有数据的密钥字段">立即清理密钥</button>
      </div>
      {scrubbedNow ? <p className="recycle-bin-scrub-note" role="status">本次打开时已清理 {scrubbedNow} 项过期密钥。</p> : null}
    </section>}
    <footer className="recycle-bin-foot">
      <button type="button" className="secondary" onClick={onClose}>关闭</button>
    </footer>
  </div>;
}
