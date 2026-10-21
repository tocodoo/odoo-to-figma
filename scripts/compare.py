# Side-by-side crops (original | preview) + global diff score. Usage: python3 scripts/compare.py prefix [y0 y1 ...]
import sys
from PIL import Image, ImageChops, ImageStat
pre = sys.argv[1]
a = Image.open(pre + '-original.png').convert('RGB'); b = Image.open(pre + '-preview.png').convert('RGB')
h = min(a.height, b.height); W = a.width
d = ImageChops.difference(a.crop((0,0,W,h)), b.crop((0,0,W,h)))
print('mean abs diff per channel:', [round(x,2) for x in ImageStat.Stat(d).mean])
step = 900
rows = []
for y in range(0, h, step):
    s = ImageStat.Stat(d.crop((0, y, W, min(h, y+step)))).mean
    rows.append((round(sum(s)/3,2), y))
print('worst bands:', sorted(rows, reverse=True)[:6])
ys = [int(v) for v in sys.argv[2:]] or [0]
for y in ys:
    ca = a.crop((0, y, W, min(h, y+step))); cb = b.crop((0, y, W, min(h, y+step)))
    out = Image.new('RGB', (W*2+10, ca.height), (255,0,0)); out.paste(ca, (0,0)); out.paste(cb, (W+10, 0))
    out = out.resize((out.width//2, out.height//2))
    out.save(f'{pre}-cmp-{y}.png'); print('saved', f'{pre}-cmp-{y}.png')
