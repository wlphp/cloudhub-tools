import { type PointerEvent, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "../../platform/api";
import type { SshDirectoryListing, SshFileEntry } from "../../shared/types";

type FileEditor = { path: string; content: string } | null;

type UseSshFilesOptions = {
  sessionId: string;
  requestConfirm: (message: string) => Promise<boolean>;
  requestPrompt: (message: string, initialValue?: string) => Promise<string | null>;
  notify: (message: string) => void;
};

export function useSshFiles({ sessionId, requestConfirm, requestPrompt, notify }: UseSshFilesOptions) {
  const [files, setFiles] = useState<SshFileEntry[]>([]);
  const [path, setPath] = useState("/");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<FileEditor>(null);
  const [saving, setSaving] = useState(false);
  const [paneWidth, setPaneWidth] = useState(520);
  const [paneCollapsed, setPaneCollapsed] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  function joinPath(parent: string, name: string) {
    return parent === "/" ? `/${name}` : `${parent.replace(/\/+$/, "")}/${name}`;
  }

  function parentPath(value: string) {
    const normalized = value.replace(/\/+$/, "") || "/";
    if (normalized === "/") return "/";
    const parent = normalized.slice(0, normalized.lastIndexOf("/"));
    return parent || "/";
  }

  function fileSize(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function loadFiles(nextPath = path) {
    if (!sessionId) return;
    setLoading(true);
    setError("");
    try {
      const result = await invoke<SshDirectoryListing>("ssh_list_files", { sessionId, path: nextPath });
      setPath(result.path);
      setFiles(result.entries.sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name)));
    } catch (cause) { setError(`读取远程目录失败：${String(cause)}`); }
    finally { setLoading(false); }
  }

  function startResize(event: PointerEvent<HTMLDivElement>) {
    const workspace = workspaceRef.current;
    if (!workspace || window.innerWidth <= 900) return;
    event.preventDefault();
    const initialX = event.clientX;
    const initialWidth = paneWidth;
    const maxWidth = Math.max(360, workspace.clientWidth - 360);
    const resize = (moveEvent: globalThis.PointerEvent) => setPaneWidth(Math.min(maxWidth, Math.max(360, initialWidth - (moveEvent.clientX - initialX))));
    const finish = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      document.body.classList.remove("ssh-resizing");
    };
    document.body.classList.add("ssh-resizing");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
  }

  async function openFile(entry: SshFileEntry) {
    if (entry.isDir) { await loadFiles(entry.path); return; }
    if (!entry.isFile) { setError("暂不支持打开该类型的远程条目"); return; }
    setError("");
    try { setEditor({ path: entry.path, content: await invoke<string>("ssh_read_text_file", { sessionId, path: entry.path }) }); }
    catch (cause) { setError(`打开文件失败：${String(cause)}`); }
  }

  async function saveFile() {
    if (!editor || !sessionId) return;
    setSaving(true);
    setError("");
    try {
      await invoke("ssh_write_text_file", { sessionId, path: editor.path, content: editor.content });
      notify(`已保存远程文件：${editor.path}`);
    } catch (cause) { setError(`保存文件失败：${String(cause)}`); }
    finally { setSaving(false); }
  }

  async function uploadFiles(pending: Iterable<globalThis.File>) {
    if (!sessionId) return;
    const pendingFiles = Array.from(pending);
    if (!pendingFiles.length) return;
    const oversized = pendingFiles.find((file) => file.size > 20 * 1024 * 1024);
    if (oversized) { setError(`“${oversized.name}”超过单文件 20 MB 上传限制`); return; }
    const existingFiles = pendingFiles.filter((file) => files.some((entry) => entry.name === file.name));
    if (existingFiles.length && !(await requestConfirm(`“${existingFiles.map((file) => file.name).join("、")}”已存在，确定覆盖吗？`))) return;
    setLoading(true);
    setError("");
    try {
      for (const file of pendingFiles) {
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
          reader.onerror = () => reject(new Error("读取本地文件失败"));
          reader.readAsDataURL(file);
        });
        await invoke("ssh_upload_file", { sessionId, path: joinPath(path, file.name), contentBase64 });
      }
      await loadFiles();
      notify(`已上传 ${pendingFiles.length} 个文件`);
    } catch (cause) { setError(`上传文件失败：${String(cause)}`); }
    finally { setLoading(false); }
  }

  async function downloadFile(entry: SshFileEntry) {
    if (!sessionId || !entry.isFile) return;
    setError("");
    try {
      const localPath = await invoke<string>("ssh_download_file", { sessionId, path: entry.path });
      await revealItemInDir(localPath);
      notify(`已下载并在本机定位：${localPath}`);
    } catch (cause) { setError(`下载文件失败：${String(cause)}`); }
  }

  async function makeDirectory() {
    if (!sessionId) return;
    const name = await requestPrompt("新建文件夹名称");
    if (!name?.trim() || /[\\/\0]/.test(name)) { if (name) setError("文件夹名称不能包含 / 或 \\ "); return; }
    try { await invoke("ssh_make_directory", { sessionId, path: joinPath(path, name.trim()) }); await loadFiles(); }
    catch (cause) { setError(`新建文件夹失败：${String(cause)}`); }
  }

  async function deleteEntry(entry: SshFileEntry) {
    if (!sessionId || !(await requestConfirm(`确定删除${entry.isDir ? "文件夹及其全部内容" : "文件"}“${entry.name}”？此操作不可恢复。`))) return;
    try {
      await invoke("ssh_delete_path", { sessionId, path: entry.path });
      if (editor?.path === entry.path) setEditor(null);
      await loadFiles();
    } catch (cause) { setError(`删除失败：${String(cause)}`); }
  }

  function reset() {
    setFiles([]);
    setPath("/");
    setError("");
    setEditor(null);
    setPaneCollapsed(false);
    setDragActive(false);
  }

  return { files, setFiles, path, setPath, loading, error, editor, setEditor, saving, paneWidth, paneCollapsed, setPaneCollapsed, dragActive, setDragActive, uploadInputRef, workspaceRef, joinPath, parentPath, fileSize, loadFiles, startResize, openFile, saveFile, uploadFiles, downloadFile, makeDirectory, deleteEntry, reset };
}
