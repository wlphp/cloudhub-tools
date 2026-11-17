import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, Copy, Download, Info, Plus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { HelpTooltip } from "../../shared/HelpTooltip";
import { platformErrorMessage } from "../../platform/api";

export type RuleDraft = { protocol: string; ports: string; source: string; description: string; policy: string; priority: number };
export type SecurityRule = RuleDraft & { key: string; direction: string; sourceGroup?: string; updatedAt?: string; readOnly?: boolean; raw: Record<string, unknown> };
export type SecuritySnapshot = { groups: { id: string; name: string; description?: string; nicType?: string }[]; selected: string; rules: SecurityRule[]; version?: number };
export type SecurityAdapter = {
  label: string; scope: string; protocols: string[]; ipv6?: boolean; createDeny?: boolean; references?: boolean; groupReferences?: boolean; editPolicy?: boolean; editPriority?: boolean; descriptionOnlyEdit?: boolean;
  policyHint?: string; priorityHint?: string;
  load: (group?: string) => Promise<SecuritySnapshot>;
  create: (draft: RuleDraft, snapshot: SecuritySnapshot) => Promise<unknown>;
  remove: (rule: SecurityRule, snapshot: SecuritySnapshot) => Promise<unknown>;
  update?: (original: SecurityRule, updated: RuleDraft, snapshot: SecuritySnapshot) => Promise<unknown>;
  canEdit?: (rule: SecurityRule) => boolean;
  // 某些分组（如 Oracle 子网安全列表）只读，用来关掉「添加规则」「导入」。
  canCreate?: (snapshot: SecuritySnapshot) => boolean;
};

const presets = [{ name: "Web HTTP 流量访问", short: "HTTP", port: "80" }, { name: "Web HTTPS 流量访问", short: "HTTPS", port: "443" }, { name: "SSH 远程连接", short: "SSH", port: "22" }, { name: "Telnet 远程连接", short: "Telnet", port: "23" }, { name: "RDP 远程连接", short: "RDP", port: "3389" }];
const blankDraft = (): RuleDraft => ({ protocol: "tcp", ports: "", source: "0.0.0.0/0", description: "", policy: "accept", priority: 1 });
// 云端按「备注+协议+端口+来源」判重时的失败：需要回读列表，让用户看到已经存在的那条规则。
const isDuplicateRuleError = (message: string) => /已存在|duplicated|already exist/i.test(message);
const displayPorts = (ports: string) => ports === "-1/-1" || ports.toLowerCase() === "all" ? "ALL" : ports.split("/").every(p => p === ports.split("/")[0]) ? ports.split("/")[0] : ports.replace("/", "-");
// 云端用空端口或 -1/-1 表示 TCP/UDP 全部端口时，编辑表单按 1-65535 呈现，避免出现无法提交的 ALL。
const editorPorts = (rule: SecurityRule) => { const ports = displayPorts(rule.ports); return ports === "ALL" && !["all", "icmp", "icmpv6", "gre"].includes(rule.protocol) ? "1-65535" : ports; };

// 云端按自己的顺序返回规则，新建的规则常被插到列表中间；把本次新增的规则置顶，避免用户找不到。
const canonicalProtocol = (protocol: string) => String(protocol || "").trim().toLowerCase();
// 各家云端表示「单端口/范围/全部端口」的写法不一致（80、80/80、80-80、ALL、-1/-1、空），比对前统一。
const canonicalPorts = (ports: string) => {
  const value = String(ports || "").trim().toLowerCase();
  if (!value || value === "all" || value === "-1" || value === "-1/-1") return "-1/-1";
  const [start, end] = value.split(/[/-]/);
  if (!start) return value;
  const range = !end || end === start ? `${start}/${start}` : `${start}/${end}`;
  // 部分云把 TCP/UDP 全端口返回成 -1/-1，和界面的 1-65535 视为同一条。
  return range === "1/65535" ? "-1/-1" : range;
};
const canonicalSource = (source: string) => String(source || "").trim().toLowerCase();
const ruleContentKey = (rule: RuleDraft) => `${canonicalProtocol(rule.protocol)}|${canonicalPorts(rule.ports)}|${canonicalSource(rule.source)}|${String(rule.description || "").trim()}`;
function pinCreatedRules(rules: SecurityRule[], drafts: RuleDraft[], previous: SecurityRule[] = []) {
  if (!drafts.length) return rules;
  // 以「创建前的列表」为基线，统计每条内容出现了几次；超出基线的才是本次真正新增的规则。
  const baseline = new Map<string, number>();
  for (const rule of previous) { const key = ruleContentKey(rule); baseline.set(key, (baseline.get(key) ?? 0) + 1); }
  const seen = new Map<string, number>();
  const fresh = new Set<SecurityRule>();
  for (const rule of rules) {
    const key = ruleContentKey(rule);
    const index = seen.get(key) ?? 0; seen.set(key, index + 1);
    if (index >= (baseline.get(key) ?? 0)) fresh.add(rule);
  }
  const usable = previous.length > 0; // 没有基线时不做增量判断，避免把整张表都当成新增。
  const used = new Set<SecurityRule>();
  const pick = (test: (rule: SecurityRule) => boolean) => {
    for (const rule of rules) if (!used.has(rule) && rule.direction === "ingress" && test(rule)) { used.add(rule); return rule; }
    return undefined;
  };
  const pinned: SecurityRule[] = [];
  for (const draft of drafts) {
    const protocol = canonicalProtocol(draft.protocol);
    const ports = canonicalPorts(draft.ports);
    const source = canonicalSource(draft.source);
    const description = String(draft.description || "").trim();
    const same = (rule: SecurityRule) => canonicalProtocol(rule.protocol) === protocol && canonicalPorts(rule.ports) === ports;
    const rule = pick(rule => usable && fresh.has(rule) && same(rule) && canonicalSource(rule.source) === source && String(rule.description || "").trim() === description)
      ?? pick(rule => usable && fresh.has(rule) && same(rule) && canonicalSource(rule.source) === source)
      ?? pick(rule => usable && fresh.has(rule) && same(rule))
      // 兜底：云端可能改写描述/来源（如把 all 归一化成 0.0.0.0/0），按协议+端口+来源再试一次。
      ?? pick(rule => same(rule) && canonicalSource(rule.source) === source);
    if (rule) pinned.push(rule);
  }
  // 本次确实新出现、但字段被云端改写得匹配不上的规则，也一并置顶，别让它留在中间。
  if (usable) for (const rule of rules) if (fresh.has(rule) && !used.has(rule)) { used.add(rule); pinned.push(rule); }
  return [...pinned, ...rules.filter(rule => !used.has(rule))];
}

function validateDraft(draft: RuleDraft, protocols: string[], ipv6 = false, editing = false, createDeny = false, references = false, groupReferences = false): RuleDraft[] {
  if (!protocols.includes(draft.protocol)) throw new Error("当前云接口不支持此协议");
  if (!["accept", "drop"].includes(draft.policy) || !Number.isInteger(draft.priority) || draft.priority < 1 || draft.priority > 100) throw new Error("策略或优先级无效，优先级须为 1 至 100");
  if (!editing && draft.policy !== "accept" && !createDeny) throw new Error("当前云接口尚未接入新增拒绝规则");
  if (!editing && !createDeny && draft.priority !== 1) throw new Error("新增规则的优先级由云接口配置");
  if (draft.description.length > 80) throw new Error("描述最多 80 个字符");
  const source = draft.source.trim();
  const reference = /^(sg|pl)-[a-zA-Z0-9_-]+$/.test(source);
  if (reference && !references && !(groupReferences && source.startsWith("sg-"))) throw new Error("当前云接口不支持引用来源");
  if (!reference) {
  if (source.length > 128 || !/^[\da-fA-F:.]+\/\d{1,3}$/.test(source)) throw new Error("请输入有效的 IPv4 或 IPv6 CIDR");
  const [ip, mask] = source.split("/");
  if (ip.includes(":")) {
    if (!ipv6) throw new Error("当前云接口尚未接入 IPv6 来源，请选择 IPv4");
    if (draft.protocol === "icmp") throw new Error("ICMP 仅支持 IPv4 来源，请选择 IPv4 或改用 ICMPv6");
    if (Number(mask) > 128) throw new Error("IPv6 CIDR 格式无效");
    try { new URL(`http://[${ip}]`); } catch { throw new Error("IPv6 CIDR 格式无效"); }
  } else {
    if (draft.protocol === "icmpv6") throw new Error("ICMPv6 仅支持 IPv6 来源");
    if (Number(mask) > 32 || ip.split(".").length !== 4 || ip.split(".").some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) throw new Error("IPv4 CIDR 格式无效");
  }
  } else if (source.length > 128) throw new Error("引用 ID 过长");
  const ports = ["all", "icmp", "icmpv6", "gre"].includes(draft.protocol) ? ["-1/-1"] : [...new Set(draft.ports.split(/[,，]/).map(port => port.trim()).filter(Boolean))].map(port => {
    if (["all", "-1/-1"].includes(port.toLowerCase())) return "1/65535";
    const pair = port.split(/[-/]/).map(Number);
    const [start, end = start] = pair;
    if (pair.length > 2 || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 65535) throw new Error("端口请填写 80、20-24，多个端口用逗号分隔");
    return `${start}/${end}`;
  });
  if (!ports.length || ports.length > 20) throw new Error("请填写 1 至 20 个端口或范围");
  return ports.map(ports => ({ ...draft, ports, source, description: draft.description.trim() }));
}


function RuleFieldPicker({ id, label, value, placeholder, disabled, onChange, children }: { id?: string; label: string; value: string; placeholder: string; disabled: boolean; onChange: (value: string) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !picker.current) return;
    const field = picker.current.getBoundingClientRect();
    const body = picker.current.closest(".modal-body")?.getBoundingClientRect();
    const menu = picker.current.querySelector(".security-port-options");
    if (body && menu) setAbove(body.bottom - field.bottom < Math.min(menu.scrollHeight, 240) + 5 && field.top - body.top > body.bottom - field.bottom);
  }, [open]);
  return <div ref={picker} className={`security-field-picker${above ? " is-above" : ""}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    if (event.key === "ArrowDown" && !disabled) { event.preventDefault(); setOpen(true); }
  }}>
    <div className="security-picker-control"><input id={id} autoComplete="off" spellCheck={false} aria-label={label} aria-expanded={open && !disabled} value={value} placeholder={placeholder} disabled={disabled} onFocus={() => setOpen(true)} onChange={event => onChange(event.target.value)} /><button type="button" aria-label={`${label}选项`} aria-expanded={open && !disabled} disabled={disabled} onClick={() => setOpen(current => !current)}><ChevronDown size={16} style={{ transform: open && !disabled ? "rotate(180deg)" : undefined }} /></button></div>
    {open && !disabled && <div className="security-port-options" onMouseDown={event => { if ((event.target as HTMLElement).tagName !== "INPUT") event.preventDefault(); }} role="group" aria-label={`${label}快捷选项`}>{children}</div>}
  </div>;
}

function RuleEditor({ initial, copying, editing, adapter, busy, error, onClose, onSave }: { initial?: SecurityRule; copying: boolean; editing: boolean; adapter: SecurityAdapter; busy: boolean; error: string; onClose: () => void; onSave: (drafts: RuleDraft[]) => Promise<void> }) {
  const [draft, setDraft] = useState<RuleDraft>(initial ? { ...initial, ports: editorPorts(initial), policy: editing || adapter.createDeny ? initial.policy : "accept", priority: editing || adapter.references ? initial.priority : 1 } : blankDraft());
  const [sources, setSources] = useState([{ family: initial?.source.startsWith("sg-") ? "安全组" : initial?.source.startsWith("pl-") ? "前缀列表" : initial?.source.includes(":") ? "IPv6" : "IPv4", address: initial?.source || "0.0.0.0/0" }]);
  const [validation, setValidation] = useState("");
  const patch = (value: Partial<RuleDraft>) => setDraft(current => ({ ...current, ...value }));
  // 该云接口是否可能拒绝策略：新增支持拒绝，或修改时可改策略。否则不摆一个永远点不亮的按钮。
  const canDeny = Boolean(adapter.createDeny || (editing && adapter.editPolicy));
  const priorityEditable = Boolean(adapter.references || (editing && adapter.editPriority));
  const noPorts = ["all", "icmp", "icmpv6", "gre"].includes(draft.protocol);
  const choosePort = (port: string) => {
    if (editing) { patch({ ports: port }); return; }
    if (port === "1-65535") { patch({ ports: draft.ports === port ? "" : port }); return; }
    const values = draft.ports.split(/[,，]/).map(value => value.trim()).filter(value => Boolean(value) && value !== "1-65535");
    patch({ ports: (values.includes(port) ? values.filter(value => value !== port) : [...values, port]).join(", ") });
  };
  async function submit(event: FormEvent) {
    event.preventDefault(); setValidation("");
    try {
      const candidates = sources.flatMap((source, index) => {
        if (["IPv4", "IPv6"].includes(source.family) && !source.address.includes("/")) throw new Error("IP 来源请填写 CIDR");
        if (["IPv4", "IPv6"].includes(source.family) && source.address.trim() && source.address.includes(":") !== (source.family === "IPv6")) throw new Error(`源地址 ${index + 1} 与所选 ${source.family} 类型不一致`);
        if (source.family === "安全组" && !source.address.startsWith("sg-") || source.family === "前缀列表" && !source.address.startsWith("pl-")) throw new Error("来源类型与引用 ID 不匹配");
        return validateDraft({ ...draft, source: source.address }, adapter.protocols, adapter.ipv6, editing, adapter.createDeny, adapter.references, adapter.groupReferences);
      });
      const values = [...new Map(candidates.map(rule => [`${rule.protocol}:${rule.ports}:${rule.source}`, rule])).values()];
      if (editing && values.length !== 1) throw new Error("修改时只能指定一个来源和一个端口范围");
      if (values.length > 50) throw new Error("每次最多提交 50 条规则");
      await onSave(values);
    } catch (reason) { setValidation(platformErrorMessage(reason)); }
  }
  return <SharedDialog sizeStorageKey="security-rule-editor" title={editing ? "修改入方向规则" : copying ? "复制入方向规则" : "添加入方向规则"} className="security-rule-editor" onClose={onClose} closeDisabled={busy} busy={busy} onSubmit={event => void submit(event)} footer={<><button type="submit" className="primary" disabled={busy}>{busy ? "提交中…" : "确定"}</button><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button></>}>
    <div className="security-editor-info"><Info size={16} /><span>{editing && adapter.descriptionOnlyEdit ? "此云接口只支持修改规则描述，其余字段为只读。提交前会再次确认。" : "指定协议、来源地址和端口范围。规则变更前会再次确认。"}</span></div>
    <div className="security-editor-layout"><div className="security-editor-fields">
      <div className="security-editor-row"><span className="security-field-label is-required"><label htmlFor="security-rule-priority">优先级</label><HelpTooltip label="优先级说明">{adapter.priorityHint || <>取值 1～100，数字越小优先级越高。修改时保留原优先级；{adapter.references ? "新增与复制均可设置优先级。" : "当前新增接口由云接口配置优先级。"}</>}</HelpTooltip></span>{priorityEditable ? <input id="security-rule-priority" aria-label="优先级" type="number" min={1} max={100} value={draft.priority} disabled={busy || (editing && adapter.descriptionOnlyEdit)} onChange={event => patch({ priority: Number(event.target.value) })} /> : <div className="security-fixed-value"><span>—</span><small>{adapter.priorityHint ? "该云无优先级" : editing ? "该规则不支持调整" : "新增时由云接口配置"}</small></div>}</div>
      <div className="security-editor-row"><span className="security-field-label is-required"><span>策略</span><HelpTooltip label="策略说明">{adapter.policyHint || <>允许表示放行匹配流量，拒绝表示阻止匹配流量。{editing && adapter.editPolicy || adapter.createDeny ? "当前接口支持允许与拒绝策略。" : "当前云接口尚未接入拒绝策略。"}</>}</HelpTooltip></span>{canDeny ? <div className="security-segments" role="group" aria-label="策略"><button type="button" className={draft.policy === "accept" ? "active" : ""} aria-pressed={draft.policy === "accept"} disabled={busy || (editing && adapter.descriptionOnlyEdit)} onClick={() => patch({ policy: "accept" })}>允许</button><button type="button" className={draft.policy === "drop" ? "active" : ""} aria-pressed={draft.policy === "drop"} disabled={busy || (editing && adapter.descriptionOnlyEdit)} title="拒绝匹配流量" onClick={() => patch({ policy: "drop" })}>拒绝</button></div> : <div className="security-fixed-value"><span className="security-fixed-allow">允许</span><small>该云接口仅支持允许策略</small></div>}</div>
      <div className="security-editor-row"><span className="security-field-label is-required"><span>协议类型</span><HelpTooltip label="协议类型说明">TCP、UDP 用于按端口控制访问；ICMP 用于网络探测。ALL 表示该云支持的全部协议。灰色协议表示当前接口尚未接入。</HelpTooltip></span><div className="security-segments security-protocols" role="group" aria-label="协议类型">{["tcp", "udp", "icmp", "all", "icmpv6", "gre"].map(protocol => <button type="button" key={protocol} className={draft.protocol === protocol ? "active" : ""} disabled={busy || (editing && adapter.descriptionOnlyEdit) || !adapter.protocols.includes(protocol)} aria-pressed={draft.protocol === protocol} onClick={() => patch({ protocol })}>{protocol === "icmpv6" ? "ICMPv6" : protocol.toUpperCase()}</button>)}</div></div>
      <div className="security-editor-row security-editor-sources"><span className="security-field-label is-required"><span>源地址</span><HelpTooltip label="源地址说明">每行分别选择 IPv4 或 IPv6 并填写 CIDR。0.0.0.0/0 表示任意 IPv4 来源，::/0 表示任意 IPv6 来源。类型须与地址匹配。{adapter.references ? "也可选择安全组或前缀列表，填写引用 ID。" : adapter.groupReferences ? "也可选择安全组，填写 sg- 开头的引用 ID。" : ""}</HelpTooltip></span><div className="security-source-list">{sources.map((source, index) => <div className="security-source-entry" key={index}><select aria-label={`源地址类型 ${index + 1}`} value={source.family} disabled={busy || Boolean(editing && adapter.descriptionOnlyEdit)} onChange={event => setSources(current => current.map((value, n) => n === index ? { family: event.target.value, address: "" } : value))}><option>IPv4</option><option disabled={!adapter.ipv6}>IPv6</option>{adapter.references ? <><option>安全组</option><option>前缀列表</option></> : adapter.groupReferences ? <option>安全组</option> : null}</select><RuleFieldPicker label={`源地址 ${index + 1}`} value={source.address} disabled={busy || Boolean(editing && adapter.descriptionOnlyEdit)} placeholder={source.family === "安全组" ? "请输入 sg- 开头的安全组 ID" : source.family === "前缀列表" ? "请输入 pl- 开头的前缀列表 ID" : source.family === "IPv6" ? "例如：2001:db8::/64" : "例如：10.0.0.0/24"} onChange={address => setSources(current => current.map((value, n) => n === index ? { ...value, address } : value))}>{["IPv4", "IPv6"].includes(source.family) ? <label><input type="checkbox" checked={source.address === (source.family === "IPv6" ? "::/0" : "0.0.0.0/0")} disabled={busy || Boolean(editing && adapter.descriptionOnlyEdit)} onChange={() => setSources(current => current.map((value, n) => n === index ? { ...value, address: source.family === "IPv6" ? "::/0" : "0.0.0.0/0" } : value))} />{source.family === "IPv6" ? "::/0" : "0.0.0.0/0"}（任何位置）</label> : <span className="security-reference-hint">填写同一 VPC 内的引用 ID</span>}</RuleFieldPicker><button type="button" className="security-source-remove" aria-label={`删除源地址 ${index + 1}`} disabled={busy || sources.length === 1 || Boolean(editing && adapter.descriptionOnlyEdit)} onClick={() => setSources(current => current.filter((_, n) => n !== index))}><Trash2 size={15} /></button></div>)}<button type="button" className="security-text-button" disabled={busy || editing || sources.length >= 10} onClick={() => setSources(current => [...current, { family: "IPv4", address: "" }])}><Plus size={14} />添加源地址</button></div></div>
      <div className="security-editor-row"><span className="security-field-label is-required"><label htmlFor="security-editor-ports">端口范围</label><HelpTooltip label="端口范围说明">可填写单端口（80）或范围（20-24），多个用逗号分隔。TCP/UDP 全端口为 1-65535；ALL、ICMP、GRE 等协议不按端口限制。</HelpTooltip></span><RuleFieldPicker id="security-editor-ports" label="端口范围" value={noPorts ? "ALL" : draft.ports} disabled={busy || noPorts || Boolean(editing && adapter.descriptionOnlyEdit)} placeholder="例如：80 或 20-24，多个用逗号分隔" onChange={ports => patch({ ports })}>{[...presets, { short: "全部端口", port: "1-65535" }].map(preset => <label key={preset.port}><input type="checkbox" checked={draft.ports.split(/[,，]/).map(value => value.trim()).includes(preset.port)} disabled={busy || Boolean(editing && adapter.descriptionOnlyEdit)} onChange={() => choosePort(preset.port)} />{preset.short}（{preset.port}）</label>)}</RuleFieldPicker></div>
      <div className="security-editor-row"><span className="security-field-label"><label htmlFor="security-rule-description">描述</label><HelpTooltip label="描述说明">可选，用于说明规则用途，最多 80 个字符。请勿填写密码或密钥。</HelpTooltip></span><textarea autoComplete="off" id="security-rule-description" aria-label="描述" value={draft.description} disabled={busy} maxLength={80} rows={3} placeholder="请输入规则用途（可选）" onChange={event => patch({ description: event.target.value })} /></div>
      <details className="security-capability-details"><summary>接口兼容说明</summary><p>{editing ? "保存前检查原规则是否已变化。IPv6/ICMPv6 修改采用替换方式，规则可能短暂变化，失败时尝试恢复原规则。" : adapter.createDeny ? "支持允许与拒绝、IPv4/IPv6、安全组和前缀列表引用。五元组扩展规则暂保留只读。" : `当前新增接口使用允许策略${adapter.references ? "，可设置优先级" : "，优先级由云接口配置"}。${adapter.groupReferences && !adapter.references ? "支持安全组引用来源；" : ""}灰色协议尚未接入，复杂规则保留只读。`}</p></details>
    </div><aside className="security-port-presets"><strong>端口范围快捷配置</strong><button type="button" disabled={busy || (editing && adapter.descriptionOnlyEdit)} title={adapter.protocols.includes("all") ? "选择全部协议和全部端口，保留当前来源地址" : "设置当前 TCP 或 UDP 的 1-65535 端口，保留当前来源地址"} onClick={() => { patch({ protocol: adapter.protocols.includes("all") ? "all" : draft.protocol === "udp" ? "udp" : "tcp", ports: "1-65535", policy: "accept" }); }}>全部端口开放</button><span>Web 访问</span>{presets.slice(0, 2).map(preset => <button type="button" key={preset.port} disabled={busy || (editing && adapter.descriptionOnlyEdit)} onClick={() => patch({ protocol: "tcp", ports: preset.port })}>{preset.name}</button>)}<span>远程登录</span>{presets.slice(2).map(preset => <button type="button" key={preset.port} disabled={busy || (editing && adapter.descriptionOnlyEdit)} onClick={() => patch({ protocol: "tcp", ports: preset.port })}>{preset.name}</button>)}</aside></div>
    {(validation || error) && <p role="alert" className="security-manager-error">{validation || error}</p>}
  </SharedDialog>;
}

export function SecurityGroupManager({ adapter, resourceKey, onClose, onConfirm, onNotice }: { adapter: SecurityAdapter; resourceKey: string; onClose: () => void; onConfirm: (message: string) => Promise<boolean>; onNotice: (message: string) => void }) {
  const [snapshot, setSnapshot] = useState<SecuritySnapshot>({ groups: [], selected: "", rules: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [direction, setDirection] = useState("ingress");
  const [searchField, setSearchField] = useState("protocol");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<{ initial?: SecurityRule; editing?: boolean } | null>(null);
  const [imported, setImported] = useState<RuleDraft[] | null>(null);
  const request = useRef(0);
  // 本次会话新建过的规则，之后每次刷新都继续置顶，避免点刷新后又跳回中间。
  const created = useRef<RuleDraft[]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  async function reload(group?: string, pin?: RuleDraft[], previous?: SecurityRule[]) {
    if (pin?.length) created.current = [...created.current, ...pin];
    const run = ++request.current; setLoading(true); setError("");
    try {
      const result = await adapter.load(group);
      if (run === request.current) { setSnapshot(created.current.length ? { ...result, rules: pinCreatedRules(result.rules, created.current, previous) } : result); setSelected([]); }
    }
    catch (reason) { if (run === request.current) setError(platformErrorMessage(reason)); }
    finally { if (run === request.current) setLoading(false); }
  }
  useEffect(() => { void reload(); return () => { request.current++; }; }, [resourceKey]);
  const rows = snapshot.rules.filter(rule => rule.direction === direction && String(searchField === "source" ? rule.source || rule.sourceGroup : searchField === "ports" ? displayPorts(rule.ports) : rule[searchField as keyof RuleDraft] ?? "").toLowerCase().includes(search.trim().toLowerCase()));
  const canRemove = (rule: SecurityRule) => direction === "ingress" && !rule.readOnly;
  const canCreate = adapter.canCreate ? adapter.canCreate(snapshot) : true;
  async function saveEdit(drafts: RuleDraft[]) {
    if (busy || !editor?.initial || !adapter.update || drafts.length !== 1) return;
    const original = editor.initial;
    const updated = drafts[0];
    setBusy(true); setError("");
    try {
      const confirmation = adapter.descriptionOnlyEdit ? `确认修改这条规则的描述？\n${original.protocol.toUpperCase()} ${displayPorts(original.ports)} · ${original.source}\n新描述：${updated.description || "（清空）"}\n${adapter.scope}` : `确认修改这条安全组规则？\n${original.protocol.toUpperCase()} ${displayPorts(original.ports)} · ${original.source} → ${updated.protocol.toUpperCase()} ${displayPorts(updated.ports)} · ${updated.source}\n${original.source.includes(":") || updated.source.includes(":") || original.protocol === "icmpv6" || updated.protocol === "icmpv6" ? "IPv6 修改将替换原规则，可能短暂影响访问；失败时尝试恢复。\n" : ""}策略：${updated.policy === "accept" ? "允许" : "拒绝"}，优先级：${updated.priority}\n${adapter.scope}`;
      if (!(await onConfirm(confirmation))) return;
      await adapter.update(original, updated, snapshot);
      setEditor(null); onNotice("安全组规则修改请求已提交，请稍后刷新确认云端结果");
      await reload(snapshot.selected);
    } catch (reason) { const message = platformErrorMessage(reason); setError(message); if (isDuplicateRuleError(message)) await refreshAfterPartial(); }
    finally { setBusy(false); }
  }
  async function save(drafts: RuleDraft[]) {
    if (busy) return;
    setBusy(true); setError("");
    let completed = 0;
    try {
      if (!(await onConfirm(`确认在安全组中添加 ${drafts.length} 条入方向规则？\n${adapter.references ? "按表单设置的优先级提交。" : "新增规则的优先级由云接口配置。"}\n${adapter.scope}\n${drafts.slice(0, 5).map(rule => `${rule.policy === "accept" ? "允许" : "拒绝"} ${rule.protocol.toUpperCase()} ${displayPorts(rule.ports)} · ${rule.source}`).join("\n")}`))) return;
      for (const draft of drafts) { await adapter.create(draft, snapshot); completed++; }
      setEditor(null); setImported(null); onNotice(`已添加 ${completed} 条安全组规则`); await reload(snapshot.selected, drafts.slice(0, completed), snapshot.rules);
    } catch (reason) {
      const message = platformErrorMessage(reason);
      setError(`${completed ? `已添加 ${completed} 条，其余未完成。` : ""}${message}`);
      if (completed || isDuplicateRuleError(message)) await refreshAfterPartial();
    }
    finally { setBusy(false); }
  }
  async function refreshAfterPartial() {
    // Preserve the operation error while refreshing any changes already accepted.
    try {
      const result = await adapter.load(snapshot.selected);
      setSnapshot(created.current.length ? { ...result, rules: pinCreatedRules(result.rules, created.current, snapshot.rules) } : result);
      setSelected([]);
    } catch { /* The original mutation error stays visible. */ }
  }
  async function remove(rules: SecurityRule[]) {
    if (busy || !rules.length) return;
    setBusy(true); setError(""); let completed = 0;
    try {
      if (!(await onConfirm(`确认删除 ${rules.length} 条安全组规则？\n${adapter.scope}\n删除后，对应流量将按剩余安全组规则重新匹配。`))) return;
      const keys = new Set(rules.map(rule => rule.key));
      for (const rule of rules) { await adapter.remove(rule, snapshot); completed++; }
      setSnapshot(current => ({ ...current, rules: current.rules.filter(rule => !keys.has(rule.key)) }));
      setSelected(current => current.filter(key => !keys.has(key)));
      onNotice(`已删除 ${completed} 条安全组规则`);
    } catch (reason) { setError(`${completed ? `已删除 ${completed} 条，其余未完成。` : ""}${platformErrorMessage(reason)}`); if (completed) await refreshAfterPartial(); }
    finally { setBusy(false); }
  }
  function exportRules() {
    const rules = rows.filter(rule => !selected.length || selected.includes(rule.key));
    const data = { version: 1, direction, rules: rules.map(({ protocol, ports, source, sourceGroup, description, policy, priority }) => ({ protocol, ports, source, sourceGroup, description, policy, priority })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "安全组规则.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importRules(file?: File) {
    if (!file) return;
    setError("");
    try {
      if (file.size > 256 * 1024) throw new Error("规则文件不能超过 256 KB");
      const data: unknown = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || !("rules" in data) || !Array.isArray(data.rules) || data.rules.length < 1 || data.rules.length > 50 || !("direction" in data) || data.direction !== "ingress") throw new Error("请选择包含 1 至 50 条入方向规则的导出文件");
      const rules = data.rules.flatMap((rule: unknown) => {
        if (!rule || typeof rule !== "object") throw new Error("导入规则格式无效");
        const value = rule as Record<string, unknown>;
        if (["protocol", "ports", "source", "description", "policy"].some(key => typeof value[key] !== "string") || typeof value.priority !== "number") throw new Error("导入规则字段无效");
        return validateDraft({ protocol: value.protocol as string, ports: value.ports as string, source: value.source as string, description: value.description as string, policy: value.policy as string, priority: value.priority }, adapter.protocols, adapter.ipv6, false, adapter.createDeny, adapter.references, adapter.groupReferences);
      });
      if (rules.length > 50) throw new Error("每次最多导入 50 条规则");
      setImported(rules);
    } catch (reason) { setError(platformErrorMessage(reason)); }
    finally { if (importInput.current) importInput.current.value = ""; }
  }
  return <>
    <SharedDialog sizeStorageKey="security-group-manager" title="安全组" eyebrow={adapter.label} className="security-group-manager" onClose={onClose} closeDisabled={busy} footer={<><span className="security-manager-total">共 {rows.length} 条{selected.length > 0 ? `，已选 ${selected.length} 条` : ""}</span><button type="button" className="secondary" onClick={onClose} disabled={busy}>关闭</button></>}>
      <div className="security-manager-group"><label>安全组<select aria-label="安全组" value={snapshot.selected} disabled={busy || loading || snapshot.groups.length < 2} onChange={event => void reload(event.target.value)}>{snapshot.groups.map(group => <option key={group.id} value={group.id}>{group.name}（{group.id}）</option>)}</select></label><span>{snapshot.groups.find(group => group.id === snapshot.selected)?.description || adapter.scope}</span></div>
      <div className="security-direction-tabs" role="tablist" aria-label="规则方向">{[["ingress", "入方向规则"], ["egress", "出方向规则"]].map(([value, label]) => <button type="button" key={value} role="tab" disabled={busy} aria-selected={direction === value} onClick={() => { setDirection(value); setSelected([]); }}>{label}</button>)}</div>
      <div className="security-manager-toolbar"><div className="security-manager-tools"><button type="button" className="primary" disabled={busy || loading || !snapshot.selected || direction !== "ingress" || !canCreate} onClick={() => { setError(""); setEditor({}); }}><Plus size={14} />添加规则</button><button type="button" className="secondary" disabled={busy || loading || !snapshot.selected || direction !== "ingress" || !canCreate} onClick={() => importInput.current?.click()}><Upload size={14} />导入</button><input ref={importInput} type="file" accept=".json,application/json" hidden onChange={event => void importRules(event.target.files?.[0])} /><button type="button" className="secondary" disabled={busy || !rows.length} onClick={exportRules}><Download size={14} />导出</button>{selected.length > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => void remove(rows.filter(rule => selected.includes(rule.key) && canRemove(rule)))}><Trash2 size={14} />删除所选</button>}</div><div className="security-manager-filter"><select aria-label="筛选字段" value={searchField} onChange={event => setSearchField(event.target.value)}><option value="protocol">协议类型</option><option value="ports">端口范围</option><option value="source">源地址</option><option value="description">描述</option></select><label className="security-manager-search"><Search size={14} /><input aria-label="搜索安全组规则" placeholder="请输入" value={search} onChange={event => setSearch(event.target.value)} /></label><button type="button" className="security-icon-button" aria-label="刷新规则" disabled={loading || busy} onClick={() => void reload(snapshot.selected)}><RefreshCw size={15} /></button></div></div>
      {direction === "egress" && <p className="security-manager-note">当前接口尚未接入出方向写操作，仅展示接口已返回的出方向规则。</p>}
      {error && <p role="alert" className="security-manager-error">{error}</p>}
      <div className="security-rules-table-wrap"><table className="security-rules-table"><thead><tr><th><input type="checkbox" aria-label="选择全部可删除规则" disabled={busy || !rows.some(canRemove)} checked={rows.some(canRemove) && rows.filter(canRemove).every(rule => selected.includes(rule.key))} onChange={event => setSelected(event.target.checked ? rows.filter(canRemove).map(rule => rule.key) : [])} /></th><th>优先级</th><th>策略</th><th>协议类型</th><th>端口范围</th><th>{direction === "ingress" ? "源地址" : "目的地址"}</th><th>描述</th><th>修改时间</th><th>操作</th></tr></thead><tbody>{loading ? <tr><td colSpan={9} className="security-table-empty">正在读取安全组规则…</td></tr> : rows.length ? rows.map(rule => <tr key={rule.key}><td><input type="checkbox" aria-label={`选择规则 ${rule.protocol.toUpperCase()} ${displayPorts(rule.ports)} ${rule.source || rule.sourceGroup}`} disabled={busy || !canRemove(rule)} checked={selected.includes(rule.key)} onChange={event => setSelected(current => event.target.checked ? [...current, rule.key] : current.filter(key => key !== rule.key))} /></td><td>{rule.raw.Priority == null ? "—" : rule.priority}</td><td><span className={`security-policy ${rule.policy === "accept" ? "allow" : "deny"}`}>{rule.policy === "accept" ? "允许" : "拒绝"}</span></td><td>{rule.protocol.toUpperCase()}</td><td>{displayPorts(rule.ports)}</td><td className="security-rule-source">{rule.source || rule.sourceGroup || "—"}{rule.sourceGroup && <small>{rule.sourceGroup.startsWith("pl-") ? "前缀引用" : "组引用"}</small>}</td><td className="security-rule-description" title={rule.description}>{rule.description || "—"}</td><td>{rule.updatedAt || "—"}</td><td><div className="security-rule-actions"><button type="button" className="security-text-button" disabled={busy || direction !== "ingress" || !adapter.update || rule.readOnly || (adapter.canEdit && !adapter.canEdit(rule))} title={adapter.update ? "按规则 ID 修改，五元组扩展规则仍为只读" : "当前云接口尚未接入原位修改"} onClick={() => { setError(""); setEditor({ initial: rule, editing: true }); }}>修改</button><button type="button" className="security-text-button" disabled={busy || direction !== "ingress" || !rule.source || rule.readOnly || (rule.policy !== "accept" && !adapter.createDeny) || !adapter.protocols.includes(rule.protocol)} title={rule.policy !== "accept" && !adapter.createDeny ? "当前新增接口无法复制拒绝规则" : rule.readOnly ? "复杂规则不能按简化表单复制" : "复制为新规则"} onClick={() => { setError(""); setEditor({ initial: rule }); }}><Copy size={12} />复制</button><button type="button" className="security-text-button" disabled={busy || !canRemove(rule)} title={rule.readOnly ? "五元组扩展规则暂为只读" : "删除规则"} onClick={() => void remove([rule])}>删除</button></div></td></tr>) : <tr><td colSpan={9} className="security-table-empty">{error ? "规则未读取成功，请查看错误并重试" : direction === "egress" ? "接口未返回出方向规则" : search ? "没有匹配的规则" : "暂无入方向规则"}</td></tr>}</tbody></table></div>
      <details className="security-capability-details"><summary>操作范围与兼容说明</summary><p>{adapter.scope} 新增支持的策略以表单可选项为准；不支持的协议不可选择。修改时间未返回时显示“—”，{adapter.update ? "支持 CIDR 与引用来源修改；IPv6 使用替换与失败恢复。" : "原位修改尚未接入。"}复制会新建规则，删除需要再次确认。</p></details>
    </SharedDialog>
    {editor && <RuleEditor initial={editor.initial} copying={Boolean(editor.initial) && !editor.editing} editing={Boolean(editor.editing)} adapter={adapter} busy={busy} error={error} onClose={() => setEditor(null)} onSave={editor.editing ? saveEdit : save} />}
    {imported && <SharedDialog title="导入安全组规则" className="security-rule-import" onClose={() => setImported(null)} closeDisabled={busy} footer={<><button type="button" className="primary" disabled={busy} onClick={() => void save(imported)}>确认导入 {imported.length} 条规则</button><button type="button" className="secondary" disabled={busy} onClick={() => setImported(null)}>取消</button></>}><p>文件校验通过，将添加以下入方向规则。提交前会再次确认。</p><div className="security-import-preview">{imported.map((rule, index) => <div key={index}>{rule.protocol.toUpperCase()} · {displayPorts(rule.ports)} · {rule.source} · {rule.description || "无描述"}</div>)}</div>{error && <p role="alert" className="security-manager-error">{error}</p>}</SharedDialog>}
  </>;
}
