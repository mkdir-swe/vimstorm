#!/usr/bin/env python3
"""qarig diff: read a film without looking at every frame.

  qarig diff <env> <label>      /tmp/qr/<env>/shots/<label>/
  qarig diff <dir>              any folder holding <label>-NNNN.png (+ <label>-frames.tsv)

Writes <label>-diff.tsv (one row per frame: changed pixels, bounding box, shift, flags, last step)
and <label>-sheet.png (numbered thumbnails, flagged frames red-framed), prints the flagged frames.
Pixels are PNG pixels (a shot is 2x: logical px = PNG px / 2). Python 3 standard library plus
macOS's `sips` (PNG -> BMP and thumbnails): no other dependency.

Flags: shift (a block of rows reappears displaced vertically: a card jumping), flicker (a region
changes and is back to what it was within 3 frames), async-big (a large change with no key step
just before it: something moved on its own).
"""

import argparse
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from collections import Counter
from pathlib import Path

CHUNK = 64  # pixels compared at once before looking at single ones
BANDS = 16  # column bands the shift detection hashes rows in
SHEET_MAX = 1568  # a larger image is scaled down when read: keep the sheet under it


def die(msg):
    print(f"qarig diff: {msg}", file=sys.stderr)
    sys.exit(1)


# ---- frames -------------------------------------------------------------------------------


class Frame:
    """One film frame: `rows` are bytes of 4-byte pixels (BMP order), `w` x `h`."""

    def __init__(self, rows, w, h, order):
        self.rows, self.w, self.h, self.order = rows, w, h, order  # order: byte index of r, g, b


def sips(src, out, size=None):
    cmd = ["sips", "-s", "format", "bmp"]
    if size:
        cmd += ["-z", str(size[1]), str(size[0])]  # height width
    r = subprocess.run(cmd + [str(src), "--out", str(out)], capture_output=True)
    if r.returncode != 0:
        die(f"sips failed on {src}: {r.stderr.decode(errors='replace').strip()}")


def read_bmp(path):
    d = Path(path).read_bytes()
    off, = struct.unpack_from("<I", d, 10)
    w, h, _planes, bpp, comp = struct.unpack_from("<iiHHI", d, 18)
    if bpp != 32:
        die(f"{path}: expected a 32-bit bmp from sips, got {bpp}")
    order = (0, 1, 2)
    if comp == 3:  # BITFIELDS: the masks say which byte is which
        masks = struct.unpack_from("<III", d, 54)
        order = tuple(m.bit_length() // 8 - 1 for m in masks)  # r, g, b byte positions
    rs = w * 4
    ah = abs(h)
    rows = [d[off + y * rs : off + (y + 1) * rs] for y in range(ah)]
    if h > 0:
        rows.reverse()  # bottom-up
    return Frame(rows, w, ah, order)


def mask(frame, rects):
    for x0, y0, x1, y1 in rects:
        z = bytes((min(x1, frame.w) - x0) * 4)
        for y in range(y0, min(y1, frame.h)):
            r = bytearray(frame.rows[y])
            r[x0 * 4 : min(x1, frame.w) * 4] = z
            frame.rows[y] = bytes(r)


class Film:
    """The frames of one film, decoded on demand (a few kept: they are ~20 MB each)."""

    def __init__(self, files, ignore, tmp):
        self.files, self.ignore, self.tmp, self.cache = files, ignore, tmp, {}

    def __len__(self):
        return len(self.files)

    def get(self, i):
        if i not in self.cache:
            for k in [k for k in self.cache if k < i - 6]:
                del self.cache[k]
            bmp = Path(self.tmp) / "f.bmp"
            sips(self.files[i], bmp)
            f = read_bmp(bmp)
            mask(f, self.ignore)
            self.cache[i] = f
        return self.cache[i]


# ---- one pair -----------------------------------------------------------------------------


def changed_pixels(a, b):
    """(count, bbox x0,y0,x1,y1 inclusive or None, changed rows) of two frames' pixels."""
    n, bx0, by0, bx1, by1, rows = 0, a.w, None, -1, -1, []
    step = CHUNK * 4
    for y, (ra, rb) in enumerate(zip(a.rows, b.rows)):
        if ra == rb:
            continue
        rows.append(y)
        for s in range(0, a.w * 4, step):
            ca, cb = ra[s : s + step], rb[s : s + step]
            if ca == cb:
                continue
            d = [i for i, (p, q) in enumerate(zip(memoryview(ca).cast("I"), memoryview(cb).cast("I"))) if p != q]
            n += len(d)
            x = s // 4
            bx0, bx1 = min(bx0, x + d[0]), max(bx1, x + d[-1])
        if by0 is None:
            by0 = y
        by1 = y
    return n, (None if by0 is None else (bx0, by0, bx1, by1)), rows


def find_shifts(a, b, rows, min_rows):
    """Blocks of rows of b that are rows of a displaced vertically: [(dy, y0, y1, n)], dy > 0 down.
    Rows are hashed in column bands (a card moves, the sidebar beside it does not) and only rows
    that occur at most 3 times count (the background is everywhere and proves nothing)."""
    if len(rows) < min_rows:
        return []
    bw = (a.w + BANDS - 1) // BANDS
    votes = {}  # dy -> set of y (in b)
    for k in range(BANDS):
        s, e = k * bw * 4, min((k + 1) * bw, a.w) * 4
        mine = [y for y in rows if a.rows[y][s:e] != b.rows[y][s:e]]
        if not mine:
            continue
        ha = {}
        for y, r in enumerate(a.rows):
            ha.setdefault(hash(r[s:e]), []).append(y)
        hb = Counter(hash(r[s:e]) for r in b.rows)
        for y in mine:
            h = hash(b.rows[y][s:e])
            cand = ha.get(h)
            if not cand or len(cand) > 3 or hb[h] > 3:
                continue
            for ya in cand:
                if ya != y:
                    votes.setdefault(y - ya, set()).add(y)
    runs = []
    for dy, ys in votes.items():
        ys = sorted(ys)
        start = prev = ys[0]
        n = 1
        for y in ys[1:] + [None]:
            if y is not None and y - prev <= 80:  # blank space between text lines
                prev, n = y, n + 1
                continue
            if n >= min_rows:
                runs.append((dy, start, prev, n))
            if y is not None:
                start = prev = y
                n = 1
    runs.sort(key=lambda r: -r[3])
    taken, out = [], []
    for dy, y0, y1, n in runs:  # the biggest first; a weaker run on the same rows is a coincidence
        over = sum(max(0, min(y1, t1) - max(y0, t0) + 1) for t0, t1 in taken)
        if over * 2 > (y1 - y0 + 1):
            continue
        taken.append((y0, y1))
        out.append((dy, y0, y1, n))
    return sorted(out, key=lambda r: r[1])


def same_region(a, b, box):
    x0, y0, x1, y1 = box
    return all(a.rows[y][x0 * 4 : (x1 + 1) * 4] == b.rows[y][x0 * 4 : (x1 + 1) * 4] for y in range(y0, y1 + 1))


# ---- the sheet ----------------------------------------------------------------------------

FONT = {
    "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
    "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001001001001",
    "8": "111101111101111", "9": "111101111001111",
}  # fmt: skip


def png_write(path, w, h, rows):
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    raw = b"".join(b"\0" + bytes(r) for r in rows)
    Path(path).write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    )


def make_sheet(film, flagged, out, cols, fw, fh, tmp, nums):
    n = len(film)
    best = None
    for c in range(1, n + 1):  # the grid whose cells come out biggest within SHEET_MAX
        cw = min((SHEET_MAX - 4) // c - 4, 420)
        if cw < 40:
            break
        ch = cw * fh // fw
        r = (n + c - 1) // c
        if r * (ch + 4) + 4 <= SHEET_MAX and (best is None or cw > best[1]):
            best = (c, cw, ch)
    if cols:
        c = cols
        cw = min((SHEET_MAX - 4) // c - 4, 420)
        best = (c, cw, cw * fh // fw)
    if best is None:
        best = (12, SHEET_MAX // 12 - 4, (SHEET_MAX // 12 - 4) * fh // fw)
    c, cw, ch = best
    r = (n + c - 1) // c
    W, H = c * (cw + 4) + 4, r * (ch + 4) + 4
    canvas = [bytearray(b"\x30\x30\x34" * W) for _ in range(H)]
    for i, png in enumerate(film.files):
        bmp = Path(tmp) / "t.bmp"
        sips(png, bmp, (cw, ch))
        t = read_bmp(bmp)
        ri, gi, bi = t.order
        ox, oy = 4 + (i % c) * (cw + 4), 4 + (i // c) * (ch + 4)
        red = i in flagged
        for y in range(min(ch, t.h)):
            row = t.rows[y]
            px = bytearray(t.w * 3)
            px[0::3], px[1::3], px[2::3] = row[ri::4], row[gi::4], row[bi::4]
            canvas[oy + y][ox * 3 : (ox + t.w) * 3] = px
        if red:  # a red frame round the flagged
            col = b"\xe0\x30\x30"
            for k in range(3):
                canvas[oy + k][ox * 3 : (ox + cw) * 3] = col * cw
                canvas[oy + ch - 1 - k][ox * 3 : (ox + cw) * 3] = col * cw
                for y in range(oy, oy + ch):
                    canvas[y][(ox + k) * 3 : (ox + k + 1) * 3] = col
                    canvas[y][(ox + cw - 1 - k) * 3 : (ox + cw - k) * 3] = col
        label = str(nums[i])
        sc = 3
        lw, lh = (len(label) * 4 + 1) * sc, 7 * sc
        bg = b"\xe0\x30\x30" if red else b"\x10\x10\x10"
        for y in range(lh):
            canvas[oy + y][ox * 3 : (ox + lw) * 3] = bg * lw
        for d, chx in enumerate(label):
            for k, bit in enumerate(FONT[chx]):
                if bit == "1":
                    px0, py0 = (1 + d * 4 + k % 3) * sc, (1 + k // 3) * sc
                    for yy in range(sc):
                        canvas[oy + py0 + yy][(ox + px0) * 3 : (ox + px0 + sc) * 3] = b"\xff\xff\xff" * sc
    png_write(out, W, H, canvas)
    return W, H, c


# ---- the film -----------------------------------------------------------------------------


def read_tsv(tsv):
    """([(png name, ms)], [(ms, step text)]) from <label>-frames.tsv."""
    frames, steps = [], []
    for line in Path(tsv).read_text().splitlines():
        p = line.split("\t")
        if p[0] == "frame" and len(p) >= 3:
            frames.append((p[1], int(p[2])))
        elif p[0] == "step" and len(p) >= 3:
            steps.append((int(p[1]), p[2]))
    return frames, steps


def nums_of(named):
    """The number in each PNG's name (<label>-0031.png -> 31), else its place in the film."""
    out = []
    for i, (n, _) in enumerate(named):
        tail = n.rsplit("-", 1)[-1][:4]
        out.append(int(tail) if tail.isdigit() else i + 1)
    return out


def analyse(folder, label, a):
    folder = Path(folder)
    tsv = folder / f"{label}-frames.tsv"
    if tsv.exists():
        named, steps = read_tsv(tsv)
        named = [(n, ms) for n, ms in named if (folder / n).exists()]
    else:
        named, steps = [(p.name, i * 100) for i, p in enumerate(sorted(folder.glob(f"{label}-[0-9][0-9][0-9][0-9].png")))], []
    if len(named) < 2:
        die(f"{folder}: fewer than two frames of {label}")
    files = [folder / n for n, _ in named]
    ms = [m for _, m in named]
    ignore = [tuple(int(v) for v in r.split(",")) for r in a.ignore]
    tmp = tempfile.mkdtemp(prefix="qarig-diff-")
    try:
        film = Film(files, ignore, tmp)
        first = film.get(0)
        w, h = first.w, first.h
        keysteps = [(m, s) for m, s in steps if not s.startswith("Wait(")]

        def last_step(t):
            before = [(m, s) for m, s in steps if m <= t]
            return before[-1] if before else None

        def last_key(t):
            before = [(m, s) for m, s in keysteps if m <= t]
            return before[-1] if before else None

        rows_out, flags, changes = [], {}, {}  # changes: frame -> bbox of a change worth watching
        flicker = []
        for i in range(1, len(film)):
            pa, pb = film.get(i - 1), film.get(i)
            n, box, rows = changed_pixels(pa, pb)
            shifts, fl = [], []
            if n >= a.min_px:
                changes[i] = box
                shifts = find_shifts(pa, pb, rows, a.shift_rows)
                for dy, y0, y1, c in shifts:
                    if abs(dy) >= a.shift_min:
                        fl.append(f"shift dy={dy:+d} rows {y0}..{y1}")
                # a region that appeared and is gone again within 3 frames
                for j in range(i + 1, min(i + 4, len(film))):
                    if same_region(film.get(j), pa, box) and not same_region(film.get(j), pb, box):
                        flicker.append((i, j - 1, box))
                        fl.append(f"flicker: region {box[0]},{box[1]}..{box[2]},{box[3]} is back as it was {j - i} frame(s) later")
                        break
                pct = 100.0 * n / (w * h)
                k = last_key(ms[i])
                if pct >= a.big and (k is None or ms[i] - k[0] > a.settle):
                    fl.append(f"async-big {pct:.0f}% of the frame, last key step {'none' if k is None else str(ms[i] - k[0]) + ' ms ago'}")
            ls = last_step(ms[i])
            rows_out.append((i, n, box, shifts, fl, ls))
            if fl:
                flags[i] = fl
        tsvp = folder / f"{label}-diff.tsv"
        with open(tsvp, "w") as f:
            f.write("frame\tms\tdt\tchanged_px\tpct\tbbox\tshift\tflags\tlast_step\n")
            f.write(f"{named[0][0]}\t{ms[0]}\t\t\t\t\t\t\t{(last_step(ms[0]) or ('', ''))[1]}\n")
            for i, n, box, shifts, fl, ls in rows_out:
                quiet = "quiet" if 0 < n < a.min_px else ""
                bb = "" if box is None else f"{box[0]},{box[1]},{box[2]},{box[3]}"
                sh = ";".join(f"dy={dy:+d} rows {y0}..{y1}" for dy, y0, y1, c in shifts)
                f.write(
                    f"{named[i][0]}\t{ms[i]}\t{ms[i] - ms[i - 1]}\t{n}\t{100.0 * n / (w * h):.2f}\t{bb}\t{sh}\t{' | '.join(fl) or quiet}\t{(ls or ('', ''))[1]}\n"
                )
        sheetp = None
        if not a.no_sheet:
            sheetp = folder / f"{label}-sheet.png"
            make_sheet(film, set(flags) | {i - 1 for i in flags}, sheetp, a.cols, w, h, tmp, nums_of(named))
        return named, ms, w, h, rows_out, flags, tsvp, sheetp
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run(a):
    if a.second:
        env = Path(os.environ.get("QARIG_ROOT", "/tmp/qr")) / a.first
        label = a.second
        folder = env / "shots" / label
        if not folder.is_dir():
            folder = env / "shots"
    else:
        folder = Path(a.first)
        if not folder.is_dir():
            die(f"{folder} is not a folder (qarig diff <env> <label> | <dir>)")
        tsvs = sorted(folder.glob("*-frames.tsv"))
        if len(tsvs) == 1:
            label = tsvs[0].name[: -len("-frames.tsv")]
        elif a.label:
            label = a.label
        else:
            die(f"{folder}: {len(tsvs)} films there, say which: --label <label>")
    if not shutil.which("sips"):
        die("macOS's sips is needed to decode the PNGs")
    named, ms, w, h, rows, flags, tsvp, sheetp = analyse(folder, label, a)
    nums = nums_of(named)
    print(f"film {label}: {len(named)} frames {w}x{h} PNG px (click coords = px / 2), {ms[-1] - ms[0]} ms")
    quiet = sum(1 for _, n, *_ in rows if n == 0)
    print(f"{quiet} pairs identical, {len(rows) - quiet - len(flags)} changed without a flag")
    if flags:
        print("flagged (frames as in the file names):")
        for i, fl in sorted(flags.items()):
            n, box = next((n, b) for j, n, b, *_ in rows if j == i)
            ls = next(l for j, *_, l in rows if j == i)
            for f in fl:
                print(f"  {nums[i - 1]:04d}->{nums[i]:04d} {f} ({n} px changed, {ms[i]} ms, last step {ls[1] if ls else '-'})")
    else:
        print("nothing flagged")
    print(f"table {tsvp}")
    print(f"sheet {sheetp} (cell numbers = the frame numbers of the file names, left to right, top to bottom; red = flagged)" if sheetp else "sheet not made")


def add_args(p):
    p.add_argument("first", help="<env> or a folder")
    p.add_argument("second", nargs="?", help="<label>")
    p.add_argument("--label", help="with a folder holding several films")
    p.add_argument("--min-px", type=int, default=200, help="a pair that changes fewer PNG px than this is quiet (caret blink); default 200")
    p.add_argument("--ignore", action="append", default=[], metavar="x0,y0,x1,y1", help="PNG-px rectangle to mask in every frame (a clock, a spinner); repeatable")
    p.add_argument("--shift-min", type=int, default=8, help="flag a shift of at least this many PNG px; default 8")
    p.add_argument("--shift-rows", type=int, default=40, help="a shift needs this many matching rows; default 40")
    p.add_argument("--big", type=float, default=3.0, help="percent of the frame that counts as a large change; default 3")
    p.add_argument("--settle", type=int, default=500, help="ms after a key step in which a large change is expected; default 500")
    p.add_argument("--cols", type=int, help="contact sheet columns (default: the biggest cells that fit)")
    p.add_argument("--no-sheet", action="store_true")


def main():
    p = argparse.ArgumentParser(prog="qarig diff", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_args(p)
    run(p.parse_args())


if __name__ == "__main__":
    main()
