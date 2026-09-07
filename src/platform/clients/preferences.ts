import { nativeOnly } from "./base";

export const preferencesClient = {
  list(): Promise<Record<string, string>> {
    return nativeOnly("list_client_preferences");
  },

  save(key: string, value: string): Promise<void> {
    return nativeOnly("save_client_preference", { key, value });
  },
};
