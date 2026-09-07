import type {
  PanelConnection,
  SavedRdpConnection,
  SavedSshConnection,
  SshConnectResult,
  SshDirectoryListing,
} from "../../shared/types";
import { nativeOnly } from "./base";

export const remoteClient = {
  listPanels(): Promise<PanelConnection[]> { return nativeOnly("list_panel_connections"); },
  savePanel(input: unknown): Promise<PanelConnection> { return nativeOnly("save_panel_connection", { input }); },
  refreshPanel(id: number): Promise<PanelConnection> { return nativeOnly("refresh_panel_connection", { id }); },
  temporaryPanelLogin(id: number): Promise<string> { return nativeOnly("panel_temporary_login", { id }); },
  deletePanel(id: number): Promise<void> { return nativeOnly("delete_panel_connection", { id }); },
  updatePanelOrder(ids: number[]): Promise<void> { return nativeOnly("update_panel_connection_order", { ids }); },
  updatePanelRemark(id: number, remark: string | null): Promise<PanelConnection> { return nativeOnly("update_panel_connection_remark", { id, remark }); },
  exportPanels(panelIds?: number[]): Promise<string> { return nativeOnly("export_panel_connections_file", { panelIds }); },
  importPanels(panels: unknown[]): Promise<number> { return nativeOnly("import_panel_connections", { panels }); },

  getSshConnection(accountId: number, assetKey: string): Promise<SavedSshConnection | null> { return nativeOnly("get_ssh_connection", { accountId, assetKey }); },
  revealSshPassword(input: Record<string, unknown>): Promise<string> { return nativeOnly("reveal_ssh_password", input); },
  getRdpConnection(targetKey: string): Promise<SavedRdpConnection | null> { return nativeOnly("get_rdp_connection", { targetKey }); },
  revealRdpPassword(targetKey: string): Promise<string> { return nativeOnly("reveal_rdp_password", { targetKey }); },
  launchRdpConnection(input: unknown): Promise<void> { return nativeOnly("launch_rdp_connection", { input }); },
  launchManagedHostRdp(id: number): Promise<void> { return nativeOnly("launch_managed_host_rdp", { id }); },

  connectSsh(input: unknown): Promise<SshConnectResult> { return nativeOnly("ssh_connect", { input }); },
  testSsh(input: unknown): Promise<void> { return nativeOnly("ssh_test_connection", { input }); },
  disconnectSsh(sessionId: string): Promise<void> { return nativeOnly("ssh_disconnect", { sessionId }); },
  readSsh(sessionId: string): Promise<string> { return nativeOnly("ssh_read", { sessionId }); },
  writeSsh(sessionId: string, data: string): Promise<void> { return nativeOnly("ssh_write", { sessionId, data }); },
  resizeSsh(sessionId: string, cols: number | undefined, rows: number | undefined): Promise<void> { return nativeOnly("ssh_resize", { sessionId, cols, rows }); },
  listSshFiles(sessionId: string, path: string): Promise<SshDirectoryListing> { return nativeOnly("ssh_list_files", { sessionId, path }); },
  readSshTextFile(sessionId: string, path: string): Promise<string> { return nativeOnly("ssh_read_text_file", { sessionId, path }); },
  writeSshTextFile(sessionId: string, path: string, content: string): Promise<void> { return nativeOnly("ssh_write_text_file", { sessionId, path, content }); },
  uploadSshFile(sessionId: string, path: string, contentBase64: string): Promise<void> { return nativeOnly("ssh_upload_file", { sessionId, path, contentBase64 }); },
  downloadSshFile(sessionId: string, path: string): Promise<string> { return nativeOnly("ssh_download_file", { sessionId, path }); },
  makeSshDirectory(sessionId: string, path: string): Promise<void> { return nativeOnly("ssh_make_directory", { sessionId, path }); },
  deleteSshPath(sessionId: string, path: string): Promise<void> { return nativeOnly("ssh_delete_path", { sessionId, path }); },
};
