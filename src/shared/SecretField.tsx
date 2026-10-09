import { useEffect, useRef, useState, type ChangeEvent, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import "./secret-field.css";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue"> & {
  value?: string;
  defaultValue?: string;
  multiline?: boolean;
  rows?: number;
  secretLabel?: string;
  reveal?: () => Promise<string>;
};

/** Saved values are displayed separately and never become form edits. */
export function SecretField({ value, defaultValue = "", multiline = false, rows = 5, secretLabel = "密钥", reveal, onChange, ...props }: Props) {
  const [localValue, setLocalValue] = useState(defaultValue);
  const [visible, setVisible] = useState(false);
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const currentValue = value ?? localValue;
  useEffect(() => () => { generation.current += 1; }, []);

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    generation.current += 1;
    setSavedValue(null);
    setBusy(false);
    setError("");
    setLocalValue(event.target.value);
    onChange?.(event);
  };
  async function toggle() {
    setError("");
    if (visible) {
      generation.current += 1;
      setVisible(false);
      setSavedValue(null);
      return;
    }
    if (currentValue || !reveal) { setVisible(true); return; }
    const request = ++generation.current;
    setBusy(true);
    try {
      const secret = await reveal();
      if (generation.current !== request) return;
      setSavedValue(secret);
      setVisible(true);
    } catch {
      if (generation.current === request) setError("无法读取已保存凭据，请在 App 内重试。");
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }
  const label = busy ? `正在读取${secretLabel}` : `${visible ? "隐藏" : "显示"}${secretLabel}`;
  return <span className="secret-field-group">
    <span className="secret-field">
      {multiline ? <textarea {...(props as unknown as TextareaHTMLAttributes<HTMLTextAreaElement>)} aria-label={props["aria-label"] ?? secretLabel} rows={rows} value={currentValue} onChange={(event) => change(event as unknown as ChangeEvent<HTMLInputElement>)} hidden={savedValue !== null} className={`${props.className ?? ""} ${visible ? "" : "secret-field-masked"}`} />
        : <input {...props} aria-label={props["aria-label"] ?? secretLabel} type={visible ? "text" : "password"} value={currentValue} onChange={change} hidden={savedValue !== null} />}
      {savedValue !== null && (multiline ? <textarea readOnly rows={rows} value={savedValue} aria-label={`已保存的${secretLabel}`} spellCheck={false} /> : <input readOnly type="text" value={savedValue} aria-label={`已保存的${secretLabel}`} autoComplete="off" />)}
      <button type="button" className="secret-field-eye" disabled={props.disabled || busy} title={label} aria-label={label} aria-pressed={visible} onClick={() => void toggle()}>{busy ? <RefreshCw size={17} /> : visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
    </span>
    {savedValue !== null && <small className="secret-field-note">正在查看已保存凭据；隐藏后可输入新值。</small>}
    {error && <small className="secret-field-error" role="alert">{error}</small>}
  </span>;
}
