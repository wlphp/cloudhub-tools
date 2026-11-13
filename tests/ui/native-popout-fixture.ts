import type { Page } from "@playwright/test";

export async function setupNativePage(page: Page, desktop = true) {
  await page.addInitScript(({ desktop }) => {
    const state = window as any;
    state.__popups = [];
    state.__listeners = [];
    const callbacks = new Map<number, Function>();
    let next = 0;
    state.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    if (desktop) state.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (callback: Function) => { callbacks.set(++next, callback); return next; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === "plugin:window|get_all_windows") return ["main", ...state.__popups.map((popup: Window) => popup.name)];
        if (command === "plugin:window|destroy") state.__popups.find((popup: Window) => popup.name === args.label)?.close();
        if (command === "plugin:event|listen") { state.__listeners.push(args); return ++next; }
        if (command.startsWith("plugin:")) return null;
        if (command === "authenticator_status") return { initialized: true, unlocked: true, passwordRequired: false };
        if (command === "pet_snapshot") return { alerts: [], checkedAt: 0, lastError: null };
        if (command === "list_client_preferences") return {};
        if (command === "notes_snapshot") return { notes: [], trashed: [], groups: ["测试"], reminders: [] };
        if (command === "notes_save") { state.__savedNotes = args; return 1; }
        if (command === "browser_snapshot") return { supported: false, kernel: { version: "", installed: false, phase: "idle" }, kernels: [], environments: [] };
        return [];
      },
    };
    state.__requestNativeClose = async () => {
      const listener = state.__listeners.findLast((item: any) => item.event === "tauri://close-requested" && item.target?.label.startsWith("dialog-popout-"));
      await callbacks.get(listener.handler)?.({ event: "tauri://close-requested", id: 1, payload: null });
    };
    const original = window.open.bind(window);
    window.open = (...args) => {
      if (state.__blockPopup) return null;
      const popup = original(...args);
      if (popup) state.__popups.push(popup);
      return popup;
    };
  }, { desktop });
  if (!desktop) await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.goto("/");
}
