import { useEffect, useState } from "react";
import { ChevronRight, Cloud, FileArchive, FolderOpen, HardDrive, RefreshCw, ScanLine } from "lucide-react";
import { appClient } from "../platform/clients/app";
import { runningInTauri } from "../platform/api";
import "../features/accounts/sync-transfer.css";
import { MobileDataDirectoryDialog } from "./MobileDataDirectoryDialog";

export type MobileMigrationDestination = "syncReceive" | "syncBackup" | "syncCloud";

const entries = [
  { destination: "syncReceive", title: "扫码接收", description: "扫描电脑端迁移二维码，预览并导入配置", icon: ScanLine },
  { destination: "syncBackup", title: "导入本地备份", description: "选择 .chdb 备份文件，先预览再恢复", icon: FileArchive },
  { destination: "syncCloud", title: "云同步", description: "管理 WebDAV、S3 或阿里云 OSS 渠道，上传与恢复备份", icon: Cloud },
] as const;

export function MobileDataMigrationPage({ onNavigate }: { onNavigate: (destination: MobileMigrationDestination) => void }) {
  const [dataPath, setDataPath] = useState("");
  const [loading, setLoading] = useState(runningInTauri);
  const [error, setError] = useState("");
  const [directoryOpen, setDirectoryOpen] = useState(false);

  useEffect(() => {
    if (!runningInTauri) return;
    let active = true;
    void appClient.dataPath().then(path => { if (active) setDataPath(path); })
      .catch(() => { if (active) setError("读取存储位置失败，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function refreshPath() {
    setLoading(true);
    setError("");
    try { setDataPath(await appClient.dataPath()); }
    catch { setError("读取存储位置失败，请重试。"); }
    finally { setLoading(false); }
  }

  return <div className="sync-transfer-panel sync-transfer-mobile sync-transfer-mobile-page mobile-migration-index">
    <section className="mobile-import-card mobile-migration-storage" aria-labelledby="mobile-storage-title">
      <div className="mobile-migration-storage-heading">
        <span className="mobile-provider-avatar"><HardDrive size={20} aria-hidden="true" /></span>
        <div><h2 id="mobile-storage-title">存储位置</h2><p>{!runningInTauri ? "请在手机 App 内查看本机目录" : loading ? "正在读取存储位置…" : error ? "暂时无法读取" : "应用私有目录 · 数据保存在本机"}</p></div>
        <div className="mobile-migration-storage-actions"><button type="button" className="secondary" aria-label="打开数据目录" title="打开数据目录" disabled={!runningInTauri || loading || !dataPath} onClick={() => setDirectoryOpen(true)}><FolderOpen size={18} aria-hidden="true" /></button><button type="button" className="secondary" aria-label="刷新存储位置" title="刷新存储位置" disabled={!runningInTauri || loading} onClick={() => void refreshPath()}><RefreshCw size={18} className={loading ? "mobile-spin" : ""} aria-hidden="true" /></button></div>
      </div>
      {dataPath && <details className="mobile-migration-storage-details"><summary>查看数据目录</summary><div id="mobile-data-path" role="textbox" aria-label="CloudHub 数据目录" aria-readonly="true" tabIndex={0}>{dataPath}</div><p>数据库、加密密钥与本机备份保存在此目录。</p></details>}
      {error && <p className="mobile-migration-storage-error" role="alert">{error}</p>}
    </section>
    <nav className="mobile-migration-entries" aria-label="数据导入与迁移方式">
      {entries.map(({ destination, title, description, icon: Icon }) => <button key={destination} type="button" className="mobile-migration-entry" onClick={() => onNavigate(destination)}>
        <span className="mobile-provider-avatar"><Icon size={20} aria-hidden="true" /></span>
        <span className="mobile-migration-entry-copy"><strong>{title}</strong><small>{description}</small></span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>)}
    </nav>
    {directoryOpen && <MobileDataDirectoryDialog onClose={() => setDirectoryOpen(false)} />}
  </div>;
}
