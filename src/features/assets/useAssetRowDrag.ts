import { useSortableDrag } from "../../shared/useSortableDrag";

export function useAssetRowDrag(onMove: (source: string, target: string) => void, enabled = false) {
  return useSortableDrag({ selector: "[data-asset-row-key]", attribute: "data-asset-row-key", onMove, enabled });
}
