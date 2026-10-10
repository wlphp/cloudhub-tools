import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { Account, LocalAsset } from "../shared/types";
import { certificatesClient, type CertificateRequest } from "../platform/clients/certificates";
import { resourcesClient } from "../platform/clients/resources";
import { platformErrorMessage, runningInTauri } from "../platform/api";
import { SecretField } from "../shared/SecretField";
import { certificateDomains, validateCertificateRequest } from "./certificate-request";
import "./mobile-certificate-request.css";

type Progress = { operationId: string; stage: string; level: string; message: string };
const steps = ["创建申请", "DNS 验证", "签发证书", "加密保存"];
const progressStep = (stage: string) => ["store", "completed"].includes(stage) ? 3 : ["finalize", "download"].includes(stage) ? 2 : stage.startsWith("dns") ? 1 : 0;
const domainName = (asset: LocalAsset) => String(asset.payload?.DomainName || asset.asset_key).trim().toLowerCase().replace(/\.$/, "");

export function MobileCertificateRequest({ accounts, onClose, onIssued }: { accounts: Account[]; onClose: () => void; onIssued: () => void }) {
  const dnsAccounts = accounts.filter((account) => account.cloud_type === "aliyun");
  const [accountId, setAccountId] = useState(String(dnsAccounts[0]?.id ?? ""));
  const [assets, setAssets] = useState<LocalAsset[]>([]);
  const [zone, setZone] = useState("");
  const [domains, setDomains] = useState("");
  const [provider, setProvider] = useState<"letsencrypt" | "litessl">("letsencrypt");
  const [eabKid, setEabKid] = useState("");
  const [eabHmacKey, setEabHmacKey] = useState("");
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const operation = useRef<string | null>(null);
  const unlisten = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  const cancelRequested = useRef(false);
  const invoked = useRef(false);
  const zones = [...new Set(assets.filter((asset) => asset.account_id === Number(accountId) && asset.resource_type === "domain").map(domainName))].sort();

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    form.current?.focus();
    void resourcesClient.listLocal({ resourceType: "domain" }).then((result) => { if (mounted.current) setAssets(result); }).catch((reason) => { if (mounted.current) setError(platformErrorMessage(reason,"读取域名资产失败")); }).finally(() => { if (mounted.current) setReading(false); });
    return () => {
      mounted.current = false; unlisten.current?.();
      if (operation.current && invoked.current) void certificatesClient.cancel(operation.current).catch(() => {});
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    const available = assets.filter((asset) => asset.account_id === Number(accountId) && asset.resource_type === "domain").map(domainName);
    if (available.includes(zone)) return;
    setZone(available[0] ?? ""); setDomains(available[0] ?? "");
  }, [accountId, assets, zone]);

  async function refreshZones() {
    if (!accountId || !runningInTauri) return;
    setReading(true); setError("");
    try {
      const result = await resourcesClient.sync(Number(accountId), ["domain"]);
      if (!mounted.current) return;
      setAssets(await resourcesClient.listLocal({ resourceType: "domain" }));
      if (result.errors.length) setError("部分域名拉取失败，请检查 DNS 账号权限后重试");
    } catch (reason) { if (mounted.current) setError(platformErrorMessage(reason,"拉取域名失败")); }
    finally { if (mounted.current) setReading(false); }
  }

  async function cancel() {
    if (!operation.current) { onClose(); return; }
    cancelRequested.current = true; setCancelling(true); setError("");
    if (!invoked.current) return;
    try { await certificatesClient.cancel(operation.current); }
    catch (reason) { if (mounted.current) { setCancelling(false); setError(platformErrorMessage(reason,"取消申请失败")); } }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (operation.current || !runningInTauri || completed) return;
    const names = certificateDomains(domains);
    const input: CertificateRequest = { accountId:Number(accountId), provider, dnsZone:zone, primaryDomain:names[0] ?? "", domains:names,
      eabKid:provider === "litessl" ? eabKid.trim() : undefined, eabHmacKey:provider === "litessl" ? eabHmacKey.trim() : undefined };
    const validation = validateCertificateRequest(input,zones);
    if (validation) { setError(validation); return; }
    const operationId = crypto.randomUUID();
    operation.current = operationId; cancelRequested.current = false; invoked.current = false;
    setBusy(true); setCancelling(false); setError(""); setStage(0); setLogs(["正在准备申请…"]);
    try {
      unlisten.current = await listen<Progress>("certificate-request-progress", ({payload}) => {
        if (!mounted.current || payload.operationId !== operation.current) return;
        if (payload.stage !== "failed") setStage(progressStep(payload.stage));
        setLogs((current) => [...current.slice(-39), payload.message]);
      });
      if (cancelRequested.current || !mounted.current) {
        if (mounted.current) setLogs(["申请已取消，尚未创建验证记录"]);
        return;
      }
      invoked.current = true;
      await certificatesClient.request({...input, operationId});
      if (mounted.current) { setCompleted(true); setStage(3); setLogs((current) => [...current.slice(-39),"证书申请成功，已加密保存到本机"]); onIssued(); }
    } catch (reason) {
      if (mounted.current) setError(platformErrorMessage(reason,"证书申请失败"));
    } finally {
      unlisten.current?.(); unlisten.current = null; operation.current = null; invoked.current = false;
      if (mounted.current) { setBusy(false); setCancelling(false); setEabKid(""); setEabHmacKey(""); }
    }
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); if (!cancelling) void cancel(); return; }
    if (event.key !== "Tab") return;
    const controls = [...(form.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') ?? [])].filter((element) => element.offsetParent !== null && element.tabIndex >= 0);
    const first = controls[0], last = controls[controls.length-1];
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === form.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="mobile-modal-backdrop mobile-cert-request-backdrop"><form ref={form} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="mobile-cert-request-title" className="mobile-cert-request" onSubmit={(event) => void submit(event)} onKeyDown={keyDown}>
    <header><div><small>DNS-01 自动验证</small><h2 id="mobile-cert-request-title">申请证书</h2></div><button type="button" aria-label={busy ? "取消证书申请" : "关闭申请证书"} disabled={cancelling} onClick={() => void cancel()}><X size={19} /></button></header>
    {!runningInTauri && <p className="mobile-cert-request-hint">请在手机 App 中提交申请，浏览器可预览申请表单。</p>}
    <fieldset disabled={busy || reading || completed}>
      <label>证书品牌<select aria-label="证书品牌" value={provider} onChange={(event) => { setProvider(event.target.value as typeof provider); setEabKid(""); setEabHmacKey(""); }}><option value="letsencrypt">Let's Encrypt · 免费</option><option value="litessl">LiteSSL · EAB</option></select></label>
      {provider === "litessl" && <><label>EAB KID<input aria-label="EAB KID" required autoComplete="off" maxLength={256} value={eabKid} onChange={(event) => setEabKid(event.target.value)} /></label><label>EAB HMAC 密钥<SecretField required secretLabel="EAB HMAC 密钥" autoComplete="off" maxLength={2048} value={eabHmacKey} onChange={(event) => setEabHmacKey(event.target.value)} /></label><p className="mobile-cert-request-hint">EAB 凭据仅用于本次签发，不保存。</p></>}
      <label>DNS 账号<select aria-label="DNS 账号" required value={accountId} onChange={(event) => { setAccountId(event.target.value); setZone(""); setDomains(""); setError(""); }}><option value="">选择阿里云账号</option>{dnsAccounts.map((account) => <option key={account.id} value={account.id}>{account.account_name}</option>)}</select></label>
      <div className="mobile-cert-zone-label"><span>DNS 区域</span><button type="button" disabled={!accountId || !runningInTauri} onClick={() => void refreshZones()}><RefreshCw size={13} aria-hidden="true" />拉取域名</button></div>
      <select required aria-label="DNS 区域" value={zone} onChange={(event) => { setZone(event.target.value); setDomains(event.target.value); }}><option value="">选择已同步域名</option>{zones.map((name) => <option key={name}>{name}</option>)}</select>
      <label>证书域名<textarea aria-label="证书域名" required rows={3} maxLength={25400} autoCapitalize="none" spellCheck={false} value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="example.com\n*.example.com" /></label>
      {zone && <div className="mobile-cert-domain-presets"><button type="button" onClick={() => setDomains(zone)}>主域名</button><button type="button" onClick={() => setDomains(`*.${zone}`)}>通配符</button><button type="button" onClick={() => setDomains(`${zone}\n*.${zone}`)}>主域名 + 通配符</button></div>}
    </fieldset>
    {reading && <p role="status" className="mobile-cert-request-hint">正在读取域名…</p>}
    {!reading && !dnsAccounts.length && <p className="mobile-cert-request-hint">请先添加阿里云 DNS 账号，再申请证书。</p>}
    {!reading && accountId && !zones.length && <p className="mobile-cert-request-hint">该账号尚未同步域名，请点击“拉取域名”。</p>}
    <p className="mobile-cert-request-hint">自动创建并清理 TXT 验证记录。DNS 验证可能需要几分钟，请保持 App 打开。</p>
    {!!logs.length && <section className="mobile-cert-request-progress" aria-label="证书申请进度"><ol>{steps.map((step,index) => <li key={step} aria-current={!completed && index === stage ? "step" : undefined} data-done={completed || index < stage}><span>{completed || index < stage ? <Check size={12} /> : index+1}</span>{step}</li>)}</ol><div role="log" aria-live="polite" aria-label="证书签发进度">{logs.map((line,index) => <p key={index}>{line}</p>)}</div></section>}
    {error && <p role="alert" className="mobile-cert-request-error">{error}</p>}
    {completed && <p className="mobile-cert-request-success" role="status"><ShieldCheck size={16} />证书已签发并保存</p>}
    <footer><button type="button" disabled={cancelling} onClick={() => void cancel()}>{completed ? "完成" : cancelling ? "正在取消…" : busy ? "取消申请" : "取消"}</button>{!completed && <button type="submit" disabled={busy || reading || !runningInTauri || !accountId || !zones.length}>{busy ? "正在签发…" : "开始申请"}</button>}</footer>
  </form></div>;
}
