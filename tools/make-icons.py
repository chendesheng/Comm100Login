#!/usr/bin/env python3
"""Regenerates the extension's icons from the source artwork.

    pip install pillow
    python3 tools/make-icons.py [--keep-background]

`src/icons/icon.png` is the source (square, any size); this writes the `icon16/48/128.png` renders
the manifest references, next to it.

Two things happen here:

1. **Background knockout.** A toolbar icon needs a transparent surround, and some exports come out
   flattened onto an opaque near-white page. When the source is fully opaque, the rounded tile drawn
   in the artwork is located (see `detect_tile`) and everything outside it is made transparent. When
   the source already has alpha — the normal case — it is used exactly as drawn and nothing is
   inferred. `--keep-background` skips the knockout for artwork that is deliberately a full square.

2. **Resize**, in a single LANCZOS pass. Stepping down in stages is a common trick for very large
   reductions, but it only adds blur here: LANCZOS is a windowed-sinc filter, so it scales its kernel
   to the reduction ratio and already samples the whole source correctly.

The knockout is a *reconstruction*: it clips the tile's soft drop shadow along with the page, and it
assumes the four corners share one radius. It exists because a white square on dark browser chrome is
worse than a slightly tight tile.
"""

import statistics
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw
except ImportError:  # pragma: no cover - a missing dev dependency, not a code path
    sys.exit('Pillow is required: pip install pillow')

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / 'src' / 'icons'
SOURCE = ICONS / 'icon.png'
SIZES = (16, 48, 128)

# Pillow 9.1 moved the filters behind `Image.Resampling`.
RESAMPLE = getattr(Image, 'Resampling', Image).LANCZOS

# A pixel counts as "artwork, not page" past this per-channel difference from the background. This is
# tuned to the tile outline: its faintest run (the middle of the top edge) reads ~22, while the drop
# shadow ramps up to only ~16 just outside it, so a lower value would start eating the shadow and a
# higher one would lose the edge entirely.
EDGE_THRESHOLD = 20
# Only the middle of each axis is scanned, so the shadow under the tile cannot be mistaken for an edge.
BAND = (0.30, 0.70)
# Guard rails on the inferred corner radius, as a fraction of the tile's shorter side.
RADIUS_RANGE = (0.06, 0.40)
# The mask is drawn oversampled and reduced, so the tile's edge is smooth rather than stair-stepped.
MASK_SUPERSAMPLE = 2


def background_colour(img):
    """The page colour, read from the corners (the tile never reaches them)."""
    w, h = img.size
    patch = 8
    rgb = img.convert('RGB')
    boxes = ((0, 0, patch, patch), (w - patch, 0, w, patch), (0, h - patch, patch, h), (w - patch, h - patch, w, h))
    data = b''.join(rgb.crop(box).tobytes() for box in boxes)
    return tuple(sorted(channel)[len(channel) // 2] for channel in (data[i::3] for i in range(3)))


def deviation(img, bg):
    """Per-pixel `max |channel - background|` as a grayscale image."""
    flat = Image.new('RGB', img.size, bg)
    return ImageChops.difference(img.convert('RGB'), flat).convert('L')


def detect_tile(dev):
    """Bounding box and corner radius of the rounded tile, from where the artwork leaves the page.

    Edges are found per scanline and then reduced with a median: a single row through the logo can
    report the logo's own edge instead of the tile's, but the median over the middle band cannot.
    """
    w, h = dev.size
    px = dev.load()
    x_band = range(int(w * BAND[0]), int(w * BAND[1]))
    y_band = range(int(h * BAND[0]), int(h * BAND[1]))

    lefts, rights = [], []
    for y in y_band:
        hits = [x for x in range(w) if px[x, y] > EDGE_THRESHOLD]
        if hits:
            lefts.append(hits[0])
            rights.append(hits[-1])

    tops, bottoms = [], []
    for x in x_band:
        hits = [y for y in range(h) if px[x, y] > EDGE_THRESHOLD]
        if hits:
            tops.append(hits[0])
            bottoms.append(hits[-1])

    if not (lefts and tops):
        return None

    left, right = int(statistics.median(lefts)), int(statistics.median(rights))
    top, bottom = int(statistics.median(tops)), int(statistics.median(bottoms))
    if right - left < w * 0.2 or bottom - top < h * 0.2:
        return None

    # Walk down the top-left corner: the radius is where the outline stops curving and runs straight.
    radius = 0
    for y in range(top, top + (bottom - top) // 2):
        hits = [x for x in range(w) if px[x, y] > EDGE_THRESHOLD]
        if hits and hits[0] <= left + 2:
            radius = y - top
            break

    short = min(right - left, bottom - top)
    lo, hi = int(short * RADIUS_RANGE[0]), int(short * RADIUS_RANGE[1])
    return left, top, right, bottom, max(lo, min(radius, hi))


def knockout(img, tile):
    """Everything outside the tile's rounded rectangle becomes transparent."""
    left, top, right, bottom, radius = tile
    w, h = img.size
    scale = MASK_SUPERSAMPLE
    mask = Image.new('L', (w * scale, h * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (left * scale, top * scale, right * scale, bottom * scale), radius=radius * scale, fill=255
    )
    result = img.convert('RGBA')
    result.putalpha(mask.resize((w, h), RESAMPLE))
    return result


def main():
    if not SOURCE.exists():
        sys.exit(f'missing source artwork: {SOURCE.relative_to(ROOT)}')

    source = Image.open(SOURCE).convert('RGBA')
    if source.width != source.height:
        sys.exit(f'{SOURCE.name} must be square, got {source.width}x{source.height}')

    keep = '--keep-background' in sys.argv
    if source.getchannel('A').getextrema() != (255, 255):
        print(f'{SOURCE.relative_to(ROOT)} already has transparency — using it as drawn')
    elif keep:
        print(f'{SOURCE.relative_to(ROOT)} is opaque — keeping its background (--keep-background)')
    else:
        tile = detect_tile(deviation(source, background_colour(source)))
        if not tile:
            print(f'{SOURCE.relative_to(ROOT)} is opaque and no tile outline was found — keeping its background')
        else:
            left, top, right, bottom, radius = tile
            print(
                f'{SOURCE.relative_to(ROOT)} is opaque — knocked out everything outside the tile '
                f'({right - left}x{bottom - top} at {left},{top}, corner radius {radius})'
            )
            source = knockout(source, tile)

    for size in SIZES:
        out = ICONS / f'icon{size}.png'
        source.resize((size, size), RESAMPLE).save(out, optimize=True)
        print(f'{out.relative_to(ROOT)}  {size}x{size}')


if __name__ == '__main__':
    main()
