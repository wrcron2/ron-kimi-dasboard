#!/usr/bin/env python3
"""Render the dashboard PNG icons (512/192/180) with stdlib only — no Pillow.
Pure geometry: rounded-rect bg, amber pulse polyline, green online dot.
Run from the repo root:  python3 mac-agent/render_icons.py
"""
import math, os, struct, zlib

BG = (11, 14, 20)
RING = (38, 46, 60)
AMBER = (232, 176, 75)
GREEN = (52, 199, 123)


def sd_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    c1 = vx * wx + vy * wy
    c2 = vx * vx + vy * vy
    t = 0.0 if c2 == 0 else max(0.0, min(1.0, c1 / c2))
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return math.hypot(dx, dy)


def sd_rounded_rect(px, py, w, h, r):
    qx = abs(px - w / 2) - (w / 2 - r)
    qy = abs(py - h / 2) - (h / 2 - r)
    ax_, ay_ = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ax_, ay_) + min(max(qx, qy), 0.0) - r


PULSE = [(0.16, 0.52), (0.34, 0.52), (0.42, 0.34), (0.52, 0.70),
         (0.60, 0.44), (0.66, 0.52), (0.84, 0.52)]


def render(size, path):
    S = size * 4  # supersample
    px = bytearray(S * S * 3)

    def paint(x, y):
        fx, fy = x + 0.5, y + 0.5
        # rounded-rect background
        d_bg = sd_rounded_rect(fx, fy, S, S, S * 0.22)
        if d_bg > 0.5:
            return None
        col = list(BG)
        # inner hairline ring
        d_ring = abs(sd_rounded_rect(fx, fy, S - 2 * S * 0.045, S - 2 * S * 0.045, S * 0.19))
        if d_ring < max(1.0, S / 512.0):
            col = list(RING)
        # pulse polyline
        lw = S * 0.055 / 2.0
        d_line = 1e9
        for i in range(len(PULSE) - 1):
            (x1, y1), (x2, y2) = PULSE[i], PULSE[i + 1]
            d_line = min(d_line, sd_segment(fx / S, fy / S, x1, y1, x2, y2) * S)
        # rounded caps at both ends
        for (ex, ey) in (PULSE[0], PULSE[-1]):
            d_line = min(d_line, math.hypot(fx / S - ex, fy / S - ey) * S)
        if d_line < lw:
            col = list(AMBER)
        # online dot
        cx, cy, r = 0.78 * S, 0.24 * S, 0.055 * S
        d_dot = math.hypot(fx - cx, fy - cy)
        if d_dot < r:
            col = list(GREEN)
        elif d_dot < r + 0.35 * r and d_dot > r + 0.12 * r:
            col = [int(GREEN[i] * 0.45 + BG[i] * 0.55) for i in range(3)]
        return col

    for y in range(S):
        base = y * S * 3
        for x in range(S):
            c = paint(x, y)
            if c is not None:
                px[base + x * 3: base + x * 3 + 3] = bytes(c)

    # box downsample 4x -> 1x
    out = bytearray(size * size * 3)
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0]
            for dy in range(4):
                for dx in range(4):
                    i = ((y * 4 + dy) * S + (x * 4 + dx)) * 3
                    acc[0] += px[i]; acc[1] += px[i + 1]; acc[2] += px[i + 2]
            o = (y * size + x) * 3
            out[o:o + 3] = bytes(v // 16 for v in acc)

    # PNG encode (truecolor, filter 0)
    raw = b''.join(b'\x00' + bytes(out[y * size * 3:(y + 1) * size * 3]) for y in range(size))

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'wrote {path} ({size}x{size}, {len(png)} bytes)')


if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, 'assets')
    os.makedirs(assets, exist_ok=True)
    for sz in (512, 192, 180):
        render(sz, os.path.join(assets, f'icon-{sz}.png'))
