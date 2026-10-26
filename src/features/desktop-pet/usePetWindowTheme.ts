import { useLayoutEffect } from "react";
import { cloudHubUiThemeStorageKey, readUiTheme } from "../app/constants";

// Pet windows do not mount App, which normally applies the saved UI theme.
export function usePetWindowTheme() {
  useLayoutEffect(() => {
    const wasLight = document.body.classList.contains("theme-light");
    const previousScheme = document.documentElement.style.colorScheme;
    const sync = () => {
      try {
        const light = readUiTheme() === "light";
        document.body.classList.toggle("theme-light", light);
        // WebView2 can paint an opaque dark canvas for a dark color-scheme,
        // even when the native window and CSS backgrounds are transparent.
        document.documentElement.style.colorScheme = "normal";
      } catch { /* Keep the current theme when storage is unavailable. */ }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === cloudHubUiThemeStorageKey || event.key === null) sync();
    };
    sync();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", sync);
      document.body.classList.toggle("theme-light", wasLight);
      document.documentElement.style.colorScheme = previousScheme;
    };
  }, []);
}
