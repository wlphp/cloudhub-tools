import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { platformErrorMessage } from "../../platform/api";
import { desktopPetClient as client, type PetActivityEntry, type PetActivityKind } from "../../platform/clients/desktopPet";

export function PetActivityHistory({ kind }: { kind: PetActivityKind }) {
  const [entries, setEntries] = useState<PetActivityEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let revision = 0;
    async function refresh() {
      const current = ++revision;
      try {
        const rows = await client.activityHistory(kind);
        if (active && current === revision) {
          setEntries(rows);
          setError("");
        }
      } catch (error) {
        if (active && current === revision) {
          setEntries(null);
          setError(platformErrorMessage(error));
        }
      }
    }
    const subscription = listen<PetActivityKind>("pet-activity-changed", event => {
      if (event.payload === kind) void refresh();
    });
    void subscription.then(() => { if (active) void refresh(); }, () => { if (active) void refresh(); });
    return () => {
      active = false;
      void subscription.then(stop => stop(), () => {});
    };
  }, [kind]);

  const label = kind === "voice" ? "语音识别" : kind === "tts" ? "语音合成" : "本地操作";
  return <section className="pet-chat-calls" aria-label={`${label}记录`}>
    <p>{kind === "voice" ? "本机加密保留最近 100 条识别记录，含未触发唤醒的语音文字，不保存录音。" : kind === "tts" ? "本机加密保留最近 100 条语音合成调用记录。" : "本机加密保留最近 100 条操作记录。"}</p>
    {error ? <p role="alert">{error}</p> : !entries ? <p role="status">正在加载…</p> : entries.length === 0 && <p>暂无记录。</p>}
    {entries?.map(entry => <details key={entry.id}>
      <summary>
        <strong>{entry.title}</strong>
        <span>{entry.status} · {entry.durationMs.toLocaleString()} ms</span>
        <time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleString()}</time>
      </summary>
      <div className="pet-chat-call-parameters">
        {entry.detail && <><strong>{kind === "voice" ? "识别文字" : kind === "tts" ? "播报文字" : "执行结果"}</strong><pre>{entry.detail}</pre></>}
        {(kind !== "operation" || entry.endpoint) && <>
          <strong>接口地址</strong>
          <pre>{entry.endpoint || "该条为旧记录或本地处理，未采集接口地址。"}</pre>
          <strong>上送参数</strong>
          <pre>{entry.requestBody == null ? "未记录上送参数；音频和鉴权信息不保存。" : JSON.stringify(entry.requestBody, null, 2)}</pre>
          <strong>返回参数</strong>
          <pre>{entry.responseBody == null ? "未记录返回参数。" : JSON.stringify(entry.responseBody, null, 2)}</pre>
        </>}
      </div>
    </details>)}
  </section>;
}
