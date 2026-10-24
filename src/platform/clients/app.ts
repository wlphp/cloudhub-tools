import { nativeOnly } from "./base";

export const appClient = {
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
