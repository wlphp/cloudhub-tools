import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface MultiSelectFilterOption {
  value: string;
  label: string;
  count?: number;
}

export interface MultiSelectFilterProps {
  /** 面板标题，如“分组”“状态”；多选时触发器显示“已选 N 个{label}”。 */
  label: string;
  /** 触发器与复选框的无障碍名称，如“按分组筛选面板”。 */
  ariaLabel: string;
  /** 未筛选时触发器前缀，默认“全部”。 */
  allLabel?: string;
  /** 全部选项的总数；默认取各选项计数之和。 */
  total?: number;
  options: MultiSelectFilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  title?: string;
  /** 附加类名挂在外层容器上，便于页面级样式覆盖。 */
  className?: string;
}

/** 列表工具栏的复选多选筛选下拉：触发器按钮 + 固定定位多选面板，面板顶部为全选复选框。 */
export function MultiSelectFilter({ label, ariaLabel, allLabel = "全部", total, options, selected, onChange, disabled, title, className }: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setPosition(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 捕获阶段拦截：筛选面板先于所在对话框消费 Escape，避免把整个弹层一起关闭。
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
        setPosition(null);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  const allSelected = options.length > 0 && selected.length === options.length;
  const totalCount = total ?? options.reduce((sum, option) => sum + (option.count ?? 0), 0);
  const single = selected.length === 1 ? options.find((option) => option.value === selected[0]) : undefined;
  const triggerLabel = selected.length === 0
    ? `${allLabel}（${totalCount}）`
    : single
      ? `${single.label}（${single.count ?? ""}）`
      : `已选 ${selected.length} 个${label}`;

  return (
    <div className={`provider-filter-wrap${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={`account-provider-filter-toggle${open ? " is-open" : ""}${selected.length ? " has-selection" : ""}`}
        aria-label={ariaLabel}
        title={title ?? `${ariaLabel}，可多选，括号内为对应数量`}
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          if (open) {
            setOpen(false);
            setPosition(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 272)) });
          setOpen(true);
        }}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="account-provider-filter-menu"
          role="group"
          aria-label={ariaLabel}
          style={position ? { position: "fixed", top: position.top, left: position.left, right: "auto" } : undefined}
        >
          <label className="account-provider-filter-head">
            <input
              ref={(element) => { if (element) element.indeterminate = selected.length > 0 && !allSelected; }}
              type="checkbox"
              aria-label={allLabel}
              checked={allSelected}
              onChange={() => onChange(allSelected ? [] : options.map((option) => option.value))}
            />
            <span>{label}</span>
          </label>
          <div className="account-provider-filter-list">
            {options.map((option) => (
              <label key={option.value} className="account-provider-filter-row">
                <input
                  type="checkbox"
                  aria-label={`${ariaLabel}：${option.label}`}
                  checked={selected.includes(option.value)}
                  onChange={() => onChange(selected.includes(option.value) ? selected.filter((value) => value !== option.value) : [...selected, option.value])}
                />
                <span className="account-provider-filter-name">{option.label}</span>
                {option.count != null && <small>{option.count}</small>}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
