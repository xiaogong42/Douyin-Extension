# -*- coding: utf-8 -*-
# 生成插件图标：抖音红圆底 + 白色表针（表针指向 12 点和 3 点，像时钟）
# 不依赖任何第三方库，直接手工拼 PNG 文件的字节
import struct
import zlib
import math
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT_DIR, exist_ok=True)


# 计算点 (x, y) 到线段 (x1,y1)-(x2,y2) 的最短距离，用来画表针
def seg_dist(x, y, x1, y1, x2, y2):
    vx, vy = x2 - x1, y2 - y1
    wx, wy = x - x1, y - y1
    # 线段长度平方为 0 的保护
    if vx * vx + vy * vy == 0:
        return math.hypot(x - x1, y - y1)
    # 求垂足在线段上的比例 t，并限制在 [0,1]
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    # 垂足坐标
    px, py = x1 + t * vx, y1 + t * vy
    return math.hypot(x - px, y - py)


def create_icon(size, path):
    cx = cy = size / 2.0
    r = size * 0.46  # 圆底半径
    hl = r * 0.55  # 表针长度
    hw = size * 0.05  # 表针粗细

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            d = math.hypot(px - cx, py - cy)
            if d <= r:
                # 圆底：抖音红
                color = (254, 44, 85, 255)
                # 表针1：从圆心向上（指 12 点）
                if seg_dist(px, py, cx, cy, cx, cy - hl) < hw:
                    color = (255, 255, 255, 255)
                # 表针2：从圆心向右（指 3 点）
                if seg_dist(px, py, cx, cy, cx + hl, cy) < hw:
                    color = (255, 255, 255, 255)
            else:
                # 圆外：透明
                color = (0, 0, 0, 0)
            row.extend(color)
        # 每行开头加一个 0（PNG 的 filter 类型字节）
        rows.append(b"\x00" + bytes(row))

    raw = b"".join(rows)


    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path)


for s in (16, 48, 128):
    create_icon(s, os.path.join(OUT_DIR, "icon%d.png" % s))
