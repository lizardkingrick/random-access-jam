# Draws the home-screen icons in icons/: the brand mark (a ring of three coloured segments, one per
# layer, around a play button, as in the top bar) on the app's night background. The icons are full
# squares with no transparent corners. The ring stays inside the middle 80%, so one image works both
# as a plain icon and as a maskable one (Android crops it to a circle or a squircle, iOS rounds the
# corners).
# Usage:  python tools/build-icons.py
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'icons'
SIZES = {'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180}

# The brand mark from index.html, in its 100-unit viewBox: three arcs of radius 33, 11.7 wide,
# centred on (50, 50). Angles are in degrees, clockwise from 3 o'clock (screen coordinates).
CENTRE, RADIUS, WIDTH = 50, 33, 11.7
ARCS = [
    ((2, 191, 241), 212.0, 328.0),  # top: blue
    ((0, 231, 172), 336.0, 444.0),  # right: green (336° round to 84°)
    ((186, 60, 242), 96.0, 204.0),  # left: purple
]
PLAY = [(44.7, 39.4), (62.9, 50.0), (44.7, 60.6)]  # the play triangle (corners rounded below)
BG = (3, 4, 12)


def draw(size, ss=8):
    n = size * ss
    k = n / 100
    out = Image.new('RGB', (n, n), BG)
    d = ImageDraw.Draw(out)
    # each arc as a filled ring sector, so the ends are cut square like the SVG's butt caps
    for colour, a0, a1 in ARCS:
        steps = 96
        outer = [(CENTRE + (RADIUS + WIDTH / 2) * math.cos(math.radians(a0 + (a1 - a0) * i / steps)),
                  CENTRE + (RADIUS + WIDTH / 2) * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]
        inner = [(CENTRE + (RADIUS - WIDTH / 2) * math.cos(math.radians(a1 - (a1 - a0) * i / steps)),
                  CENTRE + (RADIUS - WIDTH / 2) * math.sin(math.radians(a1 - (a1 - a0) * i / steps))) for i in range(steps + 1)]
        d.polygon([(x * k, y * k) for x, y in outer + inner], fill=colour)
    # the play button: a triangle with softly rounded corners
    r = 1.2
    d.polygon([(x * k, y * k) for x, y in PLAY], fill=(255, 255, 255))
    d.line([(x * k, y * k) for x, y in PLAY + PLAY[:1]], fill=(255, 255, 255), width=round(2 * r * k), joint='curve')
    for x, y in PLAY:
        d.ellipse([(x - r) * k, (y - r) * k, (x + r) * k, (y + r) * k], fill=(255, 255, 255))
    return out.resize((size, size), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
for name, size in SIZES.items():
    draw(size).save(OUT / name, optimize=True)
    print(f'icons/{name}  {size}x{size}')
