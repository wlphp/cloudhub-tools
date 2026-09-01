import { type FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { serversClient } from "../../platform/clients";
import type { Account } from "../../shared/types";

type SecurityGroup = { SecurityGroupId: string; SecurityGroupName: string; Description: string; VpcId: string; NicType: string };
type SecurityGroupRule = { Direction: string; IpProtocol: string; PortRange: string; SourceCidrIp: string; SourceGroupId: string; Policy: string; Priority: number; Description: string; NicType: string; SecurityGroupRuleId?: string };
type SecurityGroupResponse = { groups: SecurityGroup[]; selectedSecurityGroupId: string; rules: SecurityGroupRule[]; sgVersion?: number };
type LightFirewallRule = { RuleId: string; IpProtocol: string; PortRange: string; SourceCidrIp: string; Policy: string; Description: string; FirewallRule?: Record<string, unknown> };
type LightFirewallResponse = { rules: LightFirewallRule[]; firewallVersion?: number };
type VultrFirewallRule = { RuleId: string; IpProtocol: string; PortRange: string; SourceCidrIp: string; Description: string };
type VultrFirewallResponse = { rules: VultrFirewallRule[] };

export function SecurityGroupDialog({ account, regionId, instanceId, onClose, onConfirm, onNotice }: { account: Account; regionId: string; instanceId: string; onClose: () => void; onConfirm: (message: string) => Promise<boolean>; onNotice: (message: string) => void }) {
  const [groups, setGroups] = useState<SecurityGroup[]>([]);
  const [selectedSecurityGroupId, setSelectedSecurityGroupId] = useState("");
  const [rules, setRules] = useState<SecurityGroupRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [protocol, setProtocol] = useState("tcp");
  const [portRange, setPortRange] = useState("");
  const [sourceCidrIp, setSourceCidrIp] = useState("0.0.0.0/0");
  const [description, setDescription] = useState("");
  const [maximized, setMaximized] = useState(false);
  const isTencent = account.cloud_type === "tencent";
  const isBaidu = account.cloud_type === "baidu";
  const [sgVersion, setSgVersion] = useState<number | undefined>();
  const providerLabel = isTencent ? "腾讯云 CVM" : isBaidu ? "百度智能云 BCC" : "ALIYUN ECS";
  const selectedGroup = groups.find((group) => group.SecurityGroupId === selectedSecurityGroupId);
  const inboundRules = rules.filter((rule) => String(rule.Direction).toLowerCase() === "ingress" && String(rule.Policy || "accept").toLowerCase() === "accept");

  async function loadSecurityGroups(securityGroupId = selectedSecurityGroupId) {
    setLoading(true); setError("");
    try {
      const result = await serversClient.listSecurityGroups<SecurityGroupResponse>(
        isTencent ? "tencent" : isBaidu ? "baidu" : "aliyun",
        { id: account.id, regionId, instanceId, securityGroupId: securityGroupId || null },
      );
      setGroups(result.groups || []); setSelectedSecurityGroupId(result.selectedSecurityGroupId || ""); setRules(result.rules || []); setSgVersion(result.sgVersion);
    } catch (reason) { setGroups([]); setRules([]); setError(String(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadSecurityGroups(""); }, []);

  async function addRule(event: FormEvent) {
    event.preventDefault();
    const normalizedPortRange = protocol === "all" ? "-1/-1" : portRange.trim();
    const normalizedCidr = sourceCidrIp.trim();
    if (!selectedGroup) { setError("请先选择安全组"); return; }
    if (!normalizedPortRange || !/^-?\d+\/-?\d+$/.test(normalizedPortRange)) { setError("端口范围请填写为 80/80 或 8000/9000"); return; }
    if (!normalizedCidr || !normalizedCidr.includes("/")) { setError("来源地址请填写 CIDR，例如 0.0.0.0/0"); return; }
    if (!(await onConfirm(`确认在安全组“${selectedGroup.SecurityGroupName || selectedGroup.SecurityGroupId}”开放 ${protocol.toUpperCase()} ${normalizedPortRange}，来源 ${normalizedCidr} 吗？\n安全组规则会影响所有绑定该安全组的服务器。`))) return;
    setSubmitting(true); setError("");
    try {
      const payload = { id: account.id, regionId, securityGroupId: selectedGroup.SecurityGroupId, ipProtocol: protocol, portRange: normalizedPortRange, sourceCidrIp: normalizedCidr, description: description.trim() || null, nicType: selectedGroup.NicType || null, sgVersion: sgVersion ?? null };
      await serversClient.mutateSecurityGroup(isTencent ? "tencent" : isBaidu ? "baidu" : "aliyun", "authorize", payload);
      setPortRange(""); setDescription(""); onNotice(`已开放 ${protocol.toUpperCase()} ${normalizedPortRange}`); await loadSecurityGroups(selectedGroup.SecurityGroupId);
    } catch (reason) { setError(String(reason)); } finally { setSubmitting(false); }
  }

  async function revokeRule(rule: SecurityGroupRule) {
    if (!selectedGroup || !rule.SourceCidrIp) return;
    const label = `${String(rule.IpProtocol || "").toUpperCase()} ${rule.PortRange || "-"}，来源 ${rule.SourceCidrIp}`;
    if (!(await onConfirm(`确认关闭安全组规则 ${label} 吗？\n安全组规则会影响所有绑定该安全组的服务器。`))) return;
    setSubmitting(true); setError("");
    try {
      const payload = { id: account.id, regionId, securityGroupId: selectedGroup.SecurityGroupId, ipProtocol: String(rule.IpProtocol || ""), portRange: String(rule.PortRange || ""), sourceCidrIp: rule.SourceCidrIp, policy: String(rule.Policy || "accept"), priority: Number(rule.Priority || 1), nicType: rule.NicType || selectedGroup.NicType || null, securityGroupRuleId: rule.SecurityGroupRuleId || null, sgVersion: sgVersion ?? null };
      await serversClient.mutateSecurityGroup(isTencent ? "tencent" : isBaidu ? "baidu" : "aliyun", "revoke", payload);
      onNotice(`已关闭 ${label}`); await loadSecurityGroups(selectedGroup.SecurityGroupId);
    } catch (reason) { setError(String(reason)); } finally { setSubmitting(false); }
  }

  return createPortal(<div className="modal-backdrop security-group-backdrop">
    <section className={`modal security-group-modal${maximized ? " is-maximized" : ""}`} role="dialog" aria-modal="true" aria-labelledby="security-group-title">
      <div className="modal-head"><div><span className="eyebrow">{providerLabel}</span><h2 id="security-group-title">安全组端口</h2></div><div className="security-group-head-actions"><button type="button" className="close" title={maximized ? "还原窗口" : "全屏"} aria-label={maximized ? "还原窗口" : "全屏"} onClick={() => setMaximized((value) => !value)}>{maximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button><button type="button" className="close" aria-label="关闭安全组" onClick={onClose}><X size={18} /></button></div></div>
      <div className="security-group-body"><p className="security-group-note">仅管理入方向允许规则。安全组对同组内所有绑定服务器生效。</p>
        {loading ? <div className="security-group-loading">正在读取安全组规则...</div> : !groups.length ? <div className="security-group-empty">当前服务器没有可用安全组，或 AccessKey 缺少安全组读取权限。</div> : <>
          <label className="security-group-select">安全组<select value={selectedSecurityGroupId} disabled={submitting} onChange={(event) => void loadSecurityGroups(event.target.value)}>{groups.map((group) => <option key={group.SecurityGroupId} value={group.SecurityGroupId}>{group.SecurityGroupName || group.SecurityGroupId} ({group.SecurityGroupId})</option>)}</select>{selectedGroup?.Description && <small>{selectedGroup.Description}</small>}</label>
          <form className="security-group-add" onSubmit={(event) => void addRule(event)}><div className="security-group-add-title">开放端口</div><div className="security-group-form-grid"><label>协议<select value={protocol} disabled={submitting} onChange={(event) => setProtocol(event.target.value)}><option value="tcp">TCP</option><option value="udp">UDP</option>{!isBaidu && <option value="all">全部协议</option>}</select></label><label>端口范围<input value={protocol === "all" ? "-1/-1" : portRange} disabled={submitting || protocol === "all"} onChange={(event) => setPortRange(event.target.value)} placeholder="80/80 或 8000/9000" /></label><label>来源 CIDR<input value={sourceCidrIp} disabled={submitting} onChange={(event) => setSourceCidrIp(event.target.value)} placeholder="0.0.0.0/0" /></label><label>说明（可选）<input value={description} disabled={submitting} maxLength={80} onChange={(event) => setDescription(event.target.value)} placeholder="例如 Web 服务" /></label></div><button type="submit" className="layui-btn layui-btn-normal" disabled={submitting}>{submitting ? "提交中…" : "开放端口"}</button></form>
          <div className="security-group-rules-head"><strong>已开放端口</strong><button type="button" className="secondary" disabled={submitting} onClick={() => void loadSecurityGroups(selectedSecurityGroupId)}><RefreshCw size={13} />刷新</button></div><div className="security-group-rule-list">{!inboundRules.length ? <div className="security-group-empty">暂无入方向允许规则</div> : inboundRules.map((rule, index) => <div className="security-group-rule" key={rule.SecurityGroupRuleId || `${rule.IpProtocol}-${rule.PortRange}-${rule.SourceCidrIp || rule.SourceGroupId}-${index}`}><div><strong>{String(rule.IpProtocol || "-").toUpperCase()} {rule.PortRange || "-"}</strong><span>来源：{rule.SourceCidrIp || `安全组 ${rule.SourceGroupId || "-"}`}</span>{rule.Description && <small>{rule.Description}</small>}</div>{rule.SourceCidrIp && (!isBaidu || rule.SecurityGroupRuleId) ? <button type="button" className="layui-btn layui-btn-danger" disabled={submitting} onClick={() => void revokeRule(rule)}>关闭</button> : <span className="security-group-readonly">组引用规则</span>}</div>)}</div>
        </>}{error && <p className="security-group-error">{error}</p>}</div>
      <div className="modal-actions"><span /><button type="button" className="secondary" onClick={onClose}>关闭</button></div>
    </section></div>, document.body);
}

export function LightFirewallDialog({ account, regionId, instanceId, onClose, onConfirm, onNotice }: { account: Account; regionId: string; instanceId: string; onClose: () => void; onConfirm: (message: string) => Promise<boolean>; onNotice: (message: string) => void }) {
  const [rules, setRules] = useState<LightFirewallRule[]>([]);
  const [firewallVersion, setFirewallVersion] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [protocol, setProtocol] = useState("tcp");
  const [portRange, setPortRange] = useState("");
  const [sourceCidrIp, setSourceCidrIp] = useState("0.0.0.0/0");
  const [description, setDescription] = useState("");
  const [maximized, setMaximized] = useState(false);
  const isTencent = account.cloud_type === "tencent";
  const providerLabel = isTencent ? "腾讯云 Lighthouse" : account.cloud_type === "jdcloud" ? "京东云轻量应用服务器" : "阿里云轻量应用服务器";

  async function loadRules() {
    setLoading(true); setError("");
    try {
      const result = await serversClient.listLightFirewall<LightFirewallResponse>({ id: account.id, regionId, instanceId });
      setRules(result.rules || []); setFirewallVersion(result.firewallVersion);
    } catch (reason) { setRules([]); setError(String(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadRules(); }, []);

  async function addRule(event: FormEvent) {
    event.preventDefault();
    const normalizedPortRange = portRange.trim();
    const normalizedCidr = sourceCidrIp.trim();
    if (!/^\d+\/\d+$/.test(normalizedPortRange)) { setError("端口范围请填写为 80/80 或 8000/9000"); return; }
    const [start, end] = normalizedPortRange.split("/").map(Number);
    if (start < 1 || end < start || end > 65535) { setError("端口范围必须在 1 到 65535 之间"); return; }
    if (!normalizedCidr || !normalizedCidr.includes("/")) { setError("来源地址请填写 CIDR，例如 0.0.0.0/0"); return; }
    if (!(await onConfirm(`确认在轻量服务器开放 ${protocol.toUpperCase()} ${normalizedPortRange}，来源 ${normalizedCidr} 吗？`))) return;
    setSubmitting(true); setError("");
    try {
      const payload = { id: account.id, regionId, instanceId, ipProtocol: protocol, portRange: normalizedPortRange, sourceCidrIp: normalizedCidr, description: description.trim() || null, firewallVersion: firewallVersion ?? null };
      await serversClient.mutateLightFirewall("create", payload);
      setPortRange(""); setDescription(""); onNotice(`已开放 ${protocol.toUpperCase()} ${normalizedPortRange}`); await loadRules();
    } catch (reason) { setError(String(reason)); } finally { setSubmitting(false); }
  }

  async function deleteRule(rule: LightFirewallRule) {
    const label = `${String(rule.IpProtocol || "-").toUpperCase()} ${rule.PortRange || "-"}，来源 ${rule.SourceCidrIp || "-"}`;
    if (!(await onConfirm(`确认关闭轻量服务器防火墙规则 ${label} 吗？\n关闭后该端口将无法从该来源访问。`))) return;
    setSubmitting(true); setError("");
    try {
      const payload = { id: account.id, regionId, instanceId, ruleId: rule.RuleId || null, firewallRule: rule.FirewallRule || null, firewallVersion: firewallVersion ?? null };
      await serversClient.mutateLightFirewall("delete", payload);
      onNotice(`已关闭 ${label}`); await loadRules();
    } catch (reason) { setError(String(reason)); } finally { setSubmitting(false); }
  }

  return createPortal(<div className="modal-backdrop security-group-backdrop">
    <section className={`modal security-group-modal${maximized ? " is-maximized" : ""}`} role="dialog" aria-modal="true" aria-labelledby="light-firewall-title">
      <div className="modal-head"><div><span className="eyebrow">{providerLabel}</span><h2 id="light-firewall-title">防火墙端口</h2></div><div className="security-group-head-actions"><button type="button" className="close" title={maximized ? "还原窗口" : "全屏"} aria-label={maximized ? "还原窗口" : "全屏"} onClick={() => setMaximized((value) => !value)}>{maximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button><button type="button" className="close" aria-label="关闭防火墙" onClick={onClose}><X size={18} /></button></div></div>
      <div className="security-group-body"><p className="security-group-note">仅管理当前轻量服务器的入方向允许规则，变更不会影响其他服务器。</p>
        {loading ? <div className="security-group-loading">正在读取防火墙规则...</div> : <><form className="security-group-add" onSubmit={(event) => void addRule(event)}><div className="security-group-add-title">开放端口</div><div className="security-group-form-grid"><label>协议<select value={protocol} disabled={submitting} onChange={(event) => setProtocol(event.target.value)}><option value="tcp">TCP</option><option value="udp">UDP</option></select></label><label>端口范围<input value={portRange} disabled={submitting} onChange={(event) => setPortRange(event.target.value)} placeholder="80/80 或 8000/9000" /></label><label>来源 CIDR<input value={sourceCidrIp} disabled={submitting} onChange={(event) => setSourceCidrIp(event.target.value)} placeholder="0.0.0.0/0" /></label><label>说明（可选）<input value={description} disabled={submitting} maxLength={80} onChange={(event) => setDescription(event.target.value)} placeholder="例如 Web 服务" /></label></div><button type="submit" className="layui-btn layui-btn-normal" disabled={submitting}>{submitting ? "提交中…" : "开放端口"}</button></form>
          <div className="security-group-rules-head"><strong>已开放端口</strong><button type="button" className="secondary" disabled={submitting} onClick={() => void loadRules()}><RefreshCw size={13} />刷新</button></div><div className="security-group-rule-list">{!rules.length ? <div className="security-group-empty">暂无入方向允许规则</div> : rules.map((rule, index) => <div className="security-group-rule" key={rule.RuleId || `${rule.IpProtocol}-${rule.PortRange}-${rule.SourceCidrIp}-${index}`}><div><strong>{String(rule.IpProtocol || "-").toUpperCase()} {rule.PortRange || "-"}</strong><span>来源：{rule.SourceCidrIp || "-"}</span>{rule.Description && <small>{rule.Description}</small>}</div><button type="button" className="layui-btn layui-btn-danger" disabled={submitting} onClick={() => void deleteRule(rule)}>关闭</button></div>)}</div>
        </>}{error && <p className="security-group-error">{error}</p>}</div>
      <div className="modal-actions"><span /><button type="button" className="secondary" onClick={onClose}>关闭</button></div>
    </section></div>, document.body);
}

export function VultrFirewallDialog({ account, firewallGroupId, onClose, onConfirm, onNotice }: { account: Account; firewallGroupId: string; onClose: () => void; onConfirm: (message: string) => Promise<boolean>; onNotice: (message: string) => void }) {
  const [rules, setRules] = useState<VultrFirewallRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [protocol, setProtocol] = useState("tcp");
  const [port, setPort] = useState("");
  const [sourceCidrIp, setSourceCidrIp] = useState("0.0.0.0/0");
  const [description, setDescription] = useState("");
  const [maximized, setMaximized] = useState(false);

  async function loadRules() {
    setLoading(true); setError("");
    try {
      const result = await serversClient.listVultrFirewall<VultrFirewallResponse>({ id: account.id, firewallGroupId });
      setRules(result.rules || []);
    } catch (reason) { setRules([]); setError(String(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadRules(); }, [firewallGroupId]);

  async function addRule(event: FormEvent) {
    event.preventDefault();
    const normalizedPort = port.trim();
    const normalizedCidr = sourceCidrIp.trim();
    if (!/^\d+(?:-\d+)?$/.test(normalizedPort)) { setError("端口请填写为 80 或 8000-9000"); return; }
    const [start, end = start] = normalizedPort.split("-").map(Number);
    if (start < 1 || end < start || end > 65535) { setError("端口范围必须在 1 到 65535 之间"); return; }
    if (!normalizedCidr || !normalizedCidr.includes("/")) { setError("来源地址请填写 IPv4 CIDR，例如 0.0.0.0/0"); return; }
    if (!(await onConfirm(`确认在 Vultr 防火墙组 ${firewallGroupId} 开放 ${protocol.toUpperCase()} ${normalizedPort}，来源 ${normalizedCidr} 吗？\n防火墙组规则会影响所有绑定该组的服务器。`))) return;
    setSubmitting(true); setError("");
    try {
      const payload = { id: account.id, firewallGroupId, ipProtocol: protocol, port: normalizedPort, sourceCidrIp: normalizedCidr, description: description.trim() || null };
      await serversClient.mutateVultrFirewall("create", payload);
      setPort(""); setDescription(""); onNotice(`已开放 ${protocol.toUpperCase()} ${normalizedPort}`); await loadRules();
    } catch (reason) { setError(String(reason)); } finally { setSubmitting(false); }
  }

  async function deleteRule(rule: VultrFirewallRule) {
    if (!rule.RuleId) return;
    const label = `${String(rule.IpProtocol || "-").toUpperCase()} ${rule.PortRange || "-"}，来源 ${rule.SourceCidrIp || "-"}`;
    if (!(await onConfirm(`确认关闭 Vultr 防火墙规则 ${label} 吗？\n关闭后，所有绑定该防火墙组的服务器都会失去该端口访问。`))) return;
    setSubmitting(true); setError("");
    try {
      const payload = { id: account.id, firewallGroupId, ruleId: rule.RuleId };
      await serversClient.mutateVultrFirewall("delete", payload);
      onNotice(`已关闭 ${label}`); await loadRules();
    } catch (reason) { setError(String(reason)); } finally { setSubmitting(false); }
  }

  return createPortal(<div className="modal-backdrop security-group-backdrop">
    <section className={`modal security-group-modal${maximized ? " is-maximized" : ""}`} role="dialog" aria-modal="true" aria-labelledby="vultr-firewall-title">
      <div className="modal-head"><div><span className="eyebrow">Vultr Firewall Group</span><h2 id="vultr-firewall-title">防火墙端口</h2></div><div className="security-group-head-actions"><button type="button" className="close" title={maximized ? "还原窗口" : "全屏"} aria-label={maximized ? "还原窗口" : "全屏"} onClick={() => setMaximized((value) => !value)}>{maximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button><button type="button" className="close" aria-label="关闭防火墙" onClick={onClose}><X size={18} /></button></div></div>
      <div className="security-group-body"><p className="security-group-note">管理防火墙组 {firewallGroupId} 的 IPv4 入方向允许规则。变更会影响所有绑定该组的服务器。</p>
        {loading ? <div className="security-group-loading">正在读取防火墙规则...</div> : <><form className="security-group-add" onSubmit={(event) => void addRule(event)}><div className="security-group-add-title">开放端口</div><div className="security-group-form-grid"><label>协议<select value={protocol} disabled={submitting} onChange={(event) => setProtocol(event.target.value)}><option value="tcp">TCP</option><option value="udp">UDP</option></select></label><label>端口或范围<input value={port} disabled={submitting} onChange={(event) => setPort(event.target.value)} placeholder="80 或 8000-9000" /></label><label>来源 CIDR<input value={sourceCidrIp} disabled={submitting} onChange={(event) => setSourceCidrIp(event.target.value)} placeholder="0.0.0.0/0" /></label><label>说明（可选）<input value={description} disabled={submitting} maxLength={80} onChange={(event) => setDescription(event.target.value)} placeholder="例如 Web 服务" /></label></div><button type="submit" className="layui-btn layui-btn-normal" disabled={submitting}>{submitting ? "提交中…" : "开放端口"}</button></form>
          <div className="security-group-rules-head"><strong>已开放端口</strong><button type="button" className="secondary" disabled={submitting} onClick={() => void loadRules()}><RefreshCw size={13} />刷新</button></div><div className="security-group-rule-list">{!rules.length ? <div className="security-group-empty">暂无 IPv4 入方向允许规则</div> : rules.map((rule, index) => <div className="security-group-rule" key={rule.RuleId || `${rule.IpProtocol}-${rule.PortRange}-${rule.SourceCidrIp}-${index}`}><div><strong>{String(rule.IpProtocol || "-").toUpperCase()} {rule.PortRange || "-"}</strong><span>来源：{rule.SourceCidrIp || "-"}</span>{rule.Description && <small>{rule.Description}</small>}</div><button type="button" className="layui-btn layui-btn-danger" disabled={submitting} onClick={() => void deleteRule(rule)}>关闭</button></div>)}</div>
        </>}{error && <p className="security-group-error">{error}</p>}</div>
      <div className="modal-actions"><span /><button type="button" className="secondary" onClick={onClose}>关闭</button></div>
    </section></div>, document.body);
}


