import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { DetachedWorkspace } from "./DetachedWorkspace";

const DetachedOwner = createContext<(() => () => void) | null>(null);
export function useDetachedOwner() { return useContext(DetachedOwner); }

/** Keep a dialog's React owner alive while the user works on another page. */
export function DialogPage({ active, children, pageId, detachTitle, keepMounted = false }: { active: boolean; children: () => ReactNode; pageId?: string; detachTitle?: string; keepMounted?: boolean }) {
  const [windows, setWindows] = useState(0);
  const [detached, setDetached] = useState(false);
  const retain = useCallback(() => {
    setWindows(count => count + 1);
    return () => setWindows(count => count - 1);
  }, []);
  return <DetachedOwner.Provider value={retain}>{(active || windows > 0 || detached || keepMounted) && <div className="dialog-page-owner" hidden={!active}>
    {detachTitle && pageId ? <DetachedWorkspace enabled visible={active} title={detachTitle} pageId={pageId} onDetachedChange={setDetached}>{() => children()}</DetachedWorkspace> : children()}
  </div>}</DetachedOwner.Provider>;
}
