import { useEffect, useState } from "react";
import { ArrowUp, CheckSquare, Copy, Download, Eye, File, Folder, Home, Link2, Maximize2, Minimize2, RefreshCw, Search, Square, Upload, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke, runningInTauri, webApi } from "../../platform/api";
import type { Account } from "../../shared/types";
import { displayValue } from "../../shared/utils/display";
import { cloudProvider } from "../cloud/catalog";

function formatBytes(value: unknown): string {
  let bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index += 1; }
  return `${bytes.toFixed(index ? 2 : 0)} ${units[index]}`;
}

function formatCloudDate(value: unknown): string {
  if (!value) return "-";
  const text = String(value).trim();
  if (!text || text === "-") return "-";
  const date = new Date(text.includes("T") ? text : text.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function isViewableObject(name: string): boolean {
  return /\.(avif|bmp|gif|jpe?g|png|svg|webp|html?|pdf|txt|csv|json|xml|md|mp3|m4a|ogg|wav|mp4|webm|mov)$/i.test(name);
}

type OssDetail = {
  storage: number;
  objectCount: number;
  multipartUploadCount: number;
  liveChannelCount: number;
  monthTraffic: number;
  monthRequests: number;
  acl: string;
  cnames: { Domain: string; Status?: string }[];
  cors: { origin: string[]; method: string[]; header: string[] }[];
  errors: string[];
};

type OssObject = {
  Key: string;
  LastModified: string;
  ETag: string;
  Size: string;
};

type OssObjectListing = {
  objects: OssObject[];
  prefixes: string[];
  isTruncated: boolean;
  nextMarker: string;
};

type OssUploadSelection = {
  token: string;
  name: string;
  size: number;
};

export function BucketCard({
  account,
  item,
  quickAction,
  onQuickActionOpened,
  onConfirm,
  onPrompt,
}: {
  account: Account;
  item: Record<string, unknown>;
  quickAction?: "files" | "stat" | null;
  onQuickActionOpened?: () => void;
  onConfirm: (message: string) => Promise<boolean>;
  onPrompt: (message: string, initialValue?: string) => Promise<string | null>;
}) {
  const [objectListing, setObjectListing] = useState<OssObjectListing | null>(null);
  const [objectDialog, setObjectDialog] = useState<"files" | "stat" | null>(null);
  const [objectDialogMaximized, setObjectDialogMaximized] = useState(false);
  const [objectPrefix, setObjectPrefix] = useState("");
  const [objectFilter, setObjectFilter] = useState("");
  const [selectedObjectKeys, setSelectedObjectKeys] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<OssDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [objectTransfer, setObjectTransfer] = useState<{ kind: "upload" | "download"; key: string } | null>(null);
  const [objectTransferMessage, setObjectTransferMessage] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [cnameDialog, setCnameDialog] = useState(false);
  const [cnameValue, setCnameValue] = useState("");
  const [cnameToken, setCnameToken] = useState<Record<string, string> | null>(null);
  const [cnameLoading, setCnameLoading] = useState(false);
  const bucketName = String(item.Name || "");
  const location = String(item.Location || "");
  const isTencent = account.cloud_type === "tencent";
  const isVolcengine = account.cloud_type === "volcengine";
  const isCtyun = account.cloud_type === "ctyun";
  const isHuawei = account.cloud_type === "huawei";
  const isBaidu = account.cloud_type === "baidu";
  const supportsObjectTransfer = account.cloud_type === "aliyun";
  const isReadOnlyBucketProvider = ["volcengine", "ctyun", "huawei", "baidu", "ucloud", "qiniu", "aws", "azure", "gcp", "jdcloud", "qingcloud", "ksyun"].includes(account.cloud_type);
  const endpoint = String(item.ExtranetEndpoint || (bucketName && location ? (isTencent ? `${bucketName}.cos.${location}.myqcloud.com` : isVolcengine ? `${bucketName}.tos-${location}.volces.com` : isCtyun || isHuawei || isBaidu ? "-" : `${bucketName}.${location}.aliyuncs.com`) : "-"));
  const intranetEndpoint = String(item.IntranetEndpoint || (bucketName && location && !isTencent && !isVolcengine && !isCtyun && !isHuawei && !isBaidu ? `${bucketName}.${location}-internal.aliyuncs.com` : "-"));
  const storageClassNames: Record<string, string> = { Standard: "标准存储", IA: "低频访问", Archive: "归档存储", ColdArchive: "冷归档存储", DeepColdArchive: "深度冷归档" };
  async function fetchDetail() {
    if (!runningInTauri) return webApi<OssDetail>(`/api/oss-detail?id=${account.id}&bucket=${encodeURIComponent(bucketName)}&location=${encodeURIComponent(location)}`);
    try {
      const acl = await invoke<string>("get_oss_acl", { id: account.id, bucket: bucketName, location });
      return { storage: 0, objectCount: 0, multipartUploadCount: 0, liveChannelCount: 0, monthTraffic: 0, monthRequests: 0, acl, cnames: [], cors: [], errors: [] };
    } catch (error) {
      return { storage: 0, objectCount: 0, multipartUploadCount: 0, liveChannelCount: 0, monthTraffic: 0, monthRequests: 0, acl: String(item.Acl || "private"), cnames: [], cors: [], errors: [`存储桶详情读取失败：${String(error)}`] };
    }
  }
  async function loadDetail() {
    if (isReadOnlyBucketProvider) {
      setDetail(null);
      setDetailLoading(false);
      setError(`${cloudProvider(account.cloud_type).label}当前支持存储桶清单，对象浏览和桶配置暂未接入。`);
      return;
    }
    setDetailLoading(true);
    try {
      const value = await fetchDetail();
      setDetail(value);
      if (value.errors.length) setError(value.errors.join("；"));
    } catch (reason) {
      setDetail(null);
      setError(String(reason));
    } finally {
      setDetailLoading(false);
    }
  }
  async function loadObjects(kind: "files" | "stat", prefix = objectPrefix, marker = "") {
    if (isReadOnlyBucketProvider) {
      setError(`${cloudProvider(account.cloud_type).label}当前仅支持存储桶清单。`);
      return;
    }
    if (kind === "stat") {
      setObjectDialog("stat");
      if (!detail && !detailLoading) await loadDetail();
      return;
    }
    setObjectsLoading(true);
    setObjectDialog("files");
    try {
      setError("");
      const listing = runningInTauri
        ? await invoke<OssObjectListing>("list_oss_objects", { id: account.id, bucket: bucketName, location, prefix, marker })
        : await webApi<OssObjectListing>(
            `/api/oss-objects?id=${account.id}&bucket=${encodeURIComponent(bucketName)}&location=${encodeURIComponent(location)}&prefix=${encodeURIComponent(prefix)}&marker=${encodeURIComponent(marker)}`,
          );
      setObjectListing(marker && objectListing ? {
        ...listing,
        objects: [...objectListing.objects, ...listing.objects],
        prefixes: [...objectListing.prefixes, ...listing.prefixes],
      } : listing);
      setObjectPrefix(prefix);
      setObjectFilter("");
      setSelectedObjectKeys(new Set());
    } catch (reason) {
      setObjectListing(null);
      setError(String(reason));
    } finally {
      setObjectsLoading(false);
    }
  }
  useEffect(() => {
    if (isReadOnlyBucketProvider) {
      setDetailLoading(false);
      setError(`${cloudProvider(account.cloud_type).label}当前支持存储桶清单，对象浏览和桶配置暂未接入。`);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const value = await fetchDetail();
        if (!cancelled) {
          setDetail(value);
          if (value.errors.length) setError(value.errors.join("；"));
        }
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [account.id, bucketName, location, isReadOnlyBucketProvider]);
  useEffect(() => {
    if (!quickAction) return;
    if (quickAction === "files") void loadObjects("files", "");
    else void loadObjects("stat");
    onQuickActionOpened?.();
    // The parent clears quickAction after this one-shot request is consumed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickAction]);
  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setNotice("域名已复制");
    } catch {
      setNotice("复制失败，请手动复制");
    }
  }
  async function setPublicRead() {
    if (!(await onConfirm(`确定要将存储桶【${bucketName}】设置为公共读吗？\n公共读权限允许任何人读取存储桶中的文件。`))) return;
    try {
      if (runningInTauri) await invoke("set_oss_public_read", { id: account.id, bucket: bucketName, location });
      else await webApi(`/api/oss-public-read?id=${account.id}&bucket=${encodeURIComponent(bucketName)}&location=${encodeURIComponent(location)}`, { method: "POST" });
      setNotice("已设置为公共读");
      await loadDetail();
    } catch (reason) {
      setNotice(`设置失败：${String(reason)}`);
    }
  }
  async function setCors() {
    const origins = await onPrompt("允许来源（输入 * 表示允许所有来源）", "*");
    if (origins === null) return;
    try {
      if (runningInTauri) await invoke("set_oss_cors", { id: account.id, bucket: bucketName, location, origins });
      else await webApi(`/api/oss-cors?id=${account.id}&bucket=${encodeURIComponent(bucketName)}&location=${encodeURIComponent(location)}&origins=${encodeURIComponent(origins)}`, { method: "POST" });
      setNotice("CORS 配置已保存");
      await loadDetail();
    } catch (reason) { setNotice(`CORS 设置失败：${String(reason)}`); }
  }
  async function createCnameToken() {
    if (runningInTauri) { setNotice("桌面客户端暂未接入 OSS 自定义域名配置，请使用 Web API 模式操作"); return; }
    setCnameLoading(true);
    try {
      const result = await webApi<Record<string, string>>(`/api/oss-cname-token?id=${account.id}&bucket=${encodeURIComponent(bucketName)}&location=${encodeURIComponent(location)}&domain=${encodeURIComponent(cnameValue)}`, { method: "POST" });
      setCnameToken(result);
      setNotice("验证 Token 已生成，请按弹窗提示配置 TXT 记录");
    } catch (reason) { setNotice(`获取 Token 失败：${String(reason)}`); } finally { setCnameLoading(false); }
  }
  async function bindCname() {
    if (runningInTauri) { setNotice("桌面客户端暂未接入 OSS 自定义域名配置，请使用 Web API 模式操作"); return; }
    setCnameLoading(true);
    try {
      await webApi(`/api/oss-cname?id=${account.id}&bucket=${encodeURIComponent(bucketName)}&location=${encodeURIComponent(location)}&domain=${encodeURIComponent(cnameValue)}`, { method: "POST" });
      setNotice("域名已绑定，请按提示添加 CNAME 解析");
      await loadDetail();
    } catch (reason) { setNotice(`绑定失败：${String(reason)}`); } finally { setCnameLoading(false); }
  }
  async function deleteCname(domain: string) {
    if (!(await onConfirm(`确定删除自定义域名【${domain}】吗？`))) return;
    if (runningInTauri) { setNotice("桌面客户端暂未接入 OSS 自定义域名配置，请使用 Web API 模式操作"); return; }
    try {
      await webApi(`/api/oss-cname?id=${account.id}&bucket=${encodeURIComponent(bucketName)}&location=${encodeURIComponent(location)}&domain=${encodeURIComponent(domain)}`, { method: "DELETE" });
      setNotice("自定义域名已删除");
      await loadDetail();
    } catch (reason) { setNotice(`删除失败：${String(reason)}`); }
  }
  const acl = detail?.acl || String(item.Acl || "private");
  const cnameHost = cnameValue.split(".").length > 2 ? cnameValue.split(".")[0] : "@";
  const tokenHost = cnameValue.split(".").length > 2 ? `_dnsauth.${cnameValue.split(".")[0]}` : "_dnsauth";
  const filterText = objectFilter.trim().toLocaleLowerCase();
  const folderRows = (objectListing?.prefixes || [])
    .map((prefix) => ({ key: prefix, name: prefix.slice(objectPrefix.length).replace(/\/$/, ""), prefix }))
    .filter((folder) => !filterText || folder.name.toLocaleLowerCase().includes(filterText));
  const fileRows = (objectListing?.objects || [])
    .map((object) => ({ ...object, name: object.Key.slice(objectPrefix.length) }))
    .filter((object) => !filterText || object.name.toLocaleLowerCase().includes(filterText));
  const selectableKeys = [...folderRows.map((folder) => folder.key), ...fileRows.map((object) => object.Key)];
  const selectedFileKeys = fileRows.map((object) => object.Key).filter((key) => selectedObjectKeys.has(key));
  const allVisibleSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selectedObjectKeys.has(key));
  const pathSegments = objectPrefix ? objectPrefix.replace(/\/$/, "").split("/") : [];
  const parentPrefix = pathSegments.length ? `${pathSegments.slice(0, -1).join("/")}${pathSegments.length > 1 ? "/" : ""}` : "";
  function toggleObjectSelection(key: string) {
    setSelectedObjectKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function toggleAllVisibleObjects() {
    setSelectedObjectKeys((current) => {
      const next = new Set(current);
      if (allVisibleSelected) selectableKeys.forEach((key) => next.delete(key));
      else selectableKeys.forEach((key) => next.add(key));
      return next;
    });
  }
  async function copyObjectPaths() {
    if (!selectedObjectKeys.size) return;
    try {
      await navigator.clipboard.writeText([...selectedObjectKeys].sort().join("\n"));
      setNotice(`已复制 ${selectedObjectKeys.size} 个对象路径`);
    } catch {
      setNotice("复制失败，请手动复制对象路径");
    }
  }
  async function uploadSelection(selection: OssUploadSelection): Promise<boolean> {
    const objectKey = `${objectPrefix}${selection.name}`;
    const exists = objectListing?.objects.some((object) => object.Key === objectKey) ?? false;
    const overwrite = exists ? await onConfirm(`对象【${objectKey}】已经存在。\n继续上传将覆盖原文件，确定继续吗？`) : false;
    if (exists && !overwrite) {
      await invoke("discard_oss_upload_selection", { selectionToken: selection.token });
      return false;
    }
    setObjectTransfer({ kind: "upload", key: objectKey });
    setObjectTransferMessage(`正在上传 ${selection.name}（${formatBytes(selection.size)}）…`);
    await invoke("upload_oss_object", { id: account.id, bucket: bucketName, location, objectKey, selectionToken: selection.token, overwrite });
    return true;
  }
  async function uploadObject() {
    if (!supportsObjectTransfer) { setObjectTransferMessage("当前仅支持阿里云 OSS 文件上传与下载"); return; }
    if (!runningInTauri) { setObjectTransferMessage("上传文件仅支持桌面客户端"); return; }
    try {
      setError("");
      setObjectTransfer({ kind: "upload", key: "" });
      setObjectTransferMessage("请选择要上传的本机文件…");
      const selection = await invoke<OssUploadSelection | null>("select_oss_upload_file", {});
      if (!selection) { setObjectTransferMessage("已取消上传"); return; }
      if (await uploadSelection(selection)) {
        setObjectTransferMessage(`已上传到 oss://${bucketName}/${objectPrefix}${selection.name}`);
        await loadObjects("files", objectPrefix);
      } else setObjectTransferMessage("已取消上传");
    } catch (reason) {
      setError(`上传失败：${String(reason)}`);
      setObjectTransferMessage("上传未完成，请根据错误提示重试");
    } finally { setObjectTransfer(null); }
  }
  async function uploadDroppedObjects(paths: string[]) {
    if (!supportsObjectTransfer || !runningInTauri || objectTransfer || !paths.length) return;
    const uniquePaths = [...new Set(paths)].slice(0, 20);
    setIsDragOver(false);
    setObjectTransfer({ kind: "upload", key: "" });
    setObjectTransferMessage(`已接收 ${uniquePaths.length} 个文件，准备上传…`);
    try {
      setError("");
      let uploaded = 0;
      for (const sourcePath of uniquePaths) {
        const selection = await invoke<OssUploadSelection>("stage_oss_upload_file", { sourcePath });
        if (await uploadSelection(selection)) uploaded += 1;
      }
      setObjectTransferMessage(uploaded ? `已上传 ${uploaded} 个文件` : "已取消上传");
      if (uploaded) await loadObjects("files", objectPrefix);
    } catch (reason) {
      setError(`拖拽上传失败：${String(reason)}`);
      setObjectTransferMessage("部分文件可能未完成，请根据错误提示重试");
    } finally { setObjectTransfer(null); }
  }
  useEffect(() => {
    if (!runningInTauri || objectDialog !== "files" || !supportsObjectTransfer) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") setIsDragOver(true);
      else if (event.payload.type === "drop") void uploadDroppedObjects(event.payload.paths);
      else setIsDragOver(false);
    }).then((dispose) => { unlisten = dispose; }).catch(() => {});
    return () => { unlisten?.(); setIsDragOver(false); };
    // The listener follows the current directory so dropped files use its prefix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectDialog, objectPrefix, supportsObjectTransfer, objectTransfer]);
  async function downloadObject(object: OssObject & { name: string }) {
    if (!supportsObjectTransfer) {
      setObjectTransferMessage("当前仅支持阿里云 OSS 文件上传与下载");
      return;
    }
    if (!runningInTauri) {
      setObjectTransferMessage("下载文件仅支持桌面客户端");
      return;
    }
    setObjectTransfer({ kind: "download", key: object.Key });
    setObjectTransferMessage(`请选择 ${object.name} 的下载位置…`);
    setError("");
    try {
      const target = await invoke<string | null>("download_oss_object", { id: account.id, bucket: bucketName, location, objectKey: object.Key });
      setObjectTransferMessage(target ? `下载完成：${target}` : "已取消下载");
    } catch (reason) {
      setError(`下载失败：${String(reason)}`);
      setObjectTransferMessage("下载未完成，请根据错误提示重试");
    } finally {
      setObjectTransfer(null);
    }
  }
  async function getObjectUrl(object: OssObject & { name: string }) {
    if (!supportsObjectTransfer || !runningInTauri) { setObjectTransferMessage("在线查看和 URL 复制仅支持桌面客户端的阿里云 OSS"); return null; }
    return invoke<string>("get_oss_object_url", { id: account.id, bucket: bucketName, location, objectKey: object.Key });
  }
  async function viewObject(object: OssObject & { name: string }) {
    try {
      setError("");
      const url = await getObjectUrl(object);
      if (!url) return;
      await openUrl(url);
      setObjectTransferMessage(`已打开在线查看：${object.name}`);
    } catch (reason) { setError(`在线查看失败：${String(reason)}`); }
  }
  async function copyObjectUrl(object: OssObject & { name: string }) {
    try {
      setError("");
      const url = await getObjectUrl(object);
      if (!url) return;
      await navigator.clipboard.writeText(url);
      setObjectTransferMessage(`URL 已复制：${object.name}`);
    } catch (reason) { setError(`复制 URL 失败：${String(reason)}`); }
  }
  async function downloadSelectedObjects() {
    if (!selectedFileKeys.length || objectTransfer) return;
    if (!supportsObjectTransfer) { setObjectTransferMessage("当前仅支持阿里云 OSS 文件上传与下载"); return; }
    if (!runningInTauri) { setObjectTransferMessage("下载文件仅支持桌面客户端"); return; }
    if (!(await onConfirm(`将下载当前目录中选中的 ${selectedFileKeys.length} 个文件。\n下载时请选择保存目录，若存在同名文件会被替换，确定继续吗？`))) return;
    setObjectTransfer({ kind: "download", key: "*" });
    setObjectTransferMessage(`正在准备下载 ${selectedFileKeys.length} 个文件，请选择保存目录…`);
    setError("");
    try {
      const targets = await invoke<string[] | null>("download_oss_objects", { id: account.id, bucket: bucketName, location, objectKeys: selectedFileKeys });
      setObjectTransferMessage(targets ? `已下载 ${targets.length} 个文件` : "已取消批量下载");
    } catch (reason) {
      setError(`批量下载失败：${String(reason)}`);
      setObjectTransferMessage("批量下载未完成，请根据错误提示重试");
    } finally { setObjectTransfer(null); }
  }
  return (
    <article className="bucket-card">
      <div className="bucket-header">
        <strong>🪣 {displayValue(item.Name)}</strong>
        <span className="bucket-acl">{acl === "public-read-write" ? "公共读写" : acl === "public-read" ? "公共读" : "私有"}</span>
      </div>
      <div className="bucket-info">
        <div>
          <span>存储桶名称：</span>
          {displayValue(item.Name)}
        </div>
        <div>
          <span>地域：</span>
          {displayValue(item.Location)}
        </div>
        <div>
          <span>创建时间：</span>
          {displayValue(item.CreationDate)}
        </div>
        <div>
          <span>存储类型：</span>
          {storageClassNames[String(item.StorageClass || "Standard")] || displayValue(item.StorageClass)}
        </div>
        <div>
          <span>外网域名：</span>
          {endpoint}
        </div>
        <div>
          <span>内网域名：</span>
          {intranetEndpoint}
        </div>
      </div>
      <div className="bucket-detail-box">
        {isReadOnlyBucketProvider ? <span>{cloudProvider(account.cloud_type).label}当前仅同步存储桶清单。</span> : detailLoading ? <span className="bucket-detail-loading"><RefreshCw className="spin" size={13} /> 正在读取存储桶详情…</span> : <>
          <span>存储容量：{formatBytes(detail?.storage)}</span>
          <span>文件数量：{detail?.objectCount || 0} 个</span>
          <span>当月流量：{formatBytes(detail?.monthTraffic)}</span>
          <span>当月请求：{detail?.monthRequests || 0} 次</span>
          <span>自定义域名：{detail?.cnames?.length ? detail.cnames.map((cname) => <button className="bucket-cname" key={cname.Domain} title="删除此自定义域名" onClick={() => void deleteCname(cname.Domain)}>{cname.Domain}<X size={12} /></button>) : "未绑定"}</span>
          <span>CORS 配置：{detail?.cors?.length ? detail.cors.map((rule, index) => <i className="bucket-cors" key={index} title={`来源：${rule.origin.join(", ")}\n方法：${rule.method.join(", ")}\nHeader：${rule.header.join(", ")}`}>{rule.origin.join(", ") || "*"}</i>) : "未配置"}</span>
        </>}
      </div>
      {!isVolcengine && !isCtyun && <div className="bucket-actions">
        <button
          className="layui-btn layui-btn-xs layui-btn-normal"
          disabled={objectsLoading}
          onClick={() => void loadObjects("files")}
        >
          <RefreshCw className={objectsLoading ? "spin" : undefined} size={13} />
          {objectsLoading ? "读取中…" : "文件列表"}
        </button>
        <button
          className="layui-btn layui-btn-xs"
          disabled={objectsLoading}
          onClick={() => void loadObjects("stat")}
        >
          <RefreshCw className={objectsLoading ? "spin" : undefined} size={13} />
          {objectsLoading ? "读取中…" : "容量统计"}
        </button>
        {!isTencent && <button className="layui-btn layui-btn-xs layui-btn-warm" onClick={() => void setPublicRead()}>设置公共读</button>}
        {!isTencent && <button className="layui-btn layui-btn-xs layui-btn-danger" onClick={() => void setCors()}>设置跨域</button>}
        {!isTencent && <button className="layui-btn layui-btn-xs bucket-cname-btn" onClick={() => { setCnameDialog(true); setCnameToken(null); }}>添加域名</button>}
        <button className="layui-btn layui-btn-xs layui-btn-primary" onClick={() => void copyEndpoint()}>复制域名</button>
      </div>}
      {notice && <div className="bucket-notice">{notice}</div>}
      {error && <div className="bucket-inline-error">{error}</div>}
      {objectDialog && (
        <div className="resource-modal-backdrop nested-resource-modal" onClick={() => { setObjectDialog(null); setObjectDialogMaximized(false); }}>
          <section className={`detail-panel resource-modal oss-object-dialog${objectDialogMaximized ? " is-maximized" : ""}`} onClick={(event) => event.stopPropagation()}>
            <div className="detail-toolbar">
              <div><span className="eyebrow">{bucketName}</span><h2>{objectDialog === "files" ? "文件列表" : "容量统计"}</h2></div>
              <div className="detail-toolbar-actions">
                <button
                  className="secondary"
                  title={objectDialogMaximized ? "还原窗口" : "放大到全屏"}
                  onClick={() => setObjectDialogMaximized((value) => !value)}
                >
                  {objectDialogMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  {objectDialogMaximized ? "还原" : "放大"}
                </button>
                <button className="close-detail" aria-label="关闭文件列表" title="关闭" onClick={() => { setObjectDialog(null); setObjectDialogMaximized(false); }}><X size={20} /></button>
              </div>
            </div>
            {error && <div className="error-list">{error}</div>}
            {objectDialog === "stat" ? (
              <div className="oss-stat-grid">
                <div><span>存储桶</span><strong>{bucketName}</strong></div>
                <div><span>文件数量</span><strong>{detail?.objectCount || 0} 个</strong></div>
                <div><span>存储容量</span><strong>{formatBytes(detail?.storage)}</strong></div>
                <div><span>分片数量</span><strong>{detail?.multipartUploadCount || 0} 个</strong></div>
                <div><span>活跃直播通道</span><strong>{detail?.liveChannelCount || 0} 个</strong></div>
              </div>
            ) : (
              <div className="oss-browser">
                <div className="oss-browser-pathbar">
                  <div className="oss-browser-nav" aria-label="目录导航">
                    <button title="向上一级" disabled={!objectPrefix || objectsLoading} onClick={() => void loadObjects("files", parentPrefix)}><ArrowUp size={16} /></button>
                    <button title="返回存储桶根目录" disabled={!objectPrefix || objectsLoading} onClick={() => void loadObjects("files", "")}><Home size={16} /></button>
                    <button title="刷新当前目录" disabled={objectsLoading} onClick={() => void loadObjects("files", objectPrefix)}><RefreshCw className={objectsLoading ? "spin" : undefined} size={16} /></button>
                  </div>
                  <div className="oss-browser-address" title={`oss://${bucketName}/${objectPrefix}`}><span>oss://{bucketName}/</span>{pathSegments.map((segment, index) => <button key={`${segment}-${index}`} onClick={() => void loadObjects("files", `${pathSegments.slice(0, index + 1).join("/")}/`)}>{segment}/</button>)}</div>
                  <label className="oss-browser-search"><Search size={15} /><input value={objectFilter} onChange={(event) => setObjectFilter(event.target.value)} placeholder="按名称筛选" /></label>
                </div>
                {supportsObjectTransfer && <div className={`oss-drop-zone${isDragOver ? " is-drag-over" : ""}`} aria-label="拖拽文件上传区域"><Upload size={16} /><span>{isDragOver ? "松开鼠标以上传文件" : "支持将文件拖拽到这里上传，也可点击“上传文件”选择"}</span></div>}
                <div className="oss-browser-actions">
                  <button className="oss-browser-command oss-upload-command" disabled={!supportsObjectTransfer || Boolean(objectTransfer) || objectsLoading} title={!supportsObjectTransfer ? "当前仅支持阿里云 OSS 文件上传" : runningInTauri ? `上传到 oss://${bucketName}/${objectPrefix}` : "仅桌面客户端支持上传"} onClick={() => void uploadObject()}><Upload size={15} />{objectTransfer?.kind === "upload" ? "上传中…" : "上传文件"}</button>
                  <button className="oss-browser-command oss-batch-download-command" disabled={!supportsObjectTransfer || !selectedFileKeys.length || Boolean(objectTransfer)} title={selectedFileKeys.length ? `批量下载选中的 ${selectedFileKeys.length} 个文件` : "先勾选文件"} onClick={() => void downloadSelectedObjects()}><Download size={15} />批量下载{selectedFileKeys.length ? ` (${selectedFileKeys.length})` : ""}</button>
                  <button className="oss-browser-command" disabled={!selectedObjectKeys.size} onClick={() => void copyObjectPaths()}><Copy size={15} />复制路径{selectedObjectKeys.size ? ` (${selectedObjectKeys.size})` : ""}</button>
                  <button className="oss-browser-icon" title={allVisibleSelected ? "取消全选" : "全选当前目录"} disabled={!selectableKeys.length} onClick={toggleAllVisibleObjects}>{allVisibleSelected ? <CheckSquare size={17} /> : <Square size={17} />}</button>
                  <span>{objectListing ? `${folderRows.length} 个目录，${fileRows.length} 个文件` : "正在读取目录..."}</span>
                </div>
                {(objectTransferMessage || !supportsObjectTransfer) && <div className={`oss-transfer-status${objectTransfer ? " is-active" : ""}`} role="status" aria-live="polite">{objectTransfer && <RefreshCw className="spin" size={14} />}{objectTransferMessage || "当前云厂商暂只支持对象浏览；文件上传与下载已在阿里云 OSS 可用。"}</div>}
                <div className="resource-table-wrap oss-object-table">
                  {objectsLoading && !objectListing ? <div className="detail-empty"><RefreshCw className="spin" size={17} />正在读取目录...</div> : folderRows.length || fileRows.length ? <table><thead><tr><th className="oss-object-check"><input aria-label="全选" type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisibleObjects} /></th><th>名称</th><th>类型 / 大小</th><th>最后修改时间</th><th>ETag</th><th className="oss-object-operation">操作</th></tr></thead><tbody>
                    {folderRows.map((folder) => <tr className="oss-folder-row" key={folder.key}><td className="oss-object-check"><input aria-label={`选择目录 ${folder.name}`} type="checkbox" checked={selectedObjectKeys.has(folder.key)} onChange={() => toggleObjectSelection(folder.key)} /></td><td><button className="oss-object-name" title={`打开 ${folder.name}`} onClick={() => void loadObjects("files", folder.prefix)}><Folder size={17} />{folder.name}</button></td><td><span className="oss-object-kind">目录</span></td><td>-</td><td>-</td><td className="oss-object-operation">-</td></tr>)}
                    {fileRows.map((object) => <tr key={object.Key}><td className="oss-object-check"><input aria-label={`选择文件 ${object.name}`} type="checkbox" checked={selectedObjectKeys.has(object.Key)} onChange={() => toggleObjectSelection(object.Key)} /></td><td><span className="oss-object-file" title={object.name}><File size={16} />{object.name}</span></td><td>{formatBytes(object.Size)}</td><td>{formatCloudDate(object.LastModified)}</td><td><code title={object.ETag}>{object.ETag || "-"}</code></td><td className="oss-object-operation"><div className="oss-object-actions">{isViewableObject(object.name) && <button className="oss-object-action" disabled={!supportsObjectTransfer || Boolean(objectTransfer)} title={`在线查看 ${object.name}`} aria-label={`在线查看 ${object.name}`} onClick={() => void viewObject(object)}><Eye size={14} /></button>}<button className="oss-object-action" disabled={!supportsObjectTransfer || Boolean(objectTransfer)} title={`复制 ${object.name} 的临时 URL`} aria-label={`复制 ${object.name} 的临时 URL`} onClick={() => void copyObjectUrl(object)}><Link2 size={14} /></button><button className="oss-download-button" disabled={!supportsObjectTransfer || Boolean(objectTransfer)} title={supportsObjectTransfer ? `下载 ${object.name} 并指定保存位置` : "当前仅支持阿里云 OSS 文件下载"} onClick={() => void downloadObject(object)}>{objectTransfer?.kind === "download" && objectTransfer.key === object.Key ? <RefreshCw className="spin" size={14} /> : <Download size={14} />}下载</button></div></td></tr>)}
                  </tbody></table> : <div className="detail-empty">{error || (objectFilter ? "没有符合筛选条件的对象" : "此目录暂无对象")}</div>}
                  {objectListing?.isTruncated && objectListing.nextMarker && <div className="oss-browser-more"><button className="secondary" disabled={objectsLoading} onClick={() => void loadObjects("files", objectPrefix, objectListing.nextMarker)}>{objectsLoading ? "读取中..." : "加载更多"}</button></div>}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
      {cnameDialog && (
        <div className="resource-modal-backdrop nested-resource-modal" onClick={() => setCnameDialog(false)}>
          <section className="detail-panel resource-modal oss-cname-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="detail-toolbar"><div><span className="eyebrow">{bucketName}</span><h2>添加自定义域名</h2></div><button className="close-detail" onClick={() => setCnameDialog(false)}><X size={20} /></button></div>
            <label className="oss-cname-input"><span>域名</span><input value={cnameValue} onChange={(event) => { setCnameValue(event.target.value.trim()); setCnameToken(null); }} placeholder="例如 img.example.com" /></label>
            <div className="oss-cname-steps"><p>1. 获取验证 Token。</p><p>2. 在 DNS 服务商添加 TXT 记录验证域名。</p><p>3. DNS 生效后绑定域名，再添加 CNAME 记录。</p></div>
            {cnameToken && <div className="oss-cname-records"><strong>TXT 验证记录</strong><div><span>类型</span><code>TXT</code></div><div><span>主机记录</span><code>{tokenHost}</code></div><div><span>记录值</span><code>{cnameToken.token || "未返回 Token"}</code></div><strong>CNAME 解析记录</strong><div><span>类型</span><code>CNAME</code></div><div><span>主机记录</span><code>{cnameHost}</code></div><div><span>记录值</span><code>{endpoint}</code></div></div>}
            <div className="oss-cname-actions"><button className="layui-btn layui-btn-primary" disabled={!cnameValue || cnameLoading} onClick={() => void createCnameToken()}>{cnameLoading ? "处理中…" : "获取验证 Token"}</button><button className="layui-btn" disabled={!cnameValue || cnameLoading} onClick={() => void bindCname()}>绑定域名</button></div>
          </section>
        </div>
      )}
    </article>
  );
}
