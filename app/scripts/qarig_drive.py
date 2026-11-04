"""qarig's drive client (#232): talks to a live app's drive socket (`VIMSTORM_DRIVE`, the shots
build's `app/src/devtools/drive.rs`), one JSON line each way, and keeps the env's drive log.

  ask(sock, request, timeout)   one request, its answer (a dict)
  log(d, kind, arg, answer, ms) one line in <env>/logs/drive.log
  seen_text(answer, parts)      a `see` answer as text blocks (`== main` … the outline)
"""

import json
import socket
import time
from pathlib import Path

PARTS = ("view", "title", "main", "chat", "pane", "review", "layer", "status", "balloons", "terminal")
TREES = ("main", "chat", "pane", "review", "layer")


class DriveError(Exception):
    pass


def ask(sock, request, timeout=120):
    """Sends one request to the live app at `sock` and returns its answer (`ok` false when the
    app refused it); DriveError when nothing answers."""
    request = dict(request, v=1)
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(timeout)
    try:
        s.connect(str(sock))
    except OSError as e:
        s.close()
        raise DriveError(f"no live app on {sock} ({e.strerror or e})") from None
    try:
        s.sendall((json.dumps(request) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(1 << 16)
            if not chunk:
                raise DriveError(f"the live app on {sock} hung up (quit or crashed)")
            buf += chunk
    except socket.timeout:
        raise DriveError(f"no answer from {sock} in {timeout}s") from None
    finally:
        s.close()
    try:
        return json.loads(buf)
    except json.JSONDecodeError:
        raise DriveError(f"not JSON from {sock}: {buf[:200]!r}") from None


def answers(sock):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(1)
    try:
        s.connect(str(sock))
        return True
    except OSError:
        return False
    finally:
        s.close()


def stamp():
    t = time.time()
    return time.strftime("%H:%M:%S", time.localtime(t)) + f".{int(t * 1000) % 1000:03d}"


def log(d, kind, arg, answer, ms):
    """`<time>\t<kind>\t<arg>\t<ok|error>\t<ms>` in <env>/logs/drive.log: the record of every key
    a tester sent (nothing pressed outside it)."""
    f = Path(d) / "logs/drive.log"
    f.parent.mkdir(parents=True, exist_ok=True)
    result = "ok" if answer.get("ok") else f"FAIL {answer.get('error', '?')}"
    arg = str(arg).replace("\t", " ").replace("\n", "⏎")
    with open(f, "a") as out:
        out.write(f"{stamp()}\t{kind}\t{arg}\t{result}\t{ms}\n")


def seen_text(answer, parts=()):
    """A `see` answer as text: `== <part>` then its text, the parts asked (none: all) in order."""
    want = [p for p in PARTS if not parts or p in parts]
    out = []
    for p in want:
        if p in TREES:
            text = (answer.get("trees") or {}).get(p)
            if text is None:
                continue
            out.append(f"== {p}")
            out.append(text.rstrip("\n") if text else "(empty)")
        elif p == "terminal":
            if p not in answer:
                continue
            out.append("== terminal")
            out.append(answer[p] or "(hidden)")
        elif p in ("status", "balloons"):
            if p not in answer:
                continue
            out.append(f"== {p}")
            out.extend(answer[p] or ["(none)"])
        elif p in answer:
            out.append(f"== {p}: {answer[p]}")
    return "\n".join(out) + "\n"


def parse_ms(text):
    """`90`, `90s`, `10m`, `500ms`, `1h` -> ms."""
    t = str(text).strip()
    for suffix, mul in (("ms", 1), ("s", 1000), ("m", 60_000), ("h", 3_600_000)):
        if t.endswith(suffix) and t[: -len(suffix)].replace(".", "", 1).isdigit():
            return int(float(t[: -len(suffix)]) * mul)
    if t.isdigit():
        return int(t) * 1000  # bare seconds
    raise ValueError(f"not a time: {text!r} (90s, 10m, 500ms)")
