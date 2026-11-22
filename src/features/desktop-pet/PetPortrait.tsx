import type { PetSettings } from "../../platform/clients/desktopPet";
import { petAppearances, petFrameFor, petSpriteStyle, type PetPose } from "./appearances";
import { PetHumanoid } from "./PetHumanoid";

export function PetPortrait({ appearance, pose = "idle", className = "" }: { appearance: PetSettings["appearance"]; pose?: PetPose; className?: string }) {
  if (appearance === "human") return <PetHumanoid pose={pose} hidden className={`pet-portrait pet-portrait-human ${className}`} />;
  const [column, row] = petFrameFor(appearance, pose);
  return <span aria-hidden="true" data-appearance={appearance} className={`pet-portrait ${className}`} style={{ backgroundImage: `url("${petAppearances[appearance].sprite}")`, ...petSpriteStyle(appearance, column, row) }} />;
}
