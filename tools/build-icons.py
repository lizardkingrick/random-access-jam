# Draws the home-screen icons in icons/: the brand mark (three glowing blue strokes, as in the top
# bar) on the app's night-blue background. The mark stays inside the middle 60%, so one image works
# both as a plain icon and as a maskable one (Android crops it to a circle or a squircle, iOS rounds
# the corners).
# Usage:  python tools/build-icons.py
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / 'icons'
SIZES = {'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180}

# The brand mark from index.html, in its 48-unit viewBox: three strokes, 5 wide, round caps.
STROKES = [((8, 26), (24, 10)), ((10, 38), (34, 14)), ((22, 40), (40, 22))]
STROKE_W = 5
MARK_BOX = (5.5, 7.5, 42.5, 42.5)  # the strokes' extent, caps included
BLUE = (47, 140, 255)
BG_TOP, BG_BOTTOM = (11, 16, 64), (3, 4, 12)  # the hub's gradient


def draw(size, ss=4):
    n = size * ss
    # background: a soft vertical fade, lighter at the top like the hub
    bg = Image.new('RGB', (n, n))
    px = ImageDraw.Draw(bg)
    for y in range(n):
        t = y / (n - 1)
        px.line([(0, y), (n, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))

    # the mark, scaled to 60% of the icon and centred
    x0, y0, x1, y1 = MARK_BOX
    scale = 0.6 * n / max(x1 - x0, y1 - y0)
    ox = n / 2 - (x0 + x1) / 2 * scale
    oy = n / 2 - (y0 + y1) / 2 * scale
    mark = Image.new('L', (n, n), 0)
    md = ImageDraw.Draw(mark)
    w = STROKE_W * scale
    for (ax, ay), (bx, by) in STROKES:
        a, b = (ox + ax * scale, oy + ay * scale), (ox + bx * scale, oy + by * scale)
        md.line([a, b], fill=255, width=round(w))
        for cx, cy in (a, b):
            md.ellipse([cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2], fill=255)

    # glow under the strokes, then the strokes themselves
    glow = mark.filter(ImageFilter.GaussianBlur(n * 0.035)).point(lambda v: v * 0.85)
    out = ImageChops.add(bg, Image.merge('RGB', [glow.point(lambda v, c=c: v * c / 255) for c in BLUE]))
    out.paste(Image.new('RGB', (n, n), BLUE), mask=mark)
    return out.resize((size, size), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
for name, size in SIZES.items():
    draw(size).save(OUT / name, optimize=True)
    print(f'icons/{name}  {size}x{size}')
