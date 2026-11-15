from PIL import Image, ImageDraw, ImageFont
import numpy as np
import os

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'out')
os.makedirs(OUT, exist_ok=True)

BLUE = (77, 107, 254)
SIZE = 1024

src = Image.open(os.path.join(BASE, 'whale-1024.png')).convert('RGB')
arr = np.array(src)
mask = arr.min(axis=2) < 240
ys, xs = np.where(mask)
whale = src.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))

canvas = Image.new('RGB', (SIZE, SIZE), (255, 255, 255))
target_w = int(SIZE * 0.78)
target_h = int(whale.height * target_w / whale.width)
whale = whale.resize((target_w, target_h), Image.LANCZOS)
top = int(SIZE * 0.07)
canvas.paste(whale, ((SIZE - target_w) // 2, top))

draw = ImageDraw.Draw(canvas)
font = None
for name in ['arialbd.ttf', 'segoeuib.ttf', 'seguisb.ttf']:
    try:
        font = ImageFont.truetype(name, int(SIZE * 0.20))
        break
    except Exception:
        continue
if font is None:
    font = ImageFont.load_default()

text = 'api'
bbox = draw.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
tx = (SIZE - tw) // 2 - bbox[0]
ty = SIZE - int(SIZE * 0.10) - th - bbox[1]
draw.text((tx, ty), text, font=font, fill=BLUE)

canvas.save(os.path.join(BASE, 'base-1024.png'))

# Android 各密度（legacy 方形 + 圆形）
densities = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for name, px in densities.items():
    d = os.path.join(OUT, 'mipmap-' + name)
    os.makedirs(d, exist_ok=True)
    square = canvas.resize((px, px), Image.LANCZOS)
    square.save(os.path.join(d, 'ic_launcher.png'))

    round_img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    mask_img = Image.new('L', (px * 4, px * 4), 0)
    ImageDraw.Draw(mask_img).ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
    mask_img = mask_img.resize((px, px), Image.LANCZOS)
    round_img.paste(square, (0, 0), mask_img)
    round_img.save(os.path.join(d, 'ic_launcher_round.png'))

    # 自适应图标前景：108dp 画布，内容控制在安全区（约 66%~72%）
    fg_px = int(px * 108 / 48)
    fg = Image.new('RGBA', (fg_px, fg_px), (0, 0, 0, 0))
    art_px = int(fg_px * 0.72)
    art = canvas.resize((art_px, art_px), Image.LANCZOS)
    off = (fg_px - art_px) // 2
    fg.paste(art, (off, off))
    fg.save(os.path.join(d, 'ic_launcher_foreground.png'))

canvas.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'icon-512.png'))
print('icons written to ' + OUT)
