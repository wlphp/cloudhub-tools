import fishSprite from "./assets/fish-sprites.png";
import fishFrames from "./assets/fish-frames.json";
import heads from "./assets/pet-heads.json";
import alpacaSprite from "./assets/alpaca-sprites.png";
import dogSprite from "./assets/dog-sprites.png";
import penguinSprite from "./assets/penguin-sprites.png";
import penguinFrames from "./assets/penguin-frames.json";
import dogFrames from "./assets/dog-frames.json";
import type { PetSettings } from "../../platform/clients/desktopPet";

export const petAppearances: Record<PetSettings["appearance"], { label: string; sprite: string }> = {
  alpaca: { label: "羊驼", sprite: alpacaSprite },
  dog: { label: "小狗（柯基）", sprite: dogSprite },
  fish: { label: "大鱼（DeepSeek）", sprite: fishSprite },
  penguin: { label: "企鹅", sprite: penguinSprite },
};

export type PetPose = "idle" | "walk" | "run" | "lie_down" | "spray" | "sleep" | "happy" | "curious" | "hanging" | "work" | "alert";

// Logical 6 x 4 states; dog-frames.json also drives native alpha hit testing.
export function petFrameFor(appearance: PetSettings["appearance"], pose: PetPose, frame = 0): [number, number] {
  if (appearance !== "alpaca") {
    if (pose === "idle") return [frame % 3, 0];
    if (pose === "walk") return [3 + frame % 2, 0];
    if (pose === "lie_down") return [5, 0];
  }
  if (pose === "idle") return [frame % 6, 0];
  if (pose === "run" || pose === "walk") return [frame % 6, 1];
  if (pose === "spray") return [frame % 6, 2];
  return [{ sleep: 0, lie_down: 0, happy: 1, curious: 2, hanging: 3, work: 4, alert: 5 }[pose], 3];
}

export function petSpriteStyle(appearance: PetSettings["appearance"], column: number, row: number) {
  const frames = appearance === "dog" ? dogFrames : appearance === "penguin" ? penguinFrames : appearance === "fish" ? fishFrames : null;
  if (frames) {
    const [left, top, width, height] = frames[row * 6 + column];
    return { backgroundSize: `${1536 / width * 100}% ${1024 / height * 100}%`, backgroundPosition: `${left / (1536 - width) * 100}% ${top / (1024 - height) * 100}%` };
  }
  return { backgroundSize: "600% 400%", backgroundPosition: `${column * 20}% ${row * 100 / 3}%` };
}

export function petHeadStyle(appearance: PetSettings["appearance"]) {
  const [left,top,width,height] = heads[appearance === "dog" ? 1 : appearance === "penguin" ? 2 : appearance === "fish" ? 3 : 0];
  return { backgroundImage: `url("${petAppearances[appearance].sprite}")`, backgroundSize: `${1536/width*100}% ${1024/height*100}%`, backgroundPosition: `${left/(1536-width)*100}% ${top/(1024-height)*100}%` };
}
