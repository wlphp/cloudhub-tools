import alpacaSprite from "./assets/alpaca-sprites.png";
import dogSprite from "./assets/dog-sprites.png";
import type { PetSettings } from "../../platform/clients/desktopPet";

export const petAppearances: Record<PetSettings["appearance"], { label: string; sprite: string }> = {
  alpaca: { label: "羊驼", sprite: alpacaSprite },
  dog: { label: "小狗", sprite: dogSprite },
};

// The dog's expressive poses use wider gutters than its regular animation grid.
// Keep these bounds in sync with sprite_rect in commands/desktop_pet.rs.
export function petSpriteStyle(appearance: PetSettings["appearance"], column: number, row: number) {
  if (appearance === "dog" && row === 3) {
    const edges = [0, 282, 532, 782, 1032, 1284, 1536];
    const left = edges[column], width = edges[column + 1] - left;
    return { backgroundSize: `${1536 / width * 100}% ${1024 / 274 * 100}%`, backgroundPosition: `${left / (1536 - width) * 100}% 100%` };
  }
  return { backgroundSize: "600% 400%", backgroundPosition: `${column * 20}% ${row * 100 / 3}%` };
}
