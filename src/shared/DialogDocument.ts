import { createContext, useContext } from "react";

/** Portals opened from a detached dialog belong to that dialog's document. */
export const DialogDocument = createContext<Document | null>(null);
export function useDialogDocument() { return useContext(DialogDocument) ?? document; }
