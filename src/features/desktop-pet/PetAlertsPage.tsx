import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { PaginationBar } from "../../shared/PaginationBar";
import { platformErrorMessage } from "../../platform/api";
import { desktopPetClient as client, petSeverityLabel, sortPetAlerts, type PetAlert, type PetSnapshot } from "../../platform/clients/desktopPet";

type AlertFilter = "active" | "recovered" | "muted";

const pageSize = 6;
const filters: { id: AlertFilter; label: string; empty: string }[] = [
  { id: "active", label: "未解除", empty: "暂无未解除提醒" },
  { id: "recovered", label: "已解除", empty: "暂无已解除提醒" },
  { id: "muted", label: "已静音", empty: "暂无静音提醒" },
];

function alertFilter(alert: PetAlert): AlertFilter {
  if (alert.ignored) return "muted";
  return alert.active ? "active" : "recovered";
}

export function PetAlertsPage({ snapshot, monitoring, initialAlert, onSnapshotChange }: {
  snapshot: PetSnapshot;
  monitoring: boolean;
  initialAlert: PetAlert | null;
  onSnapshotChange: (snapshot: PetSnapshot) => void;
}) {
  const [filter, setFilter] = useState<AlertFilter>(() => initialAlert ? alertFilter(initialAlert) : "active");
  const [page, setPage] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const initialItem = useRef<HTMLElement>(null);
  const counts = { active: 0, recovered: 0, muted: 0 };
  for (const alert of snapshot.alerts) counts[alertFilter(alert)]++;
  const alerts = sortPetAlerts(snapshot.alerts.filter(alert => alertFilter(alert) === filter));
  const focusedIndex = initialAlert ? alerts.findIndex(alert => alert.key === initialAlert.key) : -1;
  const pageCount = Math.max(1, Math.ceil(alerts.length / pageSize));
  const selectedPage = Math.min(page ?? Math.floor(Math.max(focusedIndex, 0) / pageSize) + 1, pageCount);

  useEffect(() => {
    if (page !== null && page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  useEffect(() => {
    if (page === null && focusedIndex >= 0) initialItem.current?.scrollIntoView({ block: "nearest" });
    else if (list.current) list.current.scrollTop = 0;
  }, [page, filter, selectedPage, focusedIndex]);

  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await action(); }
    catch (e) { setError(platformErrorMessage(e)); }
    finally { setBusy(false); }
  }

  function mute(keys: string[], ignored: boolean) {
    return act(async () => onSnapshotChange(await client.ignore(keys, ignored)));
  }

  return <div className="pet-chat-alerts">
    <div className="pet-chat-alert-summary">
      <span>{monitoring ? "巡检已开启" : "巡检已暂停"}</span>
      <span>{snapshot.checkedAt ? `最近检查 ${new Date(snapshot.checkedAt * 1000).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "尚未检查"}</span>
    </div>
    {snapshot.lastError && <p className="pet-chat-error" role="alert">{snapshot.lastError}</p>}
    {error && <p className="pet-chat-error" role="alert">{error}</p>}
    <div className="pet-alert-tools">
      <div className="pet-alert-filters" role="group" aria-label="提醒状态筛选">
        {filters.map(({ id, label }) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => { setFilter(id); setPage(1); }}>{label} <span>{counts[id]}</span></button>)}
      </div>
      {filter === "active" && counts.active > 0 && <button type="button" className="pet-chat-pill" disabled={busy} title="将所有未解除提醒静音，后台仍会继续巡检" onClick={() => void mute(alerts.map(alert => alert.key), true)}>全部静音</button>}
    </div>
    <div className="pet-alert-list" ref={list} aria-label="运维提醒列表">
      {!alerts.length && <div className="pet-alert-empty">
        <Check size={22} aria-hidden="true" />
        <strong>{filters.find(item => item.id === filter)?.empty}</strong>
        {filter === "active" && <p>未获取到数据的资源不视为正常。</p>}
      </div>}
      {alerts.slice((selectedPage - 1) * pageSize, selectedPage * pageSize).map(alert => {
        const focused = alert.key === initialAlert?.key;
        return <article key={alert.key} ref={focused ? initialItem : undefined}
          className={`pet-alert-item ${alert.active ? alert.severity : "recovered"}`} data-focused={focused || undefined}>
          <div className="pet-alert-title">
            <span className="pet-alert-dot" aria-hidden="true" />
            <strong>{alert.title}</strong>
            <span className="pet-alert-state">{alert.ignored ? "已静音" : !alert.active ? "已解除" : alert.snoozedUntil > Date.now() / 1000 ? "已暂缓" : petSeverityLabel(alert.severity)}</span>
          </div>
          <p>{alert.detail}</p>
          <div className="pet-alert-actions">
            <time dateTime={new Date(alert.updatedAt * 1000).toISOString()} title={new Date(alert.updatedAt * 1000).toLocaleString()}>{new Date(alert.updatedAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            <button type="button" className="pet-chat-pill" disabled={busy} onClick={() => void act(() => client.open(alert.section, alert.key))}>查看详情</button>
            {alert.active && !alert.ignored && <button type="button" className="pet-chat-pill" disabled={busy} onClick={() => void act(() => client.snooze(alert.key))}>一小时后提醒</button>}
            {(alert.active || alert.ignored) && <button type="button" className="pet-chat-pill" disabled={busy} onClick={() => void mute([alert.key], !alert.ignored)}>{alert.ignored ? "取消静音" : "静音提醒"}</button>}
          </div>
        </article>;
      })}
    </div>
    <PaginationBar compact className="store-pagination" page={selectedPage} pageSize={pageSize} total={alerts.length} onPageChange={setPage} />
  </div>;
}
