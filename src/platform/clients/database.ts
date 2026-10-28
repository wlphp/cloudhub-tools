import { nativeOnly, previewOnly, jsonRequest } from "./base";

export type DatabaseImportPreview = {
  token: string;
  packageName: string;
  exportedAt: string;
  totalRecords: number;
  categories: Array<{ table: string; label: string; count: number }>;
  details: string[];
  conflicts: string[];
  importMode?: "backup" | "merge" | "overwrite";
};

export type BrowserDatabaseImportPreview = DatabaseImportPreview;

export type DatabaseBackupRecord = { id: string; fileName: string; createdAt: string; sizeBytes: number; encrypted: boolean };

export const databaseClient = {
  transferCatalog(): Promise<DatabaseImportPreview["categories"]> { return nativeOnly("database_transfer_catalog"); },
  openBackupDirectory(): Promise<void> {
    return nativeOnly("open_app_data_directory", { directory: "backups" });
  },
  exportSql(tables: string[], includeTrash = false): Promise<string | null> {
    return nativeOnly<string | null>("export_database_file", { format: "sql", tables, includeTrash });
  },
  prepareSqlImport(mode: "merge" | "overwrite"): Promise<DatabaseImportPreview | null> {
    return nativeOnly<DatabaseImportPreview | null>("prepare_database_import", { format: "sql", mode });
  },
  prepareBackupImport(password?: string): Promise<DatabaseImportPreview | null> {
    return nativeOnly<DatabaseImportPreview | null>("prepare_database_import", { format: "backup", password });
  },
  listBackups(): Promise<DatabaseBackupRecord[]> { return nativeOnly("list_database_backups"); },
  createBackup(password?: string): Promise<DatabaseBackupRecord> { return nativeOnly("create_database_backup", password === undefined ? {} : { password }); },
  importBackup(password?: string): Promise<DatabaseBackupRecord | null> { return nativeOnly("import_database_backup", { password }); },
  downloadBackup(id: string): Promise<string | null> { return nativeOnly("download_database_backup", { id }); },
  deleteBackup(id: string): Promise<void> { return nativeOnly("delete_database_backup", { id }); },
  prepareBackupRestore(id: string, password?: string): Promise<DatabaseImportPreview | null> { return nativeOnly("prepare_database_backup_restore", { id, password }); },
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
  confirmImport(token: string, tables?: string[], mode?: "merge" | "overwrite" | "replace", forceRestore = false): Promise<string> {
    return nativeOnly<string>("confirm_database_import", { token, tables, mode, forceRestore });
  },
  cancelImport(token: string): Promise<void> {
    return nativeOnly<void>("cancel_database_import", { token });
  },
};
