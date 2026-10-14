import { nativeOnly, previewOnly, jsonRequest } from "./base";

export type DatabaseImportPreview = {
  token: string;
  packageName: string;
  exportedAt: string;
  totalRecords: number;
  categories: Array<{ label: string; count: number }>;
  details: string[];
  conflicts: string[];
};

export type BrowserDatabaseImportPreview = DatabaseImportPreview;

export type DatabaseBackupRecord = { id: string; fileName: string; createdAt: string; sizeBytes: number };

export const databaseClient = {
  exportFile(): Promise<string | null> {
    return nativeOnly<string | null>("export_database_file");
  },
  prepareImport(): Promise<DatabaseImportPreview | null> {
    return nativeOnly<DatabaseImportPreview | null>("prepare_database_import");
  },
  listBackups(): Promise<DatabaseBackupRecord[]> { return nativeOnly("list_database_backups"); },
  createBackup(): Promise<DatabaseBackupRecord> { return nativeOnly("create_database_backup"); },
  importBackup(): Promise<DatabaseBackupRecord | null> { return nativeOnly("import_database_backup"); },
  downloadBackup(id: string): Promise<string | null> { return nativeOnly("download_database_backup", { id }); },
  deleteBackup(id: string): Promise<void> { return nativeOnly("delete_database_backup", { id }); },
  prepareBackupRestore(id: string): Promise<DatabaseImportPreview | null> { return nativeOnly("prepare_database_backup_restore", { id }); },
  prepareBrowserImport(file: File): Promise<BrowserDatabaseImportPreview> {
    const query = new URLSearchParams({ name: file.name });
    return previewOnly<BrowserDatabaseImportPreview>({
      path: `/api/database-import/preview?${query}`,
      init: { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
    });
  },
  confirmBrowserImport(token: string): Promise<{ message: string }> {
    return previewOnly({ path: "/api/database-import/confirm", init: jsonRequest("POST", { token }) });
  },
  cancelBrowserImport(token: string): Promise<void> {
    return previewOnly({ path: "/api/database-import/cancel", init: jsonRequest("POST", { token }) });
  },
  confirmImport(token: string): Promise<string> {
    return nativeOnly<string>("confirm_database_import", { token });
  },
  cancelImport(token: string): Promise<void> {
    return nativeOnly<void>("cancel_database_import", { token });
  },
};
