"""Regenerate the shared app icons from the maintained SVG source."""

from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri/icons"
ANDROID = ICONS / "android"
GENERATED_ANDROID = ROOT / "src-tauri/gen/android/app/src/main/res"


def main():
    subprocess.run(
        [
            "npx",
            "tauri",
            "icon",
            str(ICONS / "icon-manifest.json"),
            "--output",
            str(ICONS),
        ],
        cwd=ROOT,
        check=True,
    )

    # Tauri writes Android icons into its generated project. Keep the checked-in
    # launcher resources in sync because mobile-target.mjs copies them at build.
    for source in sorted(GENERATED_ANDROID.glob("mipmap-*/ic_launcher*.png")):
        target = ANDROID / source.parent.name / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    # Retain the legacy raster source as a matching preview/compatibility asset.
    shutil.copy2(ICONS / "icon.png", ICONS / "yunshu-tools-source.png")
    # The React sidebar and About page use this public asset, so keep it aligned
    # with the native launcher icon generated from the same maintained SVG.
    shutil.copy2(ICONS / "icon.png", ROOT / "public/cloudhub-logo.png")


if __name__ == "__main__":
    main()
