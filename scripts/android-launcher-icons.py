"""Rebuild Android launcher images with a centered, smaller cloud mark.

Requires Pillow. Keeps the shared desktop/iOS artwork and Android tile outline.
"""

from pathlib import Path
from math import hypot

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src-tauri/icons/yunshu-tools-source.png"
ANDROID = ROOT / "src-tauri/icons/android"


def launcher_artwork():
    source = Image.open(SOURCE).convert("RGBA")
    if source.size != (1024, 1024):
        raise ValueError("Expected the maintained 1024px launcher source")

    # Select the colored mark, leaving the pale disk and rounded tile in place.
    mask = Image.new("L", source.size)
    for y in range(190, 700):
        for x in range(190, 910):
            r, g, b, alpha = source.getpixel((x, y))
            if alpha == 255 and max(r, g, b) - min(r, g, b) > 16:
                mask.putpixel((x, y), 255)
    mask = mask.filter(ImageFilter.MaxFilter(5))
    bounds = mask.getbbox()
    if bounds is None:
        raise ValueError("Cloud mark missing from launcher source")

    cloud = source.copy()
    cloud.putalpha(mask)
    cloud = cloud.crop(bounds)
    tile = source.copy()
    pixels = tile.load()
    selected = mask.load()
    original = source.load()
    # Recover the white highlight disk and pale tile beneath the old mark.
    for y in range(bounds[1], bounds[3]):
        for x in range(bounds[0], bounds[2]):
            if not selected[x, y]:
                continue
            radius = hypot(x - 512, y - 492)
            if radius < 299:
                color = (254, 254, 255, 255)
            else:
                left, right = original[100, y], original[924, y]
                fraction = (x - 100) / 824
                color = tuple(round(a + (b - a) * fraction) for a, b in zip(left, right))
            pixels[x, y] = color

    size = (round(cloud.width * 0.90), round(cloud.height * 0.90))
    cloud = cloud.resize(size, Image.Resampling.LANCZOS)
    # Center on the actual colored bounds, rather than the source canvas.
    center_y = (bounds[1] + bounds[3]) / 2
    tile.alpha_composite(cloud, ((1024 - size[0]) // 2, round(center_y - size[1] / 2)))
    return tile


if __name__ == "__main__":
    artwork = launcher_artwork()
    # Android 8+ launchers use this foreground with the existing background
    # and safe inset. Leave legacy square/circular silhouettes untouched.
    for target in sorted(ANDROID.glob("mipmap-*/ic_launcher_foreground.png")):
        with Image.open(target) as current:
            size = current.size
        artwork.resize(size, Image.Resampling.LANCZOS).save(target)
        print(f"Updated {target.relative_to(ROOT)} ({size[0]}px)")
