import type { PointerEvent, RefObject } from "react";
import { ChevronLeft, Download, FileCode2, FolderOpen, FolderPlus, PanelRightClose, RefreshCw, Save, Trash2, Upload, X } from "lucide-react";
import type { SshFileEntry } from "../../shared/types";

export type RemoteFileManagerProps = {
  dragActive: boolean;
  files: SshFileEntry[];
  path: string;
  loading: boolean;
  error: string;
  editor: { path: string; content: string } | null;
  saving: boolean;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  onResize?: (event: PointerEvent<HTMLDivElement>) => void;
  onDragActiveChange: (value: boolean) => void;
  onLoad: (path?: string) => void;
  onPathChange: (value: string) => void;
  onUpload: (files: FileList) => void;
  onMakeDirectory: () => void;
  onOpen: (entry: SshFileEntry) => void;
  onDownload: (entry: SshFileEntry) => void;
  onDelete: (entry: SshFileEntry) => void;
  onCloseEditor: () => void;
  onContentChange: (value: string) => void;
  onSave: () => void;
  fileSize: (size: number) => string;
  parentPath: (path: string) => string;
  onCollapse?: () => void;
};

export function RemoteFileManager({
  dragActive,
  files,
  path,
  loading,
  error,
  editor,
  saving,
  uploadInputRef,
  onResize,
  onDragActiveChange,
  onLoad,
  onPathChange,
  onUpload,
  onMakeDirectory,
  onOpen,
  onDownload,
  onDelete,
  onCloseEditor,
  onContentChange,
  onSave,
  fileSize,
  parentPath,
  onCollapse,
}: RemoteFileManagerProps) {
  return <>
    {onResize && <div className="ssh-file-resizer" role="separator" aria-label="调整文件管理面板宽度" aria-orientation="vertical" onPointerDown={onResize} />}
    <aside className={`ssh-file-manager${dragActive ? " is-dragging" : ""}`} aria-label="远程文件管理" onDragEnter={(event) => { event.preventDefault(); onDragActiveChange(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) onDragActiveChange(false); }} onDrop={(event) => { event.preventDefault(); onDragActiveChange(false); onUpload(event.dataTransfer.files); }}>
      <div className="ssh-file-toolbar">
        <button type="button" title="返回上级目录" disabled={loading || path === "/"} onClick={() => onLoad(parentPath(path))}><ChevronLeft size={16} /></button>
        <input className="ssh-file-path" value={path} onChange={(event) => onPathChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onLoad(event.currentTarget.value); }} aria-label="远程目录路径" />
        <button type="button" title="刷新目录" disabled={loading} onClick={() => onLoad()}><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
        {onCollapse && <button type="button" title="收起文件管理" aria-label="收起文件管理" onClick={onCollapse}><PanelRightClose size={16} /></button>}
      </div>
      <div className="ssh-file-actions">
        <button type="button" title="上传文件" disabled={loading} onClick={() => uploadInputRef.current?.click()}><Upload size={15} />上传</button>
        <button type="button" title="新建文件夹" disabled={loading} onClick={onMakeDirectory}><FolderPlus size={15} />新建</button>
        <input ref={uploadInputRef} className="ssh-file-upload-input" type="file" multiple onChange={(event) => { const selectedFiles = event.currentTarget.files; event.currentTarget.value = ""; if (selectedFiles?.length) onUpload(selectedFiles); }} />
      </div>
      {editor ? <div className="ssh-file-editor">
        <div className="ssh-file-editor-head"><span title={editor.path}>{editor.path}</span><button type="button" title="关闭编辑器" onClick={onCloseEditor}><X size={15} /></button></div>
        <textarea value={editor.content} spellCheck={false} onChange={(event) => onContentChange(event.target.value)} />
        <div className="ssh-file-editor-actions"><button type="button" onClick={onCloseEditor}>关闭</button><button type="button" className="primary" disabled={saving} onClick={onSave}><Save size={15} />{saving ? "保存中" : "保存"}</button></div>
      </div> : <div className="ssh-file-list">
        <div className="ssh-file-list-head"><span>名称</span><span>大小</span><span>权限 / 所有者</span></div>
        {files.map((entry) => <div className="ssh-file-row" key={entry.path} onDoubleClick={() => onOpen(entry)}>
          <button type="button" className="ssh-file-name" title={`${entry.isDir ? "进入目录" : "打开文本文件"}：${entry.name}`} onClick={() => onOpen(entry)}>{entry.isDir ? <FolderOpen size={16} /> : <FileCode2 size={16} />}<span>{entry.name}</span></button>
          <span>{entry.isDir ? "文件夹" : fileSize(entry.size)}</span><span>{entry.mode}/{entry.owner}</span>
          <div className="ssh-file-row-actions">{entry.isFile && <button type="button" className="ssh-file-download" title="下载到本机并定位文件" onClick={() => onDownload(entry)}><Download size={14} /><span>下载</span></button>}<button type="button" title="删除" className="danger" onClick={() => onDelete(entry)}><Trash2 size={14} /></button></div>
        </div>)}
        {!loading && files.length === 0 && <div className="ssh-file-empty">此目录为空</div>}
        {loading && <div className="ssh-file-empty">正在读取目录…</div>}
      </div>}
      {error && <div className="ssh-file-error">{error}</div>}
    </aside>
  </>;
}
