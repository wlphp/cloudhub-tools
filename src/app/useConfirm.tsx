import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import type { ConfirmRequest, PromptRequest } from "../shared/types";

type ConfirmOptions = Pick<ConfirmRequest, "tone" | "title" | "confirmLabel">;

export type UseConfirm = {
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  prompt: (message: string, initialValue?: string) => Promise<string | null>;
  confirmRequest: ConfirmRequest | null;
  promptRequest: PromptRequest | null;
  promptValue: string;
  setPromptValue: (value: string) => void;
  resolveConfirm: (confirmed: boolean) => void;
  resolvePrompt: (value: string | null) => void;
};

// Owns the confirm/prompt state machine. The host component wires the returned
// render helpers below (ConfirmPortal/PromptPortal) into the React tree.
export function useConfirm(): UseConfirm {
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(null);
  const [promptValue, setPromptValue] = useState("");

  const confirm = useCallback((message: string, options: ConfirmOptions = {}) => {
    return new Promise<boolean>((resolve) => setConfirmRequest({ message, resolve, ...options }));
  }, []);

  const prompt = useCallback((message: string, initialValue = "") => {
    setPromptValue(initialValue);
    return new Promise<string | null>((resolve) => setPromptRequest({ message, resolve }));
  }, []);

  const resolveConfirm = useCallback((value: boolean) => {
    setConfirmRequest((current) => { current?.resolve(value); return null; });
  }, []);

  const resolvePrompt = useCallback((value: string | null) => {
    setPromptRequest((current) => { current?.resolve(value); return null; });
  }, []);

  useEffect(() => {
    if (!confirmRequest && !promptRequest) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmRequest) resolveConfirm(false);
      else resolvePrompt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmRequest, promptRequest, resolveConfirm, resolvePrompt]);

  return {
    confirm,
    prompt,
    confirmRequest,
    promptRequest,
    promptValue,
    setPromptValue,
    resolveConfirm,
    resolvePrompt,
  };
}

type ConfirmDialogProps = {
  request: ConfirmRequest | null;
  onResolve: (value: boolean) => void;
};

export function ConfirmDialog({ request, onResolve }: ConfirmDialogProps) {
  if (!request) return null;
  const isDanger = request.tone === "danger";
  return createPortal(
    <div className="app-confirm-backdrop" onClick={() => onResolve(false)}>
      <section
        className={`app-confirm-dialog${isDanger ? " is-danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-confirm-icon"><AlertTriangle size={20} aria-hidden="true" /></div>
        <div className="app-confirm-copy">
          <span className="eyebrow">{isDanger ? "危险操作" : "确认操作"}</span>
          <h2 id="confirm-title">{request.title ?? "确认操作"}</h2>
          <p id="confirm-message">{request.message}</p>
        </div>
        <div className="app-confirm-actions">
          <button type="button" className="secondary" autoFocus onClick={() => onResolve(false)}>取消</button>
          <button type="button" className={`primary app-confirm-primary${isDanger ? " app-confirm-danger" : ""}`} onClick={() => onResolve(true)}>
            {request.confirmLabel ?? "确认"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

type PromptDialogProps = {
  request: PromptRequest | null;
  value: string;
  onValueChange: (value: string) => void;
  onResolve: (value: string | null) => void;
};

export function PromptDialog({ request, value, onValueChange, onResolve }: PromptDialogProps) {
  if (!request) return null;
  return createPortal(
    <div className="app-confirm-backdrop" onClick={() => onResolve(null)}>
      <form
        className="app-confirm-dialog app-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        aria-describedby="prompt-message"
        onSubmit={(event) => { event.preventDefault(); onResolve(value); }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-confirm-icon"><AlertTriangle size={20} /></div>
        <div className="app-confirm-copy">
          <span className="eyebrow">INPUT REQUIRED</span>
          <h2 id="prompt-title">请输入内容</h2>
          <p id="prompt-message">{request.message}</p>
          <input aria-label="需要输入的内容" value={value} autoFocus onChange={(event) => onValueChange(event.target.value)} />
        </div>
        <div className="app-confirm-actions">
          <button type="button" className="secondary" onClick={() => onResolve(null)}>取消</button>
          <button type="submit" className="primary app-confirm-primary">确定</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
