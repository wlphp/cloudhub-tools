import { AppWindow, LayoutPanelLeft, RotateCcw, SlidersHorizontal } from "lucide-react";
import { SharedDialog } from "../../shared/SharedDialog";
import { officialPlugins } from "./registry";
import "./plugin-presentation.css";
import { DEFAULT_PRESENTATION, usePluginPresentation, type PluginModalSize, type PluginOpenMode } from "./pluginPresentation";

const MODE_OPTIONS: { value: PluginOpenMode; label: string; hint: string; icon: typeof LayoutPanelLeft }[] = [
  { value: "page", label: "页面", hint: "在主区域铺开，适合内容较多的插件", icon: LayoutPanelLeft },
  { value: "modal", label: "弹层", hint: "浮在当前页面上方，关闭后回到原处", icon: AppWindow },
];

const SIZE_OPTIONS: { value: PluginModalSize; label: string }[] = [
  { value: "large", label: "大弹窗" },
  { value: "small", label: "小弹窗" },
];

/** 每个内置插件的打开方式设置：页面 / 弹层，以及弹层的大小。 */
export function PluginPresentationDialog({ targetId, onClose }: { targetId: string; onClose: () => void }) {
  const { get, set, reset, presentation } = usePluginPresentation();
  const plugin = officialPlugins.find(item => item.id === targetId);
  const current = get(targetId);
  const isDefault = !(targetId in presentation);

  return <SharedDialog title="打开方式" subtitle={plugin?.name ?? "插件"} icon={<SlidersHorizontal size={20} aria-hidden="true" />} className="plugin-presentation-dialog" bodyClassName="plugin-presentation-body" size="small" closeLabel="关闭打开方式设置" showResize={false} onClose={onClose}
    footer={<><button type="button" className="secondary plugin-presentation-reset" disabled={isDefault} onClick={() => reset(targetId)}><RotateCcw size={14} aria-hidden="true" />恢复默认</button><button type="button" className="primary" onClick={onClose}>完成</button></>}>
          <fieldset className="plugin-presentation-group">
            <legend>打开方式</legend>
            <div className="plugin-presentation-modes">
              {MODE_OPTIONS.map(option => {
                const Icon = option.icon;
                return <button key={option.value} type="button" className={`plugin-presentation-mode${current.mode === option.value ? " is-selected" : ""}`} aria-pressed={current.mode === option.value} onClick={() => set(targetId, { ...current, mode: option.value })}>
                  <Icon size={18} aria-hidden="true" />
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </button>;
              })}
            </div>
          </fieldset>
          <fieldset className={`plugin-presentation-group${current.mode === "modal" ? "" : " is-disabled"}`}>
            <legend>弹层大小</legend>
            <div className="plugin-presentation-sizes" role="group" aria-label="弹层大小">
              {SIZE_OPTIONS.map(option => <button key={option.value} type="button" className={`plugin-presentation-size${current.size === option.value ? " is-selected" : ""}`} aria-pressed={current.size === option.value} disabled={current.mode !== "modal"} onClick={() => set(targetId, { ...current, size: option.value })}>{option.label}</button>)}
            </div>
            {current.mode !== "modal" && <small className="plugin-presentation-hint">切换为弹层后可设置大小。{current.size === DEFAULT_PRESENTATION.size ? "" : `当前已记住「${SIZE_OPTIONS.find(item => item.value === current.size)?.label}」，切回弹层时生效。`}</small>}
          </fieldset>
    </SharedDialog>;
}
