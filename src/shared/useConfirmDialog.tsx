import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

type Confirmation = { message: string; title?: string; confirmLabel?: string };

export function useConfirmDialog() {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(() => () => {
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(false);
  }, []);

  const confirm = useCallback((options: Confirmation): Promise<boolean> => {
    if (resolver.current) return Promise.resolve(false);
    return new Promise(resolve => {
      resolver.current = resolve;
      setPending(options);
    });
  }, []);

  const onResolve = useCallback((confirmed: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(confirmed);
  }, []);

  return {
    confirm,
    confirmationDialog: pending ? <ConfirmDialog {...pending} onResolve={onResolve} /> : null,
  };
}
