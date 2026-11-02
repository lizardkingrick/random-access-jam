# Cuts the two figure silhouettes into the transparent head and body masks in js/figures/.
# Each figure is split at the neck so the head can nod. The body keeps its whole neck and the head
# reaches down over it, so there is always something solid behind the moving head and no gap opens
# at the neck. The torso is carried down to the bottom of the image so its cut-off edge stays hidden
# behind the pyramid.
# Usage:  python tools/build-figures.py <left figure.png> <right figure.png>
import sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'js' / 'figures'
WIDTH = 720  # output width in pixels

# In source pixels: the outline of each head, and the neck pivot (keep in step with js/stage-pyramid.js).
HEADS = {
    'left': [(400, 90), (900, 90), (900, 480), (810, 570), (740, 640), (640, 660), (470, 540), (420, 470)],
    'right': [(230, 180), (700, 180), (700, 430), (640, 470), (612, 528), (540, 640), (440, 645), (395, 640), (300, 585), (230, 520)],
}
NECKS = {'left': (610, 600), 'right': (520, 590)}
KEEP = 70    # how far above the pivot the body keeps its neck
REACH = 60   # how far below the pivot the head reaches down over the body


def cut(path, name):
    src = Image.open(path).convert('RGBA')
    flat = Image.new('RGBA', src.size, 'white')  # the source may already be transparent
    flat.alpha_composite(src)
    solid = ImageChops.invert(flat.convert('L'))

    # carry the bottom of the torso down
    bottom = solid.point(lambda v: 255 if v > 128 else 0).getbbox()[3] - 4
    row = solid.crop((0, bottom, solid.width, bottom + 1))
    for y in range(bottom, solid.height):
        solid.paste(row, (0, y))

    scale = WIDTH / src.width
    alpha = solid.resize((WIDTH, round(src.height * scale)), Image.LANCZOS)
    w, h = alpha.size
    nx, ny = (v * scale for v in NECKS[name])
    outline = [(x * scale, y * scale) for x, y in HEADS[name]]

    # the head: its outline, plus the neck below the pivot
    head_mask = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(head_mask)
    draw.polygon(outline, fill=255)
    draw.rectangle((nx - 90 * scale, ny - KEEP * scale, nx + 90 * scale, ny + REACH * scale), fill=255)

    # the body loses only the head above its neck
    cut_mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(cut_mask).polygon(outline, fill=255)
    ImageDraw.Draw(cut_mask).rectangle((0, ny - KEEP * scale, w, h), fill=0)

    black = Image.new('RGBA', (w, h), (0, 0, 0, 255))
    head, body = black.copy(), black.copy()
    head.putalpha(ImageChops.multiply(alpha, head_mask))
    body.putalpha(ImageChops.multiply(alpha, ImageChops.invert(cut_mask)))
    head.save(OUT / f'{name}-head.png', optimize=True)
    body.save(OUT / f'{name}-body.png', optimize=True)


OUT.mkdir(exist_ok=True)
cut(sys.argv[1], 'left')
cut(sys.argv[2], 'right')
