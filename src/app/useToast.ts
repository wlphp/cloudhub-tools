import { useCallback, useEffect, useState } from "react";

const TOAST_TIMEOUT_MS = 2600;

export type UseToast = {
  message: string;
  notify: (message: string) => void;
};

// Single-source-of-truth toast for the workbench. Any caller (top-level
// useEffect, try/catch handler, onNotice prop) can call notify() and the
// previous message is cleared on a short timer so the user is never left
// staring at a stale notice. Returning the message as a string keeps the
// JSX surface trivial.
export function useToast(): UseToast {
  const [message, setMessage] = useState("");

  const notify = useCallback((next: string) => {
    setMessage(next);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), TOAST_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [message]);

  return { message, notify };
}
