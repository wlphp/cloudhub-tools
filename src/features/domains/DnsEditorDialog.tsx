import { SharedDialog } from "../../shared/SharedDialog";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { platformErrorMessage } from "../../platform/api";
import { parseDnsPaste, type ParsedDnsRecord } from "./parseDnsPaste";
import { parseAiDnsCandidates } from "./aiDnsCandidates";
import { normalizeDnsHost } from "./dnsHost";
import { AiAssistButton } from "../ai/AiAssistButton";
import type { AiFields } from "../../platform/clients/ai";

export type DnsRecordInput = {
  type: string;
  rr: string;
  value: string;
  ttl: number;
  priority: number;
  line: string;
};

type DnsEditorDialogProps = {
  mode: "add" | "edit" | "quick";
  row?: Record<string, unknown>;
  preset?: { type?: string; rr?: string };
  domain?: string;
  onCancel: () => void;
  onSubmit: (input: DnsRecordInput) => Promise<void> | void;
};

export function DnsEditorDialog({ mode, row, preset, domain = "", onCancel, onSubmit }: DnsEditorDialogProps) {
  const initType = String(row?.Type || preset?.type || "A");
  const [type, setType] = useState(initType);
  const [rr, setRr] = useState(String(row?.RR ?? preset?.rr ?? ""));
  const [value, setValue] = useState(String(row?.Value ?? ""));
  const [ttl, setTtl] = useState<number>(Number(row?.TTL || 600));
  const [priority, setPriority] = useState<number>(Number(row?.Priority || 10));
  const [line, setLine] = useState(String(row?.Line || "default"));
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [errHint, setErrHint] = useState("");
  const [parsed, setParsed] = useState<ParsedDnsRecord[]>([]);
  const [candidate, setCandidate] = useState(0);
  const [fallbackHost, setFallbackHost] = useState("@");
  const [fallbackFromExisting, setFallbackFromExisting] = useState(false);
  const [hostError, setHostError] = useState("");
  const [hostNotice, setHostNotice] = useState("");
  const hostPresets = [
    { rr: "@", label: "根域名 @" }, { rr: "www", label: "网站 www" }, { rr: "*", label: "泛域名 *" },
    { rr: "api", label: "接口 api" }, { rr: "mail", label: "邮件 mail" },
    ...(type === "TXT" ? [{ rr: "_acme-challenge", label: "证书验证" }, { rr: "_dmarc", label: "DMARC" }, { rr: "default._domainkey", label: "DKIM 示例" }] : []),
    ...(type === "SRV" ? [{ rr: "_sip._tcp", label: "SIP 示例" }] : []),
  ];
  function updateHost(next: string) { setRr(next); setHostError(""); setHostNotice(""); }
  function recognizeHost() {
    try {
      const next = normalizeDnsHost(rr, domain);
      setHostError("");
      if (next !== rr) { setRr(next); setHostNotice(`已识别主机记录：${next}`); }
    } catch (error) { setHostError(error instanceof Error ? error.message : "无法识别主机记录。"); setHostNotice(""); }
  }
  let hostPreview = "";
  try { const host = normalizeDnsHost(rr, domain); if (host && domain && !/[\s/:]/.test(host)) hostPreview = host === "@" ? domain : `${host}.${domain}`; } catch { /* Keep invalid input editable. */ }
  const valueHint: Record<string, string> = { A: "填写服务器 IPv4 地址，例如 192.0.2.10。", AAAA: "填写服务器 IPv6 地址，例如 2001:db8::1。", CNAME: "填写目标域名，例如 target.example.com，不要加 http:// 或路径。", MX: "填写邮件服务器域名，例如 mx.example.com；优先级在下方填写，数字越小优先级越高。", TXT: "填写验证平台提供的完整文本，例如 v=spf1 include:example.com ~all，保留内容中的空格。", NS: "填写 DNS 服务器域名，例如 ns1.example.com。", SRV: "填写优先级、权重、端口和目标，例如 10 5 443 service.example.com。", CAA: '填写标志、标签和证书颁发机构，例如 0 issue "letsencrypt.org"。', REDIRECT_URL: "填写完整跳转地址，例如 https://example.com/page。", FORWARD_URL: "填写完整转发地址，例如 https://example.com/page。" };
  function applyParsed(record: ParsedDnsRecord, defaultHost = fallbackHost) {
    setType(record.type); setValue(record.value);
    updateHost(record.rr ?? defaultHost);
    if (record.ttl !== undefined) setTtl(record.ttl);
    if (record.priority !== undefined) setPriority(record.priority);
    if (record.line !== undefined) setLine(record.line);
    setErrMsg(""); setErrHint("");
  }
  function applyAiRecords(items: AiFields[]) {
    const records = parseAiDnsCandidates(items, domain);
    const defaultHost = rr.trim() ? normalizeDnsHost(rr, domain) : "@";
    setFallbackHost(defaultHost); setFallbackFromExisting(!!rr.trim()); setParsed(records); setCandidate(0);
    applyParsed(records[0], defaultHost);
  }

  const rrRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    rrRef.current?.focus();
    rrRef.current?.select();
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!rr.trim() || !value.trim()) return;
    let normalizedHost: string;
    try { normalizedHost = normalizeDnsHost(rr, domain); setHostError(""); }
    catch (error) { setHostError(error instanceof Error ? error.message : "无法识别主机记录。"); return; }
    const normalizedValue = value.trim();
    if (type === "A") {
      const octets = normalizedValue.split(".");
      if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) {
        setErrMsg("A 记录的记录值必须是有效的 IPv4 地址，例如 192.0.2.1。");
        return;
      }
    }
    if (type === "AAAA" && !normalizedValue.includes(":")) {
      setErrMsg("AAAA 记录的记录值必须是有效的 IPv6 地址。");
      return;
    }
    setSubmitting(true);
    setErrMsg("");
    setErrHint("");
    try {
      await onSubmit({ type, rr: normalizedHost, value: normalizedValue, ttl, priority, line });
    } catch (error) {
      const rawMessage = String(error);
      setErrMsg(platformErrorMessage(error));
      if (/SignatureDoesNotMatch|signature is not matched/i.test(rawMessage)) {
        setErrHint("请求签名校验失败。请确认本地 Web API 已重启并使用最新代码后再试。");
      } else if (/Forbidden|AccessDenied|NoPermission/i.test(rawMessage)) {
        setErrHint("当前 AccessKey 缺少 DNS 写权限。请在 RAM 中授予 AliyunDNSFullAccess，或至少授予对应的 alidns 写入权限。");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SharedDialog className="dns-editor-modal" size="small" title={mode === "edit" ? "编辑解析记录" : "添加解析记录"} closeLabel="关闭解析记录编辑" onClose={onCancel} closeDisabled={submitting} onSubmit={handleSubmit} footer={<><button type="button" className="secondary" onClick={onCancel} disabled={submitting}>取消</button><button type="submit" className="primary" disabled={submitting}>{submitting ? "提交中…" : "确定"}</button></>}>
            <div className="dns-ai-actions">
            <AiAssistButton task="dns" title="AI 智能填写" current={{type,rr,value,ttl,priority,line}} disabled={submitting} onApplyItems={applyAiRecords} onApply={({fields}) => { const records=parseDnsPaste(JSON.stringify({type,rr,value,ttl,priority,line,...fields}),domain); if(!records.length)throw new Error("未得到有效DNS记录，请核对字段"); applyParsed(records[0],rr||"@"); setParsed([]); }} />
            </div>
            {parsed.length > 0 && <p className="dns-parse-success" role="status">已识别 {parsed.length} 条记录，已填入第 {candidate + 1} 条。{parsed[candidate].rr === undefined && (fallbackFromExisting ? `原文未提供主机，沿用已填写的 ${fallbackHost}，请核对。` : "原文未提供主机，暂填根域名 @，请核对或选择快捷前缀。")}{parsed[candidate].inference}</p>}
            {parsed.length > 1 && <label>选择要填入的记录<select aria-label="选择要填入的记录" value={candidate} disabled={submitting} onChange={(event) => { const index = Number(event.target.value); setCandidate(index); applyParsed(parsed[index]); }}>{parsed.map((record, index) => <option key={index} value={index}>{index + 1}. {record.rr || `${fallbackHost}（建议）`} · {record.type} · {record.value.length > 64 ? `${record.value.slice(0, 64)}…` : record.value}</option>)}</select></label>}
          <label>记录类型<select aria-label="记录类型" value={type} onChange={(event) => setType(event.target.value)}><option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option><option value="MX">MX</option><option value="TXT">TXT</option><option value="NS">NS</option><option value="SRV">SRV</option><option value="CAA">CAA</option><option value="REDIRECT_URL">显性URL</option><option value="FORWARD_URL">隐性URL</option></select></label>
          <label>主机记录<input ref={rrRef} value={rr} disabled={submitting} onChange={(event) => updateHost(event.target.value)} onBlur={recognizeHost} placeholder="输入前缀，或粘贴当前域名的完整域名 / 网址" aria-describedby="dns-rr-help dns-host-feedback" aria-invalid={!!hostError} /></label>
          <div className="dns-host-shortcuts" role="group" aria-label="主机记录快捷录入">{hostPresets.map(item => <button key={item.rr} type="button" disabled={submitting} aria-pressed={rr === item.rr} onClick={() => { updateHost(item.rr); rrRef.current?.focus(); }}>{item.label}</button>)}</div>
          <div id="dns-host-feedback">{hostError ? <small className="dns-host-error" role="alert">{hostError}</small> : <>{hostNotice && <small className="dns-host-notice" role="status">{hostNotice}</small>}{hostPreview && <small className="dns-host-preview">完整域名：<strong>{hostPreview}</strong></small>}</>}</div>
          <small id="dns-rr-help" className="dns-field-help">只填写域名前缀：www 对应 www.{domain || "example.com"}；@ 表示根域名；* 表示泛域名；验证记录可填写 _acme-challenge。</small>
          <small className="dns-field-help">粘贴当前域名的完整域名或 http(s) 网址，离开输入框时自动提取前缀。{type === "TXT" && "DKIM 的 default 是示例选择器，请按邮件平台给出的名称修改。"}{type === "SRV" && "SIP 示例中的服务名和协议须按平台要求修改。"}</small>
          <label>记录值<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="请输入记录值" aria-describedby="dns-value-help" /></label>
          <small id="dns-value-help" className="dns-field-help">{valueHint[type]}</small>
          <div className="form-grid">
            <label>TTL<select aria-label="TTL" value={String(ttl)} onChange={(event) => setTtl(Number(event.target.value))}>{![60, 120, 300, 600, 1800, 3600, 43200, 86400].includes(ttl) && <option value={ttl}>{ttl}秒</option>}<option value="60">1分钟</option><option value="120">2分钟</option><option value="300">5分钟</option><option value="600">10分钟</option><option value="1800">30分钟</option><option value="3600">1小时</option><option value="43200">12小时</option><option value="86400">1天</option></select></label>
            <label>解析线路<select aria-label="解析线路" value={line} onChange={(event) => setLine(event.target.value)}><option value="default">默认</option><option value="telecom">电信</option><option value="unicom">联通</option><option value="mobile">移动</option><option value="oversea">境外</option><option value="edu">教育网</option><option value="search">搜索引擎</option></select></label>
          </div>
          {type === "MX" && <label>MX 优先级<input type="number" min={1} max={50} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label>}
          {errMsg && <div className="error-list" style={{ margin: "14px 0 0" }}><div style={{ marginBottom: errHint ? 6 : 0 }}>{errMsg}</div>{errHint && <div style={{ color: "#ffd479", fontSize: "11px" }}>提示：{errHint}</div>}</div>}
    </SharedDialog>
  );
}
