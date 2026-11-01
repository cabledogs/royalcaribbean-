#!/usr/bin/env python3
"""Draws the launcher icon (ship on waves) -> app/src/main/res/drawable/ic_launcher.png"""
import sys
from PIL import Image, ImageDraw

S = 4 * 192
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# rounded-square gradient background
bg = Image.new("RGBA", (S, S))
for y in range(S):
    t = y / S
    c = (int(11 + (14 - 11) * t), int(58 + (154 - 58) * t), int(111 + (167 - 111) * t), 255)
    ImageDraw.Draw(bg).line([(0, y), (S, y)], fill=c)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=S // 4.5, fill=255)
img.paste(bg, (0, 0), mask)
u = S / 192
W = (255, 255, 255, 255)
# hull
d.polygon([(34 * u, 108 * u), (158 * u, 108 * u), (142 * u, 136 * u), (50 * u, 136 * u)], fill=W)
# decks
d.rounded_rectangle([56 * u, 88 * u, 140 * u, 104 * u], radius=3 * u, fill=W)
d.rounded_rectangle([70 * u, 70 * u, 126 * u, 85 * u], radius=3 * u, fill=W)
# funnel
d.polygon([(100 * u, 46 * u), (118 * u, 46 * u), (114 * u, 67 * u), (98 * u, 67 * u)], fill=(232, 87, 60, 255))
# windows
for x in range(62, 136, 12):
    d.rectangle([x * u, 93 * u, (x + 6) * u, 99 * u], fill=(14, 90, 140, 255))
# waves
for i, y in enumerate((146, 160)):
    pts = []
    for k in range(0, 193, 4):
        import math
        pts.append((k * u, (y + 4 * math.sin((k + i * 12) / 9)) * u))
    d.line(pts, fill=(255, 255, 255, 200 - i * 70), width=int(6 * u))
img = Image.composite(img, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask)
img.resize((192, 192), Image.LANCZOS).save(sys.argv[1], optimize=True)
print("icon ->", sys.argv[1])
