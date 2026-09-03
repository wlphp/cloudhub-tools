import { nativeOnly } from "./base";

export type DatabaseImportPreview = {
  token: string;
  packageName: string;
  exportedAt: string;
  totalRecords: number;
  categories: Array<{ label: string; count: number }>;
  details: string[];
  conflicts: string[];
};

export const databaseClient = {
  exportFile(): Promise<string | null> {
    return nativeOnly<string | null>("export_database_file");
  },
  prepareImport(): Promise<DatabaseImportPreview | null> {
    return nativeOnly<DatabaseImportPreview | null>("prepare_database_import");
  },
  confirmImport(token: string): Promise<string> {
    return nativeOnly<string>("confirm_database_import", { token });
  },
  cancelImport(token: string): Promise<void> {
    return nativeOnly<void>("cancel_database_import", { token });
  },
};
