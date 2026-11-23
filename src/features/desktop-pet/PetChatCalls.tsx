import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopPetClient as client, type PetChatCall } from "../../platform/clients/desktopPet";

const outcomes = { success: "成功", failed: "失败", cancelled: "已取消" };

export function PetChatCalls() {
  const [calls, setCalls] = useState<PetChatCall[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let revision = 0;
    async function refresh() {
      const current = ++revision;
      try {
        const rows = await client.chatCalls();
        if (active && current === revision) {
          setCalls(rows);
          setError(false);
        }
      } catch {
        if (active && current === revision) setError(true);
      }
    }
    const subscription = listen("pet-chat-calls-changed", refresh);
    void subscription.then(() => { if (active) void refresh(); }, () => { if (active) void refresh(); });
    return () => {
      active = false;
      void subscription.then(stop => stop(), () => {});
    };
  }, []);

  return <section className="pet-chat-calls" aria-label="对话请求">
    <p>本机保留最近 100 次对话调用。新记录的正文经脱敏后加密保存。</p>
    {error && <p role="alert">无法读取模型调用记录，请返回设置后重试。</p>}
    {!error && calls === null && <p role="status">正在加载…</p>}
    {!error && calls?.length === 0 && <p>暂无记录，发起一次对话后即可查看。</p>}
    {calls?.map(call => {
      const { request, endpoint, requestBody, responseBody, ...response } = call.trace;
      return <details key={call.id}>
        <summary>
          <strong>{request?.model || "模型调用"}</strong>
          <span>{outcomes[call.outcome]} · {call.durationMs.toLocaleString()} ms</span>
          <time dateTime={new Date(call.startedAt).toISOString()}>{new Date(call.startedAt).toLocaleString()}</time>
        </summary>
        <div className="pet-chat-call-parameters">
          <strong>接口地址</strong>
          <pre>{endpoint ? `POST ${endpoint}` : "无已记录的地址"}</pre>
          <strong>{requestBody == null ? "上送参数摘要" : "上送参数"}</strong>
          <pre>{JSON.stringify(requestBody ?? request, null, 2)}</pre>
          <strong>返回参数</strong>
          <pre>{responseBody == null ? "无已记录的正文" : typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody, null, 2)}</pre>
          <strong>响应信息</strong>
          <pre>{JSON.stringify(response, null, 2)}</pre>
        </div>
      </details>;
    })}
  </section>;
}
