import { nativeOnly } from "./base";

export type AppDataEntry = { name: string; directory: boolean; sizeBytes: number };

export const appClient = {
  listDataDirectory(directory = ""): Promise<AppDataEntry[]> {
    return nativeOnly("list_app_data_directory", { directory });
  },
  dataPath(): Promise<string> {
    return nativeOnly("app_data_path");
  },
  isDevelopment(): Promise<boolean> {
    return nativeOnly("app_is_development");
  },
  openDataDirectory(): Promise<void> {
    return nativeOnly("open_app_data_directory");
  },
  exitApp(): Promise<void> {
    return nativeOnly("app_exit");
  },
};
