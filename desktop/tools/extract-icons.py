"""Extract the supplied rounded tiles without regenerating their artwork.

Requires Pillow. Contours follow the four original 1254px illustrations.
Only alpha is changed; RGB pixels inside the contour remain original.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "design" / "branding"
OUTPUT = ROOT / "web" / "assets" / "branding"


def bezier(points, steps=160):
    a, b, c, d = points
    for i in range(steps + 1):
        t = i / steps
        s = 1 - t
        yield tuple(s**3*a[j] + 3*s*s*t*b[j] + 3*s*t*t*c[j] + t**3*d[j] for j in (0, 1))


def contour(name):
    if name.startswith("glass"):
        # The glass tile has gently bowed sides, rather than a circular corner.
        left, top, right, bottom = (105, 85, 1149, 1136)
        cx = (left + right) / 2
        curves = [
            [(cx, top), (350, top), (248, top+1), (177, 155)],
            [(177, 155), (111, 218), (left, 280), (left, 435)],
            [(left, 435), (left, 580), (left, 690), (left, 813)],
            [(left, 813), (left, 1000), (114, 1050), (180, 1093)],
            [(180, 1093), (245, bottom), (335, bottom), (cx, bottom)],
        ]
        points = [p for curve in curves for p in bezier(curve)]
        points += [(2*cx-x, y) for x, y in reversed(points)]
        return points, (left-1, top-1, right+2, bottom+2)
    # These are the same tile shape in the two illustrated variants.
    left, top, right, bottom = ((116, 116, 1139, 1139) if name.endswith("light")
                                else (111, 112, 1143, 1142))
    radius = 248
    k = .64
    points = []
    corners = [
        [(left+radius, top), (left+radius*(1-k), top), (left, top+radius*(1-k)), (left, top+radius)],
        [(left, bottom-radius), (left, bottom-radius*(1-k)), (left+radius*(1-k), bottom), (left+radius, bottom)],
        [(right-radius, bottom), (right-radius*(1-k), bottom), (right, bottom-radius*(1-k)), (right, bottom-radius)],
        [(right, top+radius), (right, top+radius*(1-k)), (right-radius*(1-k), top), (right-radius, top)],
    ]
    for curve in corners:
        points.extend(bezier(curve))
    return points, (left-1, top-1, right+2, bottom+2)


for name in ("glass-light", "glass-dark", "illustrated-light", "illustrated-dark"):
    original = Image.open(SOURCE / f"{name}.png").convert("RGBA")
    assert original.size == (1254, 1254), "Contour requires the supplied source dimensions"
    polygon, bounds = contour(name)
    scale = 4
    mask = Image.new("L", (original.width*scale, original.height*scale))
    ImageDraw.Draw(mask).polygon([(round(x*scale), round(y*scale)) for x, y in polygon], fill=255)
    mask = mask.resize(original.size, Image.Resampling.LANCZOS)
    original.putalpha(mask)
    cropped = original.crop(bounds)
    size = max(cropped.size)
    result = Image.new("RGBA", (size, size))
    result.paste(cropped, ((size-cropped.width)//2, (size-cropped.height)//2))
    result.save(OUTPUT / f"{name}.png")
    assert result.getpixel((0, 0))[3] == 0
    print(f"{name}: {result.size}, transparent corners, original artwork")
