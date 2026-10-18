import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** 插件界面的打开方式。页面是默认：内容多时铺满主区域，比弹层更好读。 */
export type PluginOpenMode = "page" | "modal";
/** 弹层尺寸；仅在 `modal` 模式下生效。 */
export type PluginModalSize = "large" | "small";

export type PluginPresentation = { mode: PluginOpenMode; size: PluginModalSize };

export const DEFAULT_PRESENTATION: PluginPresentation = { mode: "page", size: "large" };

const STORAGE_KEY = "cloudhub.plugin-presentation";

function readAll(): Record<string, PluginPresentation> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, PluginPresentation> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { mode?: unknown; size?: unknown };
      // 逐字段校验：本机存储可能被旧版本或手工改坏，不能直接信任。
      const mode = entry.mode === "modal" ? "modal" : "page";
      const size = entry.size === "small" ? "small" : "large";
      result[key] = { mode, size };
    }
    return result;
  } catch {
    return {};
  }
}

type PresentationStore = {
  presentation: Record<string, PluginPresentation>;
  get: (pluginId: string) => PluginPresentation;
  set: (pluginId: string, next: PluginPresentation) => void;
  reset: (pluginId: string) => void;
};

const PresentationContext = createContext<PresentationStore | null>(null);

export function PluginPresentationProvider({ children }: { children: ReactNode }) {
  const [presentation, setPresentation] = useState<Record<string, PluginPresentation>>(() => readAll());

  // 只在首次挂载后写入，避免服务端或测试环境没有 localStorage 时抛错。
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(presentation)); } catch { /* 隐私模式下忽略 */ }
  }, [presentation]);

  const store = useMemo<PresentationStore>(() => ({
    presentation,
    get: pluginId => presentation[pluginId] ?? DEFAULT_PRESENTATION,
    set: (pluginId, next) => setPresentation(current => ({ ...current, [pluginId]: next })),
    reset: pluginId => setPresentation(current => {
      if (!(pluginId in current)) return current;
      const next = { ...current };
      delete next[pluginId];
      return next;
    }),
  }), [presentation]);

  return <PresentationContext.Provider value={store}>{children}</PresentationContext.Provider>;
}

export function usePluginPresentation(): PresentationStore {
  const store = useContext(PresentationContext);
  // Provider 缺失时退化为默认值，保证插件在独立测试里也能渲染。
  const fallback = useMemo<PresentationStore>(() => ({
    presentation: {},
    get: () => DEFAULT_PRESENTATION,
    set: () => undefined,
    reset: () => undefined,
  }), []);
  return store ?? fallback;
}
