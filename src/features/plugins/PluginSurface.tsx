import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

/** 插件页头部槽位：插件可通过 createPortal 把工具按钮放进标题行。 */
export const PLUGIN_PAGE_HEAD_EXTRA_ID = "plugin-page-head-extra";

/** Normal page navigation must leave the application's sidebar reachable. */
export function PluginPageHost({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    host.current?.focus({ preventScroll: true });
  }, []);

  return <div className="plugin-page-host" ref={host} tabIndex={-1} role="region" aria-label={`${title} 页面`}>
    <header className="plugin-page-head">
      <h1>{title}</h1>
      <div className="plugin-page-head-extra" id={PLUGIN_PAGE_HEAD_EXTRA_ID} />
      <button type="button" className="secondary plugin-page-back" aria-label="返回软件商店" onClick={onClose}><ArrowLeft size={16} aria-hidden="true" />返回软件商店</button>
    </header>
    <div className="plugin-page-body">{children}</div>
  </div>;
}
