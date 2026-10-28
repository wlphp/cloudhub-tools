import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, FileSpreadsheet, Globe2, Layers, RefreshCw, Search } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { DomainIcp, icpDomain, queryIcp, type IcpState } from "./DomainIcp";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { platformErrorMessage } from "../../platform/api";
import { PaginationBar } from "../../shared/PaginationBar";
import { certificatesClient, type BaotaSiteCertificate } from "../../platform/clients/certificates";
import { preferencesClient } from "../../platform/clients/preferences";
import { normalizeSiteDomain, registrableSiteDomain, siteDomainRows, summarizeSiteDomains, type SiteDomainRow } from "./siteDomains";

function useDomainPage(total: number, filters: unknown[]) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(60);
  useEffect(() => { setPage(1); }, filters);
  const safePage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
  return { page: safePage, pageSize, start: (safePage - 1) * pageSize, setPage, setPageSize: (size: number) => { setPageSize(size); setPage(1); } };
}

function DomainSummaryDialog({ rows, onClose }: { rows: SiteDomainRow[]; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [excluded, setExcluded] = useState("");
  const exclusionInput = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState("");
  const [exporting, setExporting] = useState(false);
  const groups = useMemo(() => summarizeSiteDomains(rows), [rows]);
  const exclusions = excluded.split(/[\s,，;；、]+/).filter(Boolean).map(value => registrableSiteDomain(value) ?? normalizeSiteDomain(value)).filter(Boolean);
  const matches = groups.filter(group => group.domain.includes(search.trim().toLowerCase()) && !exclusions.includes(group.domain));
  const pagination = useDomainPage(matches.length, [search, excluded]);
  function exclude(domain: string) {
    if (!exclusions.includes(domain)) setExcluded(value => `${value.trim()}${value.trim() ? "\n" : ""}${domain}`);
    setStatus(`已将 ${domain} 加入排除`);
    exclusionInput.current?.focus({ preventScroll: true });
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setStatus("已复制主域名"); }
    catch { setStatus("复制失败，请检查剪贴板权限"); }
  }
  async function exportText() {
    if (exporting || !matches.length) return;
    setExporting(true);
    try {
      const path = await certificatesClient.exportDomains("baota-site-domain-summary", matches.map(group => group.domain));
      if (path) setStatus(`TXT 已导出：${matches.length} 个主域名，每行一个`);
    } catch (reason) { setStatus(platformErrorMessage(reason, "导出 TXT 失败")); }
    finally { setExporting(false); }
  }
  async function exportSpreadsheet() {
    if (exporting || !matches.length) return;
    setExporting(true);
    try {
      const summaryRows = matches.map((group, index) => ({ index: index + 1, domain: group.domain, domainCount: group.domains.size, siteCount: group.sites.size }));
      const path = await certificatesClient.exportBaotaDomainSummary("baota-site-domain-summary", summaryRows);
      if (path) setStatus(`Excel 已导出：${summaryRows.length} 行`);
    } catch (reason) { setStatus(platformErrorMessage(reason, "导出 Excel 失败")); }
    finally { setExporting(false); }
  }
  return <SharedDialog title="汇总主域名" subtitle="当前域名筛选范围 · 子域名与通配符合并去重" icon={<Layers size={18} aria-hidden="true" />} className="baota-site-domains-dialog baota-domain-summary-dialog" onClose={onClose} initialFocus="input" footer={<><span className="baota-domain-status" role="status">{status}</span><PaginationBar page={pagination.page} pageSize={pagination.pageSize} total={matches.length} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize} pageSizeOptions={[30, 60, 120]} /><button type="button" className="secondary" onClick={onClose}>返回域名列表</button></>}>
    <div className="baota-domain-filters baota-domain-summary-filters">
      <label><span>主域名</span><div className="baota-domain-search"><Search size={14} aria-hidden="true" /><input aria-label="模糊搜索主域名" placeholder="搜索主域名" value={search} onChange={event => setSearch(event.target.value)} /></div></label>
      <div className="baota-domain-summary-actions">
        <button type="button" className="secondary" disabled={!matches.length || exporting} onClick={() => void copy(matches.map(group => group.domain).join("\n"))}><Copy size={14} aria-hidden="true" />复制结果</button>
        <button type="button" className="secondary" disabled={!matches.length || exporting} onClick={() => void exportText()}><Download size={14} aria-hidden="true" />导出 TXT</button>
        <button type="button" className="secondary" disabled={!matches.length || exporting} onClick={() => void exportSpreadsheet()}><FileSpreadsheet size={14} aria-hidden="true" />{exporting ? "导出中…" : "导出表格"}</button>
      </div>
      <label className="baota-domain-exclusions"><span>排除域名</span><textarea ref={exclusionInput} aria-label="排除多个主域名" placeholder="粘贴要排除的域名，支持空格、逗号或换行" value={excluded} onChange={event => setExcluded(event.target.value)} rows={1} /></label>
    </div>
    <div className="baota-domain-caption"><span>主域名 <strong>{matches.length}</strong><span className="baota-domain-caption-muted"> / {groups.length}</span></span><small title="依据本地公共后缀表归并；IP 地址及无法归并的名称不计入">已合并子域名与通配符</small></div>
    <div className="table-wrap"><table><colgroup><col className="baota-domain-index-col" /><col /><col className="baota-domain-count-col" /><col className="baota-domain-count-col" /><col className="baota-domain-action-col" /></colgroup><thead><tr><th>序号</th><th>主域名</th><th>域名数</th><th>站点数</th><th>操作</th></tr></thead><tbody>{matches.slice(pagination.start, pagination.start + pagination.pageSize).map((group, index) => <tr key={group.domain}><td>{pagination.start + index + 1}</td><td><span className="baota-domain-name" title={group.domain}>{group.domain}</span></td><td>{group.domains.size}</td><td>{group.sites.size}</td><td><div className="baota-domain-row-actions"><button type="button" className="baota-domain-copy" title={`复制 ${group.domain}`} aria-label={`复制主域名 ${group.domain}`} onClick={() => void copy(group.domain)}><Copy size={14} aria-hidden="true" /></button><button type="button" className="baota-domain-copy baota-domain-exclude" title={`将 ${group.domain} 加入排除`} aria-label={`加入排除 ${group.domain}`} onClick={() => exclude(group.domain)}>排除</button></div></td></tr>)}</tbody></table>{!matches.length && <p className="baota-domain-empty">没有匹配的主域名</p>}</div>
  </SharedDialog>;
}

type DnsResult = { ips: string[]; checkedAt: number; error: string | null };
type DnsCache = Record<string, DnsResult>;
const DNS_CACHE_KEY = "baota.domain-dns-cache.v1";
const DNS_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
const DNS_CACHE_MAX_ENTRIES = 1500;

export function BaotaSiteDomainsDialog({ sites, onClose, onRemove, defaultSiteName = "" }: { sites: BaotaSiteCertificate[]; onClose: () => void; onRemove: (site: BaotaSiteCertificate, domain: string) => Promise<void>; defaultSiteName?: string }) {
  const [domainSearch, setDomainSearch] = useState("");
  const [siteSearch, setSiteSearch] = useState("");
  const [defaultSiteFilter, setDefaultSiteFilter] = useState(defaultSiteName);
  const [consistencyFilter, setConsistencyFilter] = useState("all");
  const [dnsCache, setDnsCache] = useState<DnsCache>({});
  const [dnsRunning, setDnsRunning] = useState(false);
  const [dnsProgress, setDnsProgress] = useState("");
  const [icpCache, setIcpCache] = useState<Record<string, IcpState>>({});
  const icpPending = useRef(new Set<string>());
  const icpBatchRef = useRef(false);
  const [icpRunning, setIcpRunning] = useState(false);
  const [icpProgress, setIcpProgress] = useState("");
  async function checkIcp(domain: string) {
    const target = icpDomain(domain);
    if (!target || icpPending.current.has(target)) return;
    icpPending.current.add(target);
    const previous = icpCache[target]?.data;
    setIcpCache(current => ({ ...current, [target]: { data: previous, loading: true } }));
    try {
      const result = await queryIcp(target, previous);
      setIcpCache(current => ({ ...current, [target]: result }));
    } finally { icpPending.current.delete(target); }
  }
  async function checkAllIcp() {
    if (icpBatchRef.current) return;
    icpBatchRef.current = true; setIcpRunning(true);
    const targets = [...new Set(matches.map(row => icpDomain(row.domain)).filter((domain): domain is string => !!domain))];
    try {
      for (const [index, target] of targets.entries()) {
        setIcpProgress(`备案检测 ${index + 1}/${targets.length}：${target}`);
        await checkIcp(target);
      }
      setIcpProgress(`备案检测结束，共 ${targets.length} 个主域名；结果与失败原因见各行。`);
    } finally { icpBatchRef.current = false; setIcpRunning(false); }
  }
  const [summary, setSummary] = useState(false);
  const [status, setStatus] = useState("");
  const [removeTarget, setRemoveTarget] = useState<SiteDomainRow | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [batchTargets, setBatchTargets] = useState<SiteDomainRow[] | null>(null);
  const [batchFailures, setBatchFailures] = useState<{ key: string; domain: string; siteName: string; message: string }[]>([]);
  const [removing, setRemoving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const removingRef = useRef(false);
  const dnsRunRef = useRef(false);
  function pruneDnsCache(cache: DnsCache): DnsCache {
    const now = Date.now();
    const entries = Object.entries(cache)
      .filter(([domain, result]) => domain.length > 0 && result && Number.isFinite(result.checkedAt) && result.checkedAt > 0 && result.checkedAt <= now && now - result.checkedAt <= DNS_CACHE_MAX_AGE && Array.isArray(result.ips))
      .sort(([, first], [, second]) => second.checkedAt - first.checkedAt);
    const bounded: DnsCache = {};
    for (const [domain, result] of entries) {
      if (Object.keys(bounded).length >= DNS_CACHE_MAX_ENTRIES) break;
      const safeResult: DnsResult = {
        ips: result.ips.filter((ip): ip is string => typeof ip === "string" && ip.length <= 64).slice(0, 32),
        checkedAt: result.checkedAt,
        error: typeof result.error === "string" ? result.error.slice(0, 500) : null,
      };
      const candidate = { ...bounded, [domain]: safeResult };
      if (new TextEncoder().encode(JSON.stringify(candidate)).length > 90_000) continue;
      bounded[domain] = safeResult;
    }
    return bounded;
  }
  useEffect(() => { let active = true; void preferencesClient.list().then(values => { if (!active) return; try { const parsed: unknown = JSON.parse(values[DNS_CACHE_KEY] ?? "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) setDnsCache(pruneDnsCache(parsed as DnsCache)); } catch { setDnsCache({}); } }).catch(() => { /* DNS cache is an optional local convenience. */ }); return () => { active = false; }; }, []);
  async function saveDnsCache(next: DnsCache) { const bounded = pruneDnsCache(next); setDnsCache(bounded); try { await preferencesClient.save(DNS_CACHE_KEY, JSON.stringify(bounded)); } catch { setStatus("DNS 结果已检测，但本地缓存保存失败"); } }
  async function checkAllDomains() {
    if (dnsRunRef.current || !matches.length) return;
    dnsRunRef.current = true; setDnsRunning(true); setStatus("");
    const next = { ...dnsCache };
    const targets = [...new Set(matches.map(row => row.domain))];
    let done = 0;
    try {
      for (const domain of targets) {
        if (!next[domain] || Date.now() - next[domain].checkedAt > DNS_CACHE_MAX_AGE) {
          try { next[domain] = { ips: await certificatesClient.resolveBaotaDomain(domain), checkedAt: Date.now(), error: null }; }
          catch (reason) { next[domain] = { ips: [], checkedAt: Date.now(), error: platformErrorMessage(reason, "DNS 解析失败") }; }
          await saveDnsCache({ ...next });
        }
        done++; setDnsProgress(`检测 ${done}/${targets.length}：${domain}`);
      }
      setStatus(`DNS 检测完成：${targets.length} 个域名`);
    } finally { dnsRunRef.current = false; setDnsRunning(false); setDnsProgress(""); }
  }
  async function removeDomain(confirmed: boolean) {
    if (removingRef.current) return;
    if (!confirmed || !removeTarget) { setRemoveTarget(null); return; }
    const target = removeTarget;
    removingRef.current = true; setRemoving(true); setError(""); setStatus("");
    try {
      await onRemove(target.site, target.domain);
      setStatus(`已从 ${target.site.siteName} 移除 ${target.domain}`);
    } catch (reason) { setError(platformErrorMessage(reason, "移除失败，请核对宝塔绑定后重试")); }
    finally { removingRef.current = false; setRemoving(false); setRemoveTarget(null); }
  }
  const rows = useMemo(() => siteDomainRows(sites), [sites]);
  const matches = useMemo(() => rows.filter(row => {
    const result = dnsCache[row.domain];
    const serverIp = row.site.serverIp?.trim();
    const consistency = !result || !serverIp ? "unknown" : result.error ? "error" : result.ips.includes(serverIp) ? "same" : "different";
    return row.domain.includes(domainSearch.trim().toLowerCase())
      && `${row.site.siteName} ${row.site.siteRemark ?? ""} ${row.site.panelName}`.toLowerCase().includes(siteSearch.trim().toLowerCase())
      && (!defaultSiteFilter.trim() || row.site.siteName.toLowerCase().includes(defaultSiteFilter.trim().toLowerCase()))
      && (consistencyFilter === "all" || consistencyFilter === consistency);
  }), [rows, domainSearch, siteSearch, defaultSiteFilter, consistencyFilter, dnsCache]);
  const pagination = useDomainPage(matches.length, [domainSearch, siteSearch, defaultSiteFilter, consistencyFilter]);
  const selectableRows = matches.filter(row => row.site.panelId && new Set(row.site.siteDomains.map(domain => domain.trim().toLowerCase()).filter(Boolean)).size > 1);
  const selectedRows = selectableRows.filter(row => selectedKeys.has(row.key));
  const allSelected = selectableRows.length > 0 && selectedRows.length === selectableRows.length;
  useEffect(() => {
    const visibleKeys = new Set(matches.map(row => row.key));
    setSelectedKeys(current => {
      const next = new Set([...current].filter(key => visibleKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [matches]);
  function toggleSelection(key: string, checked: boolean) {
    if (removingRef.current) return;
    setSelectedKeys(current => {
      const next = new Set(current);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }
  function prepareBatchRemoval() {
    if (removingRef.current || !selectedRows.length) return;
    const counts = new Map<number, number>();
    for (const row of selectedRows) counts.set(row.site.id, (counts.get(row.site.id) ?? 0) + 1);
    const blocked = selectedRows.find(row => (counts.get(row.site.id) ?? 0) >= new Set(row.site.siteDomains.map(domain => domain.trim().toLowerCase()).filter(Boolean)).size);
    if (blocked) {
      setError(`站点 ${blocked.site.siteName} 的全部域名已被选中，请至少取消勾选一个域名后再批量移除。`);
      return;
    }
    setError(""); setBatchFailures([]); setBatchTargets([...selectedRows]);
  }
  async function removeBatch(confirmed: boolean) {
    if (removingRef.current) return;
    if (!confirmed || !batchTargets) { setBatchTargets(null); return; }
    const targets = batchTargets;
    removingRef.current = true; setRemoving(true); setError(""); setBatchFailures([]);
    let succeeded = 0;
    const failures: { key: string; domain: string; siteName: string; message: string }[] = [];
    try {
      for (const [index, target] of targets.entries()) {
        setStatus(`正在移除 ${index + 1}/${targets.length}：${target.domain}`);
        try {
          await onRemove(target.site, target.domain);
          succeeded++;
          setSelectedKeys(current => { const next = new Set(current); next.delete(target.key); return next; });
        } catch (reason) {
          failures.push({ key: target.key, domain: target.domain, siteName: target.site.siteName, message: platformErrorMessage(reason, "移除失败，请核对宝塔绑定后重试") });
        }
      }
      setBatchFailures(failures);
      setStatus(`批量移除完成：成功 ${succeeded} 个，失败 ${failures.length} 个。失败项未自动重试，请先核对远端绑定。`);
    } finally {
      removingRef.current = false; setRemoving(false); setBatchTargets(null);
    }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setStatus("已复制域名"); }
    catch { setStatus("复制失败，请检查剪贴板权限"); }
  }
  async function exportDomainText() {
    if (exporting || !matches.length) return;
    setError(""); setExporting(true);
    try {
      const domains = [...new Map(matches.map(row => [row.domain.toLowerCase(), row.domain])).values()];
      const path = await certificatesClient.exportDomains("站点域名", domains);
      if (path) setStatus(`TXT 已导出：${domains.length} 个去重域名`);
    } catch (reason) { setError(platformErrorMessage(reason, "导出 TXT 失败")); }
    finally { setExporting(false); }
  }
  async function exportDomainExcel() {
    if (exporting || !matches.length) return;
    setError(""); setExporting(true);
    try {
      const exportRows = matches.map((row, index) => {
        const result = dnsCache[row.domain];
        const serverIp = row.site.serverIp?.trim() ?? "";
        const dnsIps = !result ? "未检测" : result.error ? result.error : result.ips.join("、") || "无解析记录";
        const consistency = !result || !serverIp ? "未知" : result.error ? "解析失败" : result.ips.includes(serverIp) ? "一致" : "不一致";
        return { index: index + 1, domain: row.domain, serverIp: serverIp || "未获取", dnsIps, consistency, site: [row.site.siteName, row.site.siteRemark, row.site.panelName].filter(Boolean).join(" · ") };
      });
      const path = await certificatesClient.exportBaotaDomainRows("站点域名", exportRows);
      if (path) setStatus(`Excel 已导出：${exportRows.length} 行`);
    } catch (reason) { setError(platformErrorMessage(reason, "导出 Excel 失败")); }
    finally { setExporting(false); }
  }
  return <>
    <SharedDialog title="当前条件下的站点域名" subtitle={`共 ${sites.length} 个站点 · 当前筛选范围的全部域名`} icon={<Globe2 size={18} aria-hidden="true" />} className="baota-site-domains-dialog" onClose={onClose} closeDisabled={removing} initialFocus="input" footer={<><span className="baota-domain-status" role="status">{status}</span><PaginationBar page={pagination.page} pageSize={pagination.pageSize} total={matches.length} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize} pageSizeOptions={[30, 60, 120]} /><button type="button" className="secondary" disabled={removing} onClick={onClose}>关闭</button></>}>
      <div className="baota-domain-filters">
        <label><span>域名</span><div className="baota-domain-search"><Search size={14} aria-hidden="true" /><input aria-label="模糊搜索站点域名" placeholder="搜索域名" value={domainSearch} onChange={event => setDomainSearch(event.target.value)} /></div></label>
        <label><span>站点</span><div className="baota-domain-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索所属站点" placeholder="名称 / 备注 / 面板" value={siteSearch} onChange={event => setSiteSearch(event.target.value)} /></div></label>
        <label><span>默认站点</span><div className="baota-domain-search"><Search size={14} aria-hidden="true" /><input aria-label="检索默认站点" placeholder="输入默认站点名称" value={defaultSiteFilter} onChange={event => setDefaultSiteFilter(event.target.value)} /></div></label>
        <label className="baota-domain-consistency-filter"><span>指向一致</span><select aria-label="筛选 DNS 指向一致性" value={consistencyFilter} onChange={event => setConsistencyFilter(event.target.value)}><option value="all">全部</option><option value="same">一致</option><option value="different">不一致</option><option value="unknown">未检测 / 无服务器 IP</option><option value="error">解析失败</option></select></label>
        <div className="baota-domain-filter-actions">
          <button type="button" className="secondary" disabled={!matches.length} onClick={() => setSummary(true)}><Layers size={14} aria-hidden="true" />汇总主域名</button>
          <button type="button" className="secondary" disabled={!matches.length} onClick={() => void copy([...new Set(matches.map(row => row.domain))].join("\n"))}><Copy size={14} aria-hidden="true" />复制结果</button>
          <button type="button" className="secondary" disabled={icpRunning || !matches.length} onClick={() => void checkAllIcp()}><RefreshCw size={14} aria-hidden="true" className={icpRunning ? "spin" : undefined} />{icpRunning ? "备案检测中…" : "批量检测备案"}</button>
          <button type="button" className="secondary" disabled={dnsRunning || !matches.length} onClick={() => void checkAllDomains()}><RefreshCw size={14} aria-hidden="true" className={dnsRunning ? "spin" : undefined} />{dnsRunning ? "检测中…" : "批量检测 DNS"}</button>
        </div>
      </div>
      {dnsProgress && <div className="baota-domain-caption" role="status">{dnsProgress}</div>}
      {icpProgress && <div className="baota-domain-caption" role="status">{icpProgress}</div>}
      <div className="baota-domain-caption"><span>域名列表 <strong>{matches.length}</strong><span className="baota-domain-caption-muted"> / {rows.length}</span></span><small>同一域名按所属站点分别展示</small></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="baota-domain-batch-actions">
        <label><input type="checkbox" aria-label="全选当前筛选范围的可移除域名" checked={allSelected} disabled={removing || !selectableRows.length} ref={element => { if (element) element.indeterminate = selectedRows.length > 0 && !allSelected; }} onChange={event => setSelectedKeys(event.target.checked ? new Set(selectableRows.map(row => row.key)) : new Set())} />全选筛选结果（跨页）</label>
        <span>已选 {selectedRows.length} 个</span>
        <button type="button" className="secondary" disabled={removing || !selectedRows.length} onClick={() => setSelectedKeys(new Set())}>清空选择</button>
        <button type="button" className="secondary baota-domain-remove" disabled={removing || !selectedRows.length} onClick={prepareBatchRemoval}>批量移除（{selectedRows.length}）</button>
        <span className="baota-domain-export-actions"><button type="button" className="secondary" disabled={removing || exporting || !matches.length} onClick={() => void exportDomainText()} title="导出当前筛选结果中的去重域名，每行一个"><Download size={14} aria-hidden="true" />导出 TXT</button><button type="button" className="secondary" disabled={removing || exporting || !matches.length} onClick={() => void exportDomainExcel()} title="导出当前筛选结果全部数据列，不限当前分页"><FileSpreadsheet size={14} aria-hidden="true" />{exporting ? "导出中…" : "导出 Excel"}</button></span>
      </div>
      {batchFailures.length > 0 && <div className="baota-domain-batch-failures" role="alert"><strong>以下域名移除失败，请核对远端绑定后再操作：</strong><ul>{batchFailures.map(failure => <li key={failure.key}>{failure.domain} · {failure.siteName}：{failure.message}</li>)}</ul></div>}
      <div className="table-wrap"><table><colgroup><col className="baota-domain-index-col" /><col /><col /><col /><col /><col /><col /><col className="baota-domain-action-col" /></colgroup><thead><tr><th>序号</th><th>域名</th><th>服务器 IP</th><th>DNS 解析 IP</th><th>一致性</th><th>ICP备案</th><th>站点</th><th>操作</th></tr></thead><tbody>{matches.slice(pagination.start, pagination.start + pagination.pageSize).map((row, index) => <tr key={row.key}><td><label className="baota-domain-row-selection"><input type="checkbox" aria-label={`选择 ${row.site.siteName} 的域名 ${row.domain}`} checked={selectedKeys.has(row.key)} disabled={removing || !row.site.panelId || new Set(row.site.siteDomains.map(domain => domain.trim().toLowerCase()).filter(Boolean)).size <= 1} onChange={event => toggleSelection(row.key, event.target.checked)} /><span>{pagination.start + index + 1}</span></label></td><td><span className="baota-domain-name" title={row.domain}>{row.domain}</span></td><td>{row.site.serverIp || "未获取"}</td><td>{dnsCache[row.domain] ? dnsCache[row.domain].error ? dnsCache[row.domain].error : dnsCache[row.domain].ips.join("、") || "无解析记录" : "未检测"}</td><td>{!dnsCache[row.domain] || !row.site.serverIp ? "未知" : dnsCache[row.domain].error ? "解析失败" : dnsCache[row.domain].ips.includes(row.site.serverIp.trim()) ? "一致" : "不一致"}</td><td><DomainIcp domain={row.domain} state={icpCache[icpDomain(row.domain) ?? ""]} onQuery={() => checkIcp(row.domain)} /></td><td><span className="baota-domain-site" title={row.site.siteName}>{row.site.siteName}</span><span className="baota-domain-site-meta" title={[row.site.siteRemark, row.site.panelName].filter(Boolean).join(" · ")}>{[row.site.siteRemark, row.site.panelName].filter(Boolean).join(" · ")}</span></td><td><div className="baota-domain-row-actions"><button type="button" className="baota-domain-copy" title={`复制 ${row.domain}`} aria-label={`复制域名 ${row.domain}`} onClick={() => void copy(row.domain)}><Copy size={14} aria-hidden="true" /></button><button type="button" className="baota-domain-copy baota-domain-remove" aria-label={`移除 ${row.site.siteName} 的域名 ${row.domain}`} title={!row.site.panelId ? "来源面板已移除" : new Set(row.site.siteDomains.map(domain => domain.trim().toLowerCase()).filter(Boolean)).size <= 1 ? "站点至少保留一个域名" : "调用宝塔接口解除此域名绑定"} disabled={removing || !row.site.panelId || new Set(row.site.siteDomains.map(domain => domain.trim().toLowerCase()).filter(Boolean)).size <= 1} onClick={() => { setError(""); setRemoveTarget(row); }}>移除</button></div></td></tr>)}</tbody></table>{!matches.length && <p className="baota-domain-empty">没有匹配的域名</p>}</div>
    </SharedDialog>
    {summary && <DomainSummaryDialog rows={matches} onClose={() => setSummary(false)} />}
    {batchTargets && <ConfirmDialog title="批量移除站点域名" confirmLabel={`确认移除 ${batchTargets.length} 个域名`} busy={removing} message={`将调用宝塔接口真实解除以下 ${batchTargets.length} 个域名绑定，影响这些域名对所属站点的访问。每个站点至少保留一个域名。目标：${batchTargets.map(row => `${row.site.panelName} / ${row.site.siteName} / ${row.domain}`).join("；")}`} onResolve={confirmed => void removeBatch(confirmed)} />}
    {removeTarget && <ConfirmDialog title="移除站点域名" confirmLabel="确认移除" busy={removing} message={`确认从面板 ${removeTarget.site.panelName} 的站点 ${removeTarget.site.siteName} 移除域名 ${removeTarget.domain}？这会调用宝塔接口真实解除该域名绑定，影响该域名对站点的访问。`} onResolve={confirmed => void removeDomain(confirmed)} />}
  </>;
}
