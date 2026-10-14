"""Draws the add-on's icon.png (128px) and logo.png (256px) to match web/public/icon.svg.

Run from the budget folder: python scripts/make_icon.py  (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SCALE = 8  # draw large, then downsample for smooth edges
BASE = 128
ROOT = Path(__file__).resolve().parent.parent


def font(size: int) -> ImageFont.FreeTypeFont:
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def draw() -> Image.Image:
    s = SCALE
    size = BASE * s
    top, bottom = (0x14, 0xB8, 0xA6), (0x0F, 0x76, 0x6E)
    gradient = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(gradient)
    for y in range(size):
        t = y / (size - 1)
        gd.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=28 * s, fill=255)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    img.paste(gradient, (0, 0), mask)

    d = ImageDraw.Draw(img)
    for x, y, h in ((26, 76, 24), (52, 64, 36), (78, 52, 48)):
        d.rounded_rectangle([x * s, y * s, (x + 18) * s, (y + h) * s], radius=4 * s, fill="#ffffff")
    cx, cy, r = 87 * s, 32 * s, 16 * s
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill="#fbbf24", outline="#d97706", width=3 * s)
    d.text((cx, cy), "$", font=font(20 * s), fill="#78350f", anchor="mm")
    return img


if __name__ == "__main__":
    big = draw()
    big.resize((128, 128), Image.LANCZOS).save(ROOT / "icon.png")
    big.resize((256, 256), Image.LANCZOS).save(ROOT / "logo.png")
    print("wrote icon.png and logo.png")
