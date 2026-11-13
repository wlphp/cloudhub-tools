import { Window as NativeWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

export interface DetachedDialog {
  document: Document;
  window: Window;
  native: NativeWindow;
  dispose: () => void;
}

/** Portal events run in the opener; move the popup without relying on OS mouse capture there. */
export function dragDetachedDialog(popup: DetachedDialog, handle: HTMLElement, pointer: { pointerId: number; screenX: number; screenY: number }, onError: () => void) {
  let ended = false;
  let latest = { x: pointer.screenX, y: pointer.screenY };
  let origin: { x: number; y: number; scale: number } | null = null;
  let moving = false;
  const finish = () => {
    ended = true;
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
    handle.removeEventListener("lostpointercapture", finish);
    if (handle.hasPointerCapture(pointer.pointerId)) handle.releasePointerCapture(pointer.pointerId);
  };
  const update = async () => {
    if (!origin || moving || ended) return;
    moving = true;
    try {
      let applied;
      do {
        applied = latest;
        await popup.native.setPosition(new PhysicalPosition(
          Math.round(origin.x + (applied.x - pointer.screenX) * origin.scale),
          Math.round(origin.y + (applied.y - pointer.screenY) * origin.scale),
        ));
      } while (!ended && applied !== latest);
    } catch { finish(); onError(); }
    finally { moving = false; }
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer.pointerId) return;
    latest = { x: event.screenX, y: event.screenY };
    void update();
  };
  handle.setPointerCapture(pointer.pointerId);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("lostpointercapture", finish);
  void Promise.all([popup.native.outerPosition(), popup.native.scaleFactor()]).then(([position, scale]) => {
    origin = { ...position, scale };
    void update();
  }).catch(() => { finish(); onError(); });
  return finish;
}

/** The original portal container is adopted, never cloned or serialized. */
export async function openDetachedDialog(source: Document, title: string, bounds: DOMRect, position: { x: number; y: number } | undefined, onClose: () => void): Promise<DetachedDialog> {
  const label = `dialog-popout-${crypto.randomUUID()}`;
  const owner = source.defaultView!;
  // WebView2 can report sentinel screen coordinates during window transitions.
  const coordinate = (value: number) => Number.isFinite(value) && Math.abs(value) < 32768 ? Math.round(value) : 64;
  const x = coordinate(position?.x ?? owner.screenX + bounds.left);
  const y = coordinate(position?.y ?? owner.screenY + bounds.top);
  // The application host owns the allowlisted native popup handler. A page
  // already adopted into a blank window can still detach its child dialogs.
  const popup = window.open(`about:blank#${label}`, label, `popup,width=${Math.round(bounds.width)},height=${Math.round(bounds.height)},left=${x},top=${y}`);
  if (!popup) throw new Error("无法创建独立窗口，请重试");
  const native = await NativeWindow.getByLabel(label);
  if (!native) { popup.close(); throw new Error("独立窗口未准备好，内容已保留"); }
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let observer: MutationObserver | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    unlisten?.();
    void native.destroy().catch(() => { if (!popup.closed) popup.close(); });
  };
  try {
    // Related WebViews may become available after window.open returns.
    const deadline = Date.now() + 5000;
    while (!popup.document?.body) {
      if (popup.closed || Date.now() > deadline) throw new Error("独立窗口未准备好，请重试");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const target = popup.document;
    target.title = title;
    const base = target.createElement("base");
    base.href = source.baseURI;
    target.head.append(base);
    const copied = new Map<Element, Element>();
    const syncStyles = () => {
      const styles = [...source.head.querySelectorAll('style, link[rel="stylesheet"]')];
      for (const [original, clone] of copied) if (!styles.includes(original)) { clone.remove(); copied.delete(original); }
      for (const original of styles) {
        const clone = original.cloneNode(true) as Element;
        const previous = copied.get(original);
        if (previous?.isEqualNode(clone)) continue;
        if (previous) previous.replaceWith(clone); else target.head.append(clone);
        copied.set(original, clone);
      }
      target.documentElement.className = source.documentElement.className;
      target.documentElement.style.cssText = source.documentElement.style.cssText;
      target.body.className = source.body.className;
      target.body.classList.add("dialog-popout-page");
      target.body.style.cssText = source.body.style.cssText;
    };
    syncStyles();
    observer = new MutationObserver(syncStyles);
    observer.observe(source.head, { childList: true, subtree: true, characterData: true, attributes: true });
    observer.observe(source.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    observer.observe(source.body, { attributes: true, attributeFilter: ["class", "style"] });
    unlisten = await native.onCloseRequested(event => {
      event.preventDefault();
      onClose();
    });
    // Load the theme before revealing the window. Failure leaves the original modal intact.
    await Promise.all([...target.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link => new Promise<void>((resolve, reject) => {
      if (link.sheet) { resolve(); return; }
      const timeout = setTimeout(() => reject(new Error("独立窗口样式加载失败")), 5000);
      link.onload = () => { clearTimeout(timeout); resolve(); };
      link.onerror = () => { clearTimeout(timeout); reject(new Error("独立窗口样式加载失败")); };
    })));
    await native.show();
    return { document: target, window: popup, native, dispose };
  } catch {
    dispose();
    throw new Error("打开独立窗口失败，内容已保留，请重试");
  }
}
