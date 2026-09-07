import { nativeOnly } from "./base";

export const appClient = {
  openDataDirectory(): Promise<void> {
    return nativeOnly("open_app_data_directory");
  },
};
