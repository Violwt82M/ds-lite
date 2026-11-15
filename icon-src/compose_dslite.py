from PIL import Image, ImageDraw, ImageFont
import os

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'out2')
os.makedirs(OUT, exist_ok=True)

BLUE = (77, 107, 254)
WHITE = (255, 255, 255)
SIZE = 1024

def font(size):
    for name in ['arialbd.ttf', 'segoeuib.ttf', 'seguisb.ttf']:
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()

canvas = Image.new('RGB', (SIZE, SIZE), BLUE)
draw = ImageDraw.Draw(canvas)

# 两行居中：DS 大字 + Lite 小字
f_big = font(430)
f_small = font(170)

big_bbox = draw.textbbox((0, 0), 'DS', font=f_big)
small_bbox = draw.textbbox((0, 0), 'Lite', font=f_small)
big_w, big_h = big_bbox[2] - big_bbox[0], big_bbox[3] - big_bbox[1]
small_w, small_h = small_bbox[2] - small_bbox[0], small_bbox[3] - small_bbox[1]

gap = 10
total_h = big_h + gap + small_h
top = (SIZE - total_h) // 2

draw.text(((SIZE - big_w) // 2 - big_bbox[0], top - big_bbox[1]), 'DS', font=f_big, fill=WHITE)
draw.text(
    ((SIZE - small_w) // 2 - small_bbox[0], top + big_h + gap - small_bbox[1]),
    'Lite',
    font=f_small,
    fill=WHITE,
)

canvas.save(os.path.join(BASE, 'dslite-1024.png'))

densities = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for name, px in densities.items():
    d = os.path.join(OUT, 'mipmap-' + name)
    os.makedirs(d, exist_ok=True)
    square = canvas.resize((px, px), Image.LANCZOS)
    square.save(os.path.join(d, 'ic_launcher.png'))

    round_img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    mask = Image.new('L', (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
    mask = mask.resize((px, px), Image.LANCZOS)
    round_img.paste(square, (0, 0), mask)
    round_img.save(os.path.join(d, 'ic_launcher_round.png'))

    # 自适应前景：透明底 + 白色文字，缩进安全区
    fg_px = int(px * 108 / 48)
    fg = Image.new('RGBA', (fg_px, fg_px), (0, 0, 0, 0))
    art_px = int(fg_px * 0.66)
    art = canvas.resize((art_px, art_px), Image.LANCZOS)
    # 把前景里的蓝底抠掉，只留白字
    art = art.convert('RGBA')
    pixels = art.load()
    for y in range(art_px):
        for x in range(art_px):
            r, g, b, a = pixels[x, y]
            if abs(r - BLUE[0]) < 40 and abs(g - BLUE[1]) < 40 and abs(b - BLUE[2]) < 40:
                pixels[x, y] = (0, 0, 0, 0)
    off = (fg_px - art_px) // 2
    fg.paste(art, (off, off), art)
    fg.save(os.path.join(d, 'ic_launcher_foreground.png'))

canvas.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'icon-512.png'))
print('ds lite icons written to ' + OUT)
