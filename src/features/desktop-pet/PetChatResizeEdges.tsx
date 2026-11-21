import { useEffect, useRef, type PointerEvent } from "react";
import { platformErrorMessage } from "../../platform/api";
import { desktopPetClient as client, type PetChatResizeEdge } from "../../platform/clients/desktopPet";

const edges: PetChatResizeEdge[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

interface ResizeDrag {
  edge: PetChatResizeEdge;
  pointer: number;
  x: number;
  y: number;
  last: { dx: number; dy: number };
  pending: { dx: number; dy: number } | null;
  started: boolean;
  sending: boolean;
  finished: boolean;
}

export function PetChatResizeEdges({ onError }: { onError: (message: string) => void }) {
  const active = useRef<ResizeDrag | null>(null);

  useEffect(() => () => { active.current = null; }, []);

  function flush(drag: ResizeDrag) {
    if (active.current !== drag || drag.sending) return;
    const delta = drag.pending;
    if (!delta) {
      if (drag.finished) active.current = null;
      return;
    }
    drag.pending = null;
    drag.sending = true;
    void client.resizeChat(drag.edge, delta.dx, delta.dy, !drag.started)
      .then(() => { drag.started = true; })
      .catch(error => {
        if (active.current === drag) {
          active.current = null;
          onError(platformErrorMessage(error));
        }
      })
      .finally(() => {
        drag.sending = false;
        flush(drag);
      });
  }

  function begin(event: PointerEvent<HTMLDivElement>, edge: PetChatResizeEdge) {
    if (event.button !== 0 || active.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = { dx: 0, dy: 0 };
    const drag: ResizeDrag = {
      edge, pointer: event.pointerId, x: event.screenX, y: event.screenY,
      last: origin, pending: origin, started: false, sending: false, finished: false,
    };
    active.current = drag;
    flush(drag);
  }

  function move(event: PointerEvent<HTMLDivElement>, finish = false) {
    const drag = active.current;
    if (!drag || drag.pointer !== event.pointerId || drag.finished) return;
    const dx = Math.round(event.screenX - drag.x);
    const dy = Math.round(event.screenY - drag.y);
    if (drag.last.dx !== dx || drag.last.dy !== dy) {
      drag.last = { dx, dy };
      drag.pending = drag.last;
    }
    drag.finished = finish;
    flush(drag);
  }

  function cancel(event: PointerEvent<HTMLDivElement>) {
    const drag = active.current;
    if (!drag || drag.pointer !== event.pointerId || drag.finished) return;
    drag.pending = null;
    drag.finished = true;
    flush(drag);
  }

  return <div className="pet-chat-resize-edges" aria-hidden="true">
    {edges.map(edge => <div key={edge} className={`dialog-resize-handle dialog-resize-${edge}`}
      onPointerDown={event => begin(event, edge)}
      onPointerMove={event => move(event)}
      onPointerUp={event => move(event, true)}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel} />)}
  </div>;
}
