import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, File, Folder, RefreshCw } from "lucide-react";
import { appClient, type AppDataEntry } from "../platform/clients/app";
import { SharedDialog } from "../shared/SharedDialog";

function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function MobileDataDirectoryDialog({ onClose }: { onClose: () => void }) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<AppDataEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setEntries([]);
    void appClient.listDataDirectory(directory).then(value => { if (active) setEntries(value); })
      .catch(() => { if (active) setError("读取目录失败，请刷新重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [directory, revision]);
  return <SharedDialog title="数据目录" subtitle="应用私有存储 · 只读浏览" icon={<Folder size={18} aria-hidden="true" />} size="small" className="mobile-data-directory-dialog" sizeStorageKey="mobile/data-directory" onClose={onClose} footer={<><button type="button" className="secondary" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />刷新</button><button type="button" className="secondary" onClick={onClose}>关闭</button></>}>
    <div className="mobile-data-directory-toolbar"><button type="button" className="secondary" aria-label="返回上级目录" title="返回上级目录" disabled={!directory || loading} onClick={() => setDirectory(value => value.split("/").slice(0, -1).join("/"))}><ArrowLeft size={18} aria-hidden="true" /></button><span>数据目录{directory && ` / ${directory}`}</span></div>
    {loading ? <p role="status">正在读取目录…</p> : error ? <p role="alert">{error}</p> : entries.length === 0 ? <p role="status">此目录暂无文件。</p> : <ul className="mobile-data-directory-list" aria-label="目录文件">
      {entries.map(entry => <li key={entry.name}>{entry.directory ? <button type="button" aria-label={`打开文件夹 ${entry.name}`} onClick={() => setDirectory(value => value ? `${value}/${entry.name}` : entry.name)}><Folder size={18} aria-hidden="true" /><span>{entry.name}</span><ChevronRight size={16} aria-hidden="true" /></button> : <div><File size={18} aria-hidden="true" /><span>{entry.name}</span><small>{sizeText(entry.sizeBytes)}</small></div>}</li>)}
    </ul>}
  </SharedDialog>;
}
