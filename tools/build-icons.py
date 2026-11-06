# Draws the home-screen icons in icons/: the brand mark (a ring of three coloured segments, one per
# layer, around a play button, as in the top bar) on the app's night background. The icons are full
# squares with no transparent corners. The ring stays inside the middle 80%, so one image works both
# as a plain icon and as a maskable one (Android crops it to a circle or a squircle, iOS rounds the
# corners).
# Usage:  python tools/build-icons.py
# After changing the icons, bump the ?v= on their URLs in manifest.webmanifest and index.html
# (apple-touch-icon): the files keep their names and are cached for a day, and an installed app
# on Android only swaps its icon when the manifest's icon URL changes.
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'icons'
SIZES = {'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180}

# The brand mark from index.html, in its 100-unit viewBox: a ring of radius 33, 11.7 wide, centred
# on (50, 50), cut into three equal 120° segments by three straight gaps GAP wide (each a band
# centred on a radius, so its edges are parallel). The segments run between gap centres, in
# degrees clockwise from 3 o'clock (screen coordinates).
CENTRE, RADIUS, WIDTH, GAP = 50, 33, 11.7, 4.6
ARCS = [
    ((2, 191, 241), 210.0, 330.0),  # top: blue
    ((0, 231, 172), 330.0, 450.0),  # right: green (330° round to 90°)
    ((186, 60, 242), 90.0, 210.0),  # left: purple
]
PLAY = [(44.7, 39.4), (62.9, 50.0), (44.7, 60.6)]  # the play triangle (corners rounded below)
BG = (3, 4, 12)


def draw(size, ss=8):
    n = size * ss
    k = n / 100
    out = Image.new('RGB', (n, n), BG)
    d = ImageDraw.Draw(out)
    # each segment as a filled ring sector whose ends follow the gaps' straight edges: at radius r
    # an edge half a gap from its centre line sits asin(GAP/2 / r) round from it
    ro, ri = RADIUS + WIDTH / 2, RADIUS - WIDTH / 2
    def edge(r, a0, a1):
        trim = math.degrees(math.asin(GAP / 2 / r))
        return a0 + trim, a1 - trim
    for colour, a0, a1 in ARCS:
        steps = 96
        (o0, o1), (i0, i1) = edge(ro, a0, a1), edge(ri, a0, a1)
        outer = [(CENTRE + ro * math.cos(math.radians(o0 + (o1 - o0) * i / steps)),
                  CENTRE + ro * math.sin(math.radians(o0 + (o1 - o0) * i / steps))) for i in range(steps + 1)]
        inner = [(CENTRE + ri * math.cos(math.radians(i1 - (i1 - i0) * i / steps)),
                  CENTRE + ri * math.sin(math.radians(i1 - (i1 - i0) * i / steps))) for i in range(steps + 1)]
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
