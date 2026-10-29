import { cloneElement, useId, useState, type ReactElement, type ReactNode } from "react";
import { Info } from "lucide-react";
import "./dialog-form.css";

/** Form row inside SharedDialog; its mobile presentation lives in mobile-dialogs.css. */
export function DialogField({ label, required = false, icon, hint, labelAction, controlAction, showCount = false, children }: { label: string; required?: boolean; icon?: ReactNode; hint?: string; labelAction?: ReactNode; controlAction?: ReactNode; showCount?: boolean; children: ReactElement<{ id?: string; "aria-describedby"?: string; maxLength?: number; defaultValue?: unknown; value?: unknown }> }) {
  const id = useId();
  const [length, setLength] = useState(String(children.props.defaultValue ?? "").length);
  const controlId = children.props.id ?? id;
  return <div className="dialog-field">
    <div className="dialog-field-heading"><label className="dialog-field-label" htmlFor={controlId}>{required && <span className="dialog-field-required" aria-hidden="true">*</span>}{label}</label>{labelAction}</div>
    <div className="dialog-field-content">
      <div className={`dialog-field-control${icon ? " dialog-field-with-icon" : ""}${controlAction ? " dialog-field-with-action" : ""}${showCount ? " dialog-field-counted" : ""}`} onInputCapture={event => { if (showCount && event.target instanceof HTMLTextAreaElement) setLength(event.target.value.length); }}>
        {icon && <span className="dialog-field-icon" aria-hidden="true">{icon}</span>}
        {cloneElement(children, { id: controlId, "aria-describedby": [children.props["aria-describedby"], hint ? `${id}-hint` : undefined].filter(Boolean).join(" ") || undefined })}
        {controlAction && <span className="dialog-field-action">{controlAction}</span>}
        {showCount && children.props.maxLength && <span className="dialog-field-count" aria-hidden="true">{children.props.value == null ? length : String(children.props.value).length}/{children.props.maxLength}</span>}
      </div>
      {hint && <p id={`${id}-hint`} className="dialog-field-hint">{hint}</p>}
    </div>
  </div>;
}

export function DialogNotice({ children }: { children: ReactNode }) {
  return <div className="dialog-notice"><Info size={16} aria-hidden="true" /><div>{children}</div></div>;
}
