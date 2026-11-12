import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const DetachedOwner = createContext<(() => () => void) | null>(null);
export function useDetachedOwner() { return useContext(DetachedOwner); }

/** Keep a dialog's React owner alive while the user works on another page. */
export function DialogPage({ active, children }: { active: boolean; children: () => ReactNode }) {
  const [windows, setWindows] = useState(0);
  const retain = useCallback(() => {
    setWindows(count => count + 1);
    return () => setWindows(count => count - 1);
  }, []);
  return <DetachedOwner.Provider value={retain}>{(active || windows > 0) && <div className="dialog-page-owner" hidden={!active}>{children()}</div>}</DetachedOwner.Provider>;
}
