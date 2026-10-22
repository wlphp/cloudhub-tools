import { useEffect, useRef, useState } from "react";
import { Download, Play, Square } from "lucide-react";
import { OverviewDialog } from "./OverviewDialogs";
import { codexProviders, effectiveModels, defaultModel, type CodexProvider, type ProviderProbeResult } from "../../platform/clients/codex-providers";

type Row = { id: number; key: string; model: string; state: "queued" | "running" | "done" | "stopped"; result?: ProviderProbeResult; error?: string };
type DiscoveredModel = { keyId: string; model: string };
const errors = { network: "网络错误或超时", http: "请求被拒绝", invalid_response: "响应格式不匹配", response_too_large: "响应超过大小限制", output_limit: "已达到短测试生成上限，未验证完整回答", unsupported_input: "该上游的 Responses 接口不接受 Codex 使用的输入格式" };
// Codex 直连失败时，改用 Chat Completions 协议由本机网关转换。
const incompatible = "该上游的 Responses 接口不支持 Codex 客户端发送的输入项，Codex 直连会报“输入类型不支持”。请把协议改为 Chat Completions，由本机网关转换为 Chat Completions 请求。";

export function ProviderProbeDialog({ provider, onClose, onSaved }: { provider: CodexProvider; onClose: () => void; onSaved: (values: CodexProvider[]) => void }) {
  const [keys, setKeys] = useState([provider.keys[0]?.id ?? ""]);
  const [models, setModels] = useState([defaultModel(provider, provider.keys[0]?.id ?? "")]);
  const [rows, setRows] = useState<Row[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const availableModels = [...new Set(keys.flatMap(key => effectiveModels(provider, key)))];
  const selectedModels = models.filter(model => availableModels.includes(model));
  const cancelled = useRef(false);
  const active = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; cancelled.current = true; }; }, []);
  function toggle(values: string[], value: string) { return values.includes(value) ? values.filter(v => v !== value) : [...values, value]; }
  async function run(generate: boolean) {
    if (active.current || !keys.length || (generate && (!consent || !selectedModels.length))) return;
    active.current = true; cancelled.current = false; setBusy(true); setError("");
    if (!generate) { setDiscovered([]); setSelected([]); }
    const jobs: Row[] = keys.flatMap(key => (generate ? selectedModels.filter(v => effectiveModels(provider, key).includes(v)) : [""]).map(model => ({ id: 0, key, model, state: "queued" as const }))).map((row, id) => ({ ...row, id }));
    if (jobs.length > 300) { setError("单次最多测试 300 项，请缩小选择范围"); setBusy(false); active.current = false; return; }
    setRows(jobs);
    let cursor = 0;
    const update = (row: Row) => { if (alive.current) setRows(values => values.map(v => v.id === row.id ? row : v)); };
    const worker = async () => {
      while (!cancelled.current && cursor < jobs.length) {
        const row = jobs[cursor++]; update({ ...row, state: "running" });
        try {
          const result = await codexProviders.probe(provider.id, row.key, provider.version, row.model || null);
          update({ ...row, state: "done", result });
          if (!generate && alive.current) setDiscovered(values => {
            const next = [...values];
            for (const model of result.models) if (!next.some(value => value.keyId === row.key && value.model === model)) next.push({ keyId: row.key, model });
            return next.sort((a, b) => a.model.localeCompare(b.model) || a.keyId.localeCompare(b.keyId));
          });
        } catch (e) { update({ ...row, state: "done", error: e instanceof Error ? e.message : "测试失败" }); }
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker)); }
    finally {
      active.current = false;
      if (alive.current) { setBusy(false); setRows(values => values.map(v => v.state === "queued" ? { ...v, state: "stopped" } : v)); }
    }
  }
  async function saveModels() {
    if (active.current || !selected.length) return;
    const keys = provider.keys.map(key => {
      const additions = discovered.filter(value => value.keyId === key.id && selected.includes(`${value.keyId}\u0000${value.model}`)).map(value => value.model);
      const models = [...new Set([...effectiveModels(provider, key.id), ...additions])];
      return { ...key, secret: null, settings: { ...key.settings, models, modelsScoped: true } };
    });
    const catalog = [...new Set(keys.flatMap(key => key.settings.models))];
    if (catalog.length > 200 || keys.some(key => key.settings.models.length > 200)) { setError("密钥模型目录最多保存 200 项"); return; }
    active.current = true; setSaving(true); setError("");
    try { const values = await codexProviders.save({ ...provider, models: catalog, keys }); if (alive.current) { onSaved(values); onClose(); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "保存模型目录失败"); }
    finally { active.current = false; if (alive.current) setSaving(false); }
  }
  return <OverviewDialog title={provider.name + " · 模型测试"} layout="form" busy={busy || saving} onClose={onClose} footer={<>
    <button disabled={busy || saving} onClick={onClose}>关闭</button>
    {busy ? <button disabled={cancelled.current} onClick={() => { cancelled.current = true; setRows(v => v.map(row => row.state === "queued" ? { ...row, state: "stopped" } : row)); }}><Square size={14} />停止排队</button> : <>
      <button disabled={saving || !keys.length} onClick={() => void run(false)}><Download size={14} />获取模型目录</button>
      <button disabled={saving || !consent || !keys.length || !selectedModels.length} onClick={() => void run(true)}><Play size={14} />生成测试</button>
    </>}
  </>}>
    <div className="codex-provider-form">
      <fieldset disabled={busy || saving}><legend>密钥</legend><div className="codex-provider-options">{provider.keys.map(v => <label key={v.id}><input type="checkbox" checked={keys.includes(v.id)} onChange={() => setKeys(toggle(keys, v.id))} />{v.name}</label>)}</div></fieldset>
      <fieldset disabled={busy || saving}><legend>测试模型</legend><div className="codex-provider-options">{availableModels.map(v => <label key={v}><input type="checkbox" checked={models.includes(v)} onChange={() => setModels(toggle(models, v))} />{v}</label>)}</div></fieldset>
      <label className="codex-provider-consent"><input type="checkbox" disabled={busy || saving} checked={consent} onChange={e => setConsent(e.target.checked)} />我同意发送实际生成请求，可能消耗供应商额度</label>
      {error && <p role="alert" className="codex-card-error">{error}</p>}
      {rows.some(row => row.result && row.result.codexInput === false) && <p role="status" className="codex-card-error">{incompatible}</p>}
      {!!rows.length && <div className="codex-provider-results" role="region" aria-label="模型测试结果"><table><thead><tr><th>密钥</th><th>模型</th><th>结果</th><th>耗时</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{provider.keys.find(v => v.id === row.key)?.name}</td><td>{row.model || "模型目录"}</td><td>{row.state === "queued" ? "排队中" : row.state === "running" ? "请求中" : row.state === "stopped" ? "已停止" : row.error || (row.result?.error ? errors[row.result.error] + (row.result.status ? " (HTTP " + row.result.status + ")" : "") : row.result?.generated ? "生成成功" : "已获取 " + row.result?.models.length + " 个模型")}</td><td>{row.result ? row.result.elapsedMs + " ms" : "-"}</td></tr>)}</tbody></table></div>}
      {!!discovered.length && <fieldset disabled={busy || saving}><legend>发现的模型</legend><div className="codex-provider-options">{discovered.map(value => {
        const selection = `${value.keyId}\u0000${value.model}`;
        const keyName = provider.keys.find(key => key.id === value.keyId)?.name ?? "未知密钥";
        return <label key={selection}><input type="checkbox" checked={selected.includes(selection)} onChange={() => setSelected(toggle(selected, selection))} />{value.model} · {keyName}</label>;
      })}</div><button disabled={!selected.length} onClick={() => void saveModels()}>添加所选模型到对应密钥</button></fieldset>}
    </div>
  </OverviewDialog>;
}
