import { useEffect, useRef, useState } from "react";
import { Settings2, Box } from "lucide-react";
import { codexClient, type CodexLaunchConfig } from "../../platform/clients/codex";

export function LaunchConfigRows({ target, cliAvailable, busy, onRun, onEditing }: { target: string; cliAvailable: boolean; busy: boolean; onRun: (label: string, action: () => Promise<void>) => Promise<void>; onEditing: (value: boolean) => void }) {
  const [config, setConfig] = useState<CodexLaunchConfig | null>(null);
  const [open, setOpen] = useState<"model" | "context" | null>(null);
  const [model, setModel] = useState("");
  const [context, setContext] = useState("");
  const [compact, setCompact] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  useEffect(() => { onEditing(open != null); }, [open, onEditing]);
  useEffect(() => {
    const request = ++generation.current;
    setLoading(true); setConfig(null); setOpen(null); setError("");
    if (!cliAvailable) {
      setLoading(false);
      return () => { generation.current++; };
    }
    void codexClient.launchConfig(target || null).then(value => {
      if (request === generation.current) { setConfig(value); setModel(value.model ?? ""); setContext(value.contextWindow?.toString() ?? ""); setCompact(value.compactLimit?.toString() ?? ""); }
    }).catch(() => { /* Optional configuration does not block launching the desktop client. */ })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [target, cliAvailable]);
  async function save() {
    if (!config) return;
    const parse = (value: string) => value.trim() ? Number(value) : null;
    const window = parse(context), limit = parse(compact);
    if ([window, limit].some(value => value != null && (!Number.isSafeInteger(value) || value < 1024 || value > 10_000_000)) || (window != null && limit != null && limit > window)) { setError("上下文与压缩阈值应为 1024 至 10000000 的整数，压缩阈值不能大于上下文。"); return; }
    const request = generation.current;
    await onRun("保存启动配置", async () => {
      const next = await codexClient.launchConfig(target || null, { ...config, model: model.trim() || null, contextWindow: window, compactLimit: limit });
      if (request === generation.current) { setConfig(next); setOpen(null); setError(""); }
    });
  }
  const cancel = () => { setModel(config?.model ?? ""); setContext(config?.contextWindow?.toString() ?? ""); setCompact(config?.compactLimit?.toString() ?? ""); setOpen(null); setError(""); };
  if (!loading && !config) return null;
  return <><div className="codex-launch-settings"><div><div><strong><Settings2 size={15} />上下文管理</strong><small>{!cliAvailable ? "需要官方 CLI 读取" : config?.contextWindow ? "上下文 " + config.contextWindow + " · 压缩阈值 " + (config.compactLimit ?? "默认") : "使用模型默认上下文与自动压缩策略"}</small></div><button disabled={busy || loading || !config} onClick={() => setOpen(open === "context" ? null : "context")}>配置上下文</button></div><div><div><strong><Box size={15} />模型管理</strong><small>{!cliAvailable ? "需要官方 CLI 读取" : config?.model ?? "使用 Codex 默认模型"}</small></div><button disabled={busy || loading || !config} onClick={() => setOpen(open === "model" ? null : "model")}>配置模型</button></div></div>
    <small className="codex-launch-config-status" role="status">{loading ? "正在读取目标实例配置…" : ""}</small>{error && <p role="alert" className="codex-card-error">{error}</p>}
    {open && <div className="codex-launch-config-editor" role="group" aria-label={open === "model" ? "模型配置" : "上下文配置"}>{open === "model" ? <label>默认模型<input disabled={busy} maxLength={160} value={model} placeholder="留空使用默认模型" onChange={event => setModel(event.target.value)} /></label> : <><label>上下文窗口<input disabled={busy} inputMode="numeric" value={context} placeholder="留空使用模型默认值" onChange={event => setContext(event.target.value)} /></label><label>自动压缩阈值<input disabled={busy} inputMode="numeric" value={compact} placeholder="留空使用默认值" onChange={event => setCompact(event.target.value)} /></label></>}<p>保存到所选实例的 config.toml，客户端重启后生效。</p><div><button disabled={busy} onClick={cancel}>取消配置</button><button disabled={busy} onClick={() => void save()}>保存配置</button></div></div>}
  </>;
}
