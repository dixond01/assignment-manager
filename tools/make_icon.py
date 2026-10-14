"""Draw the Assignment Manager icon (spiral checklist planner with sparkles) and write .ico + .png.
The backdrop is transparent so the taskbar/tab color shows through. The icon paints only with four
theme roles (PAGE_FILL, PRIMARY, SECONDARY, TERTIARY) so user themes can recolor it later.
Pure standard library: shapes are signed-distance tests, anti-aliased by supersampling."""
import math
import struct
import sys
import zlib
from pathlib import Path

PAGE_FILL = (0xFF, 0xFF, 0xFF)  # planner paper
PRIMARY = (0x00, 0x2E, 0x5D)  # page outline, checkboxes (BYU navy)
SECONDARY = (0x00, 0x62, 0xB8)  # sparkles, spiral rings, unchecked item line (BYU royal)
TERTIARY = (0xB9, 0xCD, 0xE5)  # checked item lines (light BYU blue)

# Planner group (spiral rings + page) spans x 0.15-0.85, y 0.12-0.88: centered on the canvas.
PAGE = (0.24, 0.12, 0.85, 0.88)
RING_X = (0.15, 0.32)
OUTLINE = 0.035


def sd_round_rect(x, y, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    dx, dy = abs(x - cx) - hx, abs(y - cy) - hy
    return math.hypot(max(dx, 0), max(dy, 0)) + min(max(dx, dy), 0) - r


def sd_segment(x, y, ax, ay, bx, by):
    px, py, vx, vy = x - ax, y - ay, bx - ax, by - ay
    t = max(0, min(1, (px * vx + py * vy) / (vx * vx + vy * vy)))
    return math.hypot(px - vx * t, py - vy * t)


def sparkle(x, y, cx, cy, r):
    return math.sqrt(abs(x - cx)) + math.sqrt(abs(y - cy)) <= math.sqrt(r)


def sample(x, y):
    """Color at unit coordinate (x, y), or None if transparent."""
    color = None
    page = sd_round_rect(x, y, *PAGE, 0.07)
    if page <= 0:
        color = PRIMARY if page > -OUTLINE else PAGE_FILL
    # Spiral rings along the page's left edge.
    for ry in (0.25, 0.417, 0.583, 0.75):
        if sd_round_rect(x, y, RING_X[0], ry - 0.026, RING_X[1], ry + 0.026, 0.026) <= 0:
            color = SECONDARY
    # Checklist: two checked rows, one open.
    for k, ry in enumerate((0.31, 0.50, 0.69)):
        done = k < 2
        box = sd_round_rect(x, y, 0.36, ry - 0.06, 0.48, ry + 0.06, 0.026)
        if done and box <= 0:
            color = PRIMARY
            tick = min(sd_segment(x, y, 0.387, ry, 0.413, ry + 0.026), sd_segment(x, y, 0.413, ry + 0.026, 0.455, ry - 0.026))
            if tick <= 0.013:
                color = PAGE_FILL
        elif not done and abs(box + 0.008) <= 0.015:
            color = PRIMARY
        if sd_segment(x, y, 0.55, ry, 0.73, ry) <= 0.022:
            color = TERTIARY if done else SECONDARY
    # Sparkles in the open corners.
    for sx, sy, r in ((0.89, 0.10, 0.075), (0.93, 0.30, 0.035), (0.11, 0.89, 0.07)):
        if sparkle(x, y, sx, sy, r):
            color = SECONDARY
    return color


def render(size, ss=6):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)
                    if c:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            n = ss * ss
            row += bytes((r // a, g // a, b // a, round(255 * a / n)) if a else (0, 0, 0, 0))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b''.join(b'\x00' + r for r in rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def ico(images):
    header = struct.pack('<HHH', 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b'', b''
    for size, data in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs


if __name__ == '__main__':
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    images = [(s, png(s, render(s))) for s in (16, 24, 32, 48, 64, 128, 256)]
    (out / 'icon.ico').write_bytes(ico(images))
    (out / 'icon.png').write_bytes(dict(images)[256])
    print('wrote', out / 'icon.ico', out / 'icon.png')
