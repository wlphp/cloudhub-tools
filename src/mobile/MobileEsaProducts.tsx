import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { resourcesClient } from "../platform/clients";
import type { Account, LocalAsset } from "../shared/types";
import { EsaCertificateDialog } from "../features/certificates/EsaCertificateDialog";

export function MobileEsaProducts({ account, accounts, onConfirm }: { account: Account; accounts: Account[]; onConfirm: (message: string) => Promise<boolean> }) {
  const [assets, setAssets] = useState<LocalAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [siteId, setSiteId] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await resourcesClient.listLocal({ accountId: account.id });
      setAssets(result.filter(asset => asset.account_id === account.id));
      setNotice("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "读取边缘安全加速缓存失败"); }
    finally { setLoading(false); }
  }, [account.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const sites = assets.filter(asset => asset.resource_type === "esa");
  return <>
    <button type="button" className="mobile-primary" disabled={loading} onClick={() => void refresh()}><RefreshCw size={16} />刷新</button>
    {notice && <p className="mobile-notice" role="status">{notice}</p>}
    {loading ? <p role="status">正在读取站点缓存…</p> : !sites.length ? <p>暂无缓存站点，请通过账号的“获取资产”同步。</p> : <div className="mobile-domain-list">{sites.map(site => {
      const id = Number(site.payload.SiteId ?? site.payload.siteId ?? site.asset_key);
      const name = String(site.payload.SiteName ?? site.payload.siteName ?? site.payload.Domain ?? site.payload.DomainName ?? site.payload.name ?? site.asset_key);
      return <article className="mobile-domain-card" key={site.asset_key}>
        <div className="mobile-server-heading"><ShieldCheck size={17} /><strong>{name}</strong></div>
        <p>{String(site.payload.Status ?? site.payload.status ?? "状态未知")}</p>
        <div className="mobile-server-actions"><button type="button" disabled={account.cloud_type !== "aliyun" || !Number.isSafeInteger(id) || id <= 0} onClick={() => setSiteId(id)}>证书管理</button></div>
        {account.cloud_type !== "aliyun" && <small>当前云厂商暂不支持站点操作，可查看缓存信息。</small>}
      </article>;
    })}</div>}
    {siteId !== null && <EsaCertificateDialog account={account} siteId={siteId} accounts={accounts} localAssets={assets} onClose={() => setSiteId(null)} onStatus={setNotice} onConfirm={onConfirm} />}
  </>;
}
