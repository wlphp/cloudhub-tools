import { useEffect, useState } from "react";
import { Circle, Pause, Play, Square, Trash2 } from "lucide-react";
import type { TerminalRecording } from "./terminalAudit";
import "./terminal-audit.css";

const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
export function TerminalAuditPanel({ records, activeId, canRecord = true, onStart, onStop, onDelete }: { records: TerminalRecording[]; activeId?: number; canRecord?: boolean; onStart: () => void; onStop: () => void; onDelete: (id: number) => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const selected = records.find(record => record.id === selectedId && record.stopped);
  useEffect(() => { if (!selected) { setPlaying(false); setSelectedId(null); } }, [selected?.id]);
  useEffect(() => { if (playing && selected && position >= selected.duration) setPlaying(false); }, [playing, position, selected?.duration]);
  useEffect(() => {
    if (!playing || !selected) return;
    let previous = performance.now();
    const timer = window.setInterval(() => { const now = performance.now(); const delta = (now - previous) * speed; previous = now; setPosition(value => Math.min(selected.duration, value + delta)); }, 100);
    return () => window.clearInterval(timer);
  }, [playing, selected?.id, speed]);
  return <section className="terminal-audit-panel" aria-label="录像审计">
    <header><strong>录像审计</strong>{activeId ? <button type="button" onClick={onStop}><Square size={13} />停止录制</button> : <button type="button" disabled={!canRecord} title={canRecord ? "录制之后的终端输出" : "请先连接 SSH 会话"} onClick={onStart}><Circle size={13} />开始录制</button>}</header>
    <p>手动录制脱敏后的终端输出，按文本时间轴回放，不录制键盘输入。仅在本次窗口内保留，退出清除；每段最多 512 KB，保留最近 10 段。</p>
    {activeId && <div className="terminal-audit-recording" role="status">正在录制 · 切换或断开会话会自动停止</div>}
    <div className="terminal-audit-list">{records.map(record => <article key={record.id}><button type="button" disabled={!record.stopped} aria-pressed={selectedId === record.id} onClick={() => { setSelectedId(record.id); setPosition(0); setPlaying(false); }}><strong>{record.label}</strong><small>{new Date(record.startedAt).toLocaleTimeString()} · {time(record.duration)} · {record.stopped ? record.reason : "录制中"}</small></button><button type="button" aria-label={`删除录像 ${record.id}`} title="删除录像" disabled={!record.stopped} onClick={() => onDelete(record.id)}><Trash2 size={13} /></button></article>)}{!records.length && <p>点击“开始录制”，记录之后的终端输出。</p>}</div>
    {selected && <div className="terminal-audit-player"><div className="terminal-audit-controls"><button type="button" aria-label={playing ? "暂停回放" : "播放录像"} disabled={!selected.frames.length} onClick={() => { if (position >= selected.duration) setPosition(0); setPlaying(value => !value); }}>{playing ? <Pause size={14} /> : <Play size={14} />}</button><span>{time(position)} / {time(selected.duration)}</span><select aria-label="回放速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={1}>1 倍</option><option value={2}>2 倍</option><option value={4}>4 倍</option></select></div><input type="range" aria-label="回放进度" min={0} max={Math.max(1, selected.duration)} value={position} onChange={event => { setPosition(Number(event.target.value)); setPlaying(false); }} /><pre tabIndex={0} aria-label="录像回放输出">{selected.frames.filter(frame => frame.at <= position).map(frame => frame.text).join("") || "等待输出…"}</pre></div>}
  </section>;
}
