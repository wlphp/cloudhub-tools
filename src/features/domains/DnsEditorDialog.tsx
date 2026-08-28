import { type FormEvent, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

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
  onCancel: () => void;
  onSubmit: (input: DnsRecordInput) => Promise<void> | void;
};

export function DnsEditorDialog({ mode, row, preset, onCancel, onSubmit }: DnsEditorDialogProps) {
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
  const rrRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    rrRef.current?.focus();
    rrRef.current?.select();
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!rr.trim() || !value.trim()) return;
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
      await onSubmit({ type, rr: rr.trim(), value: normalizedValue, ttl, priority, line });
    } catch (error) {
      const message = String(error);
      setErrMsg(message);
      if (/SignatureDoesNotMatch|signature is not matched/i.test(message)) {
        setErrHint("请求签名校验失败。请确认本地 Web API 已重启并使用最新代码后再试。");
      } else if (/Forbidden|AccessDenied|NoPermission/i.test(message)) {
        setErrHint("当前 AccessKey 缺少 DNS 写权限。请在 RAM 中授予 AliyunDNSFullAccess，或至少授予对应的 alidns 写入权限。");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop dns-editor-backdrop" onClick={onCancel}>
      <section className="modal dns-editor-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><h2>{mode === "edit" ? "编辑解析记录" : "添加解析记录"}</h2><button className="close" onClick={onCancel}><X size={18} /></button></div>
        <form onSubmit={handleSubmit}>
          <label>记录类型<select value={type} onChange={(event) => setType(event.target.value)}><option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option><option value="MX">MX</option><option value="TXT">TXT</option><option value="NS">NS</option><option value="SRV">SRV</option><option value="CAA">CAA</option><option value="REDIRECT_URL">显性URL</option><option value="FORWARD_URL">隐性URL</option></select></label>
          <label>主机记录<input ref={rrRef} value={rr} onChange={(event) => setRr(event.target.value)} placeholder="如：www、@、mail" /></label>
          <label>记录值<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="请输入记录值" /></label>
          <div className="form-grid">
            <label>TTL<select value={String(ttl)} onChange={(event) => setTtl(Number(event.target.value))}><option value="60">1分钟</option><option value="120">2分钟</option><option value="300">5分钟</option><option value="600">10分钟</option><option value="1800">30分钟</option><option value="3600">1小时</option><option value="43200">12小时</option><option value="86400">1天</option></select></label>
            <label>解析线路<select value={line} onChange={(event) => setLine(event.target.value)}><option value="default">默认</option><option value="telecom">电信</option><option value="unicom">联通</option><option value="mobile">移动</option><option value="oversea">境外</option><option value="edu">教育网</option><option value="search">搜索引擎</option></select></label>
          </div>
          {type === "MX" && <label>MX 优先级<input type="number" min={1} max={50} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label>}
          {errMsg && <div className="error-list" style={{ margin: "14px 0 0" }}><div style={{ marginBottom: errHint ? 6 : 0 }}>{errMsg}</div>{errHint && <div style={{ color: "#ffd479", fontSize: "11px" }}>提示：{errHint}</div>}</div>}
          <div className="modal-actions"><button type="button" className="layui-btn layui-btn-primary" onClick={onCancel} disabled={submitting}>取消</button><button type="submit" className="layui-btn layui-btn-normal" disabled={submitting}>{submitting ? "提交中…" : "确定"}</button></div>
        </form>
      </section>
    </div>
  );
}
