"""qarig's gate runner (#232, #352): runs a gate script (`tests/gate/*.md`) against one tester env's
live app, and keeps its RESULT.md (step · check · PASS/FAIL · ms · evidence).

A gate script is markdown: each `## <id> · <title>` heading is a step, its prose says what a person
would do and why, and its ```gate blocks are what the runner does, one action a line (`#` starts a
comment). The actions are qarig's own verbs, so a run presses nothing qarig does not log:

  do <keys>                       play keys (the shot grammar: {@super+alt+a}, {type:…}, …)
  type <text>                     type a text (GPUI keystrokes)
  click <x>,<y>                   a left click (logical px)
  wait <text> [in <part>] [gone] [within <time>]   CHECK: the text shows (or goes) within the time (60s)
  see <label> [part…]             evidence: the trees as text, trees/<label>.txt
  snap <label>                    evidence: a PNG, shots/<label>.png
  film <label> <frames> <every> <keys>             evidence: frames while the keys play
  run <label> <command>           CHECK: a listed read (READS: abe status, gh pr view …; no shell)
                                  exits 0; its output is evidence, runs/<label>.txt (the env's env,
                                  in its checkout)
  expect <label> <regex>          CHECK: run <label>'s output matches
  capture <var> <label> <regex>   {var} = the regex's first group in run <label>'s output
  teammate <args…>                a teammate's change (qarig teammate <env> <args…>)
  scenario <args…>                a change of the env's fakes (qarig scenario <env> <args…>: board-down,
                                  reseed, needs-you …), the world moving, not a hand fix
  judge <what>                    CHECK by the tester agent: a JUDGE row it sets with `qarig judge`
  agent <what>                    the tester agent's turn (words it chooses, keys it plays with
                                  qarig do): the run stops here; `--from <next step>` goes on
  down                            CHECK: qarig down the env; nothing of it runs after

Placeholders: {name} (the env), {repo} (its checkout), {card:N} (seed card N on this env's board:
its seed offset + N), and every `capture`d {var}. A FAIL stops the run (`--keep-going` goes on
with the next step). A `down` is SKIPped after a FAIL, even with `--keep-going`, and in a run
picked up with `--from` unless `--only` names its step: the env stays for a look and a rerun. A command outside these verbs is a hand fix: the script has no way to run one.
Keys can still reach a shell inside the app (`:!cmd` in nvim, a terminal tab): only drive.log
records those, so a script never types one and the reviewer of a gate script checks it.
"""

import json
import re
import shlex
import time
from dataclasses import dataclass, field
from pathlib import Path

VERBS = ("do", "type", "click", "wait", "see", "snap", "film", "run", "expect", "capture", "teammate", "scenario", "judge", "agent", "down")

# The reads a `run` may make: <tool> <subcommand…> prefixes. Anything else (a write, a pipe, a
# shell) would be a hand fix, so the parser refuses it.
READS = {
    "abe": (
        "status", "version", "session list", "session show", "session asks", "session transcript", "card list", "card show",
        "box list", "box status", "ui render", "settings get", "settings list", "settings problems", "settings explain",
        "prototype list", "prototype show", "pr show", "story linked", "factory status", "pipeline list", "pipeline show",
        "login status", "workspace status", "deploy status", "tools check",
    ),
    "gh": ("issue list", "issue view", "pr list", "pr view", "pr diff", "pr checks", "repo view", "run list", "run view", "api"),
    "git": ("log", "show", "diff", "status", "rev-parse", "ls-remote", "worktree list"),
}
# The only options a read may pass (by name, before any `=`): output shapes and filters. Anything
# else (`git --output`, `--upload-pack`, `gh api -X`, `-f`) could write or run something.
FLAGS = {
    "abe": {"--json", "--no-start", "--all", "--repo", "--card", "--team", "--mine"},
    "gh": {"--json", "--jq", "-q", "--state", "--limit", "-L", "--repo", "-R", "--author", "--label", "--search", "--paginate", "--name-only", "--patch", "--color"},
    "git": {"--oneline", "-n", "--max-count", "--stat", "--name-only", "--name-status", "--format", "--pretty", "--porcelain", "--short", "--heads", "--tags", "--abbrev-ref", "--no-color", "--no-patch", "-s"},
}
FIXED_VARS = ("name", "repo", "seed_offset")
LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
VAR = re.compile(r"[a-z][a-z0-9_]*")
SHELLY = set(";&|<>$`\\")
HEADING = re.compile(r"^##\s+([A-Za-z]+\d*)\s*[·:.-]\s*(.+?)\s*$")


class GateError(Exception):
    pass


@dataclass
class Action:
    verb: str
    args: list
    line: int
    text: str


@dataclass
class Step:
    id: str
    title: str
    actions: list = field(default_factory=list)


def parse(text, source="gate"):
    """The steps of a gate script; a bad line says where."""
    steps = []
    in_block = False
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        if line.strip().startswith("```"):
            fence = line.strip()[3:].strip()
            if in_block:
                in_block = False
            elif fence == "gate":
                if not steps:
                    raise GateError(f"{source}:{n}: a gate block before the first step heading")
                in_block = True
            continue
        if in_block:
            body = line.strip()
            if not body or body.startswith("#"):
                continue
            if steps[-1].actions and steps[-1].actions[-1].verb == "agent":
                raise GateError(f"{source}:{n}: agent must be its step's last action")
            steps[-1].actions.append(action(body, n, source))
            continue
        m = HEADING.match(line)
        if m:
            if any(s.id == m.group(1) for s in steps):
                raise GateError(f"{source}:{n}: step {m.group(1)} twice")
            steps.append(Step(m.group(1), m.group(2)))
    if in_block:
        raise GateError(f"{source}: a gate block is not closed")
    return [s for s in steps if s.actions]


def action(body, n, source):
    verb, _, rest = body.partition(" ")
    rest = rest.strip()
    where = f"{source}:{n}"
    if verb not in VERBS:
        raise GateError(f"{where}: unknown action {verb!r} ({', '.join(VERBS)})")
    if verb in ("do", "type", "judge", "agent"):
        if not rest:
            raise GateError(f"{where}: {verb} needs a text")
        if verb == "do":
            no_lua(rest, where)
        return Action(verb, [rest], n, body)
    if verb == "click":
        if not re.fullmatch(r"-?\d+(\.\d+)?,-?\d+(\.\d+)?", rest):
            raise GateError(f"{where}: click x,y")
        return Action(verb, [rest], n, body)
    if verb == "down":
        if rest:
            raise GateError(f"{where}: down takes nothing")
        return Action(verb, [], n, body)
    if verb in ("run", "expect"):
        label, _, tail = rest.partition(" ")
        if not label or not tail.strip():
            raise GateError(f"{where}: {verb} <label> <{'command' if verb == 'run' else 'regex'}>")
        check_label(label, where)
        if verb == "expect":
            compile_re(tail.strip(), where)
            return Action(verb, [label, tail.strip()], n, body)
        return Action(verb, [label, read_argv(tail.strip(), where)], n, body)
    if verb == "capture":
        parts = rest.split(" ", 2)
        if len(parts) < 3:
            raise GateError(f"{where}: capture <var> <label> <regex>")
        if not VAR.fullmatch(parts[0]) or parts[0] in FIXED_VARS:
            raise GateError(f"{where}: capture's var is a lower-case name, not {parts[0]!r}")
        check_label(parts[1], where)
        rx = compile_re(parts[2].strip(), where)
        if rx.groups < 1:
            raise GateError(f"{where}: capture's regex needs a group")
        return Action(verb, parts[:2] + [parts[2].strip()], n, body)
    if verb == "film":
        parts = rest.split(" ", 3)
        if len(parts) < 4 or not parts[1].isdigit() or not parts[2].isdigit():
            raise GateError(f"{where}: film <label> <frames> <every ms> <keys>")
        check_label(parts[0], where)
        no_lua(parts[3], where)
        return Action(verb, parts, n, body)
    try:
        words = shlex.split(rest)
    except ValueError as e:
        raise GateError(f"{where}: {e}") from None
    if verb == "wait":
        return Action(verb, [wait_spec(words, where)], n, body)
    if verb in ("see", "snap"):
        if not words:
            raise GateError(f"{where}: {verb} <label>")
        check_label(words[0], where)
    if verb == "teammate" and len(words) < 2:
        raise GateError(f"{where}: teammate azure|github <action> …")
    if verb == "scenario" and not words:
        raise GateError(f"{where}: scenario <scenario> [options]")
    return Action(verb, words, n, body)


def read_argv(text, where):
    """A `run`'s command as argv, refused unless it is one of READS with FLAGS only."""
    bad = sorted(SHELLY & set(text))
    if bad:
        raise GateError(f"{where}: run takes no shell ({' '.join(bad)}): one listed read")
    try:
        argv = shlex.split(text)
    except ValueError as e:
        raise GateError(f"{where}: {e}") from None
    check_read(argv, where)
    return argv


def check_read(argv, where):
    """argv is a listed read: a READS prefix, only FLAGS as options (checked again once filled: a
    captured {var} may not turn into an option)."""
    listed = "; ".join(f"{t} {'|'.join(rs)}" for t, rs in READS.items())
    if not argv or argv[0] not in READS:
        raise GateError(f"{where}: {' '.join(argv)!r} is not a listed read ({listed})")
    for a in argv[1:]:
        if a.startswith("-") and a.split("=", 1)[0] not in FLAGS[argv[0]]:
            raise GateError(f"{where}: {a.split('=', 1)[0]} is not an option a read takes ({' '.join(sorted(FLAGS[argv[0]]))})")
    words = " ".join(a for a in argv[1:] if not a.startswith("-"))
    if not any(words == r or words.startswith(r + " ") for r in READS[argv[0]]):
        raise GateError(f"{where}: {' '.join(argv)!r} is not a listed read ({listed})")


def check_label(label, where):
    """A label names a file under the run's folder: no path, no `..` (placeholders filled later)."""
    if not LABEL.fullmatch(re.sub(r"\{[a-z][a-z0-9_:]*\}", "x", label)) or ".." in label:
        raise GateError(f"{where}: bad label {label!r}: letters, digits, - _ . only")


def no_lua(keys, where):
    if "{lua:" in keys:
        raise GateError(f"{where}: no {{lua:…}} in a gate's keys: it runs code outside qarig's verbs (a hand fix)")


def compile_re(text, where):
    try:
        return re.compile(text, re.M)
    except re.error as e:
        raise GateError(f"{where}: bad regex {text!r}: {e}") from None


def wait_spec(words, where):
    if not words:
        raise GateError(f"{where}: wait <text> [in <part>] [gone] [within <time>]")
    spec = {"text": words[0], "in": None, "gone": False, "within": "60s"}
    rest = words[1:]
    while rest:
        w = rest.pop(0)
        if w == "gone":
            spec["gone"] = True
        elif w in ("in", "within") and rest:
            spec[w] = rest.pop(0)
        else:
            raise GateError(f"{where}: wait: unexpected {w!r}")
    try:
        parse_ms(spec["within"])
    except GateError as e:
        raise GateError(f"{where}: {e}") from None
    if spec["text"].startswith("re:"):
        compile_re(spec["text"][3:], where)
    return spec


def fill(text, vars_):
    """Placeholders: {name}, {repo}, {card:N}, captured vars; an unknown one is an error."""

    def one(m):
        key = m.group(1)
        if key.startswith("card:") and key[5:].isdigit():
            return str(int(vars_.get("seed_offset", 0)) + int(key[5:]))
        if key in vars_:
            return str(vars_[key])
        raise GateError(f"no value for {{{key}}} (captured later, or a typo?)")

    # only {word} / {card:N}: the key grammar's {@…}, {type:…}, {wait:…} stay as they are
    return re.sub(r"\{([a-z][a-z0-9_]*|card:\d+)\}", one, text)


# ---------------------------------------------------------------- results


@dataclass
class Row:
    id: str
    step: str
    check: str
    result: str  # PASS FAIL JUDGE AGENT SKIP
    ms: int
    evidence: str = ""
    note: str = ""


def load_rows(out):
    f = out / "results.json"
    if not f.exists():
        return []
    return [Row(**r) for r in json.loads(f.read_text())]


def load_meta(out):
    f = out / "meta.json"
    return json.loads(f.read_text()) if f.exists() else {}


def save_rows(out, rows, meta=None):
    out.mkdir(parents=True, exist_ok=True)
    if meta is not None:
        (out / "meta.json").write_text(json.dumps(meta, indent=1) + "\n")
    (out / "results.json").write_text(json.dumps([r.__dict__ for r in rows], indent=1, ensure_ascii=False) + "\n")
    (out / "RESULT.md").write_text(result_md(rows, load_meta(out)))


def result_md(rows, meta):
    lines = [f"# Gate {meta.get('script', '')} · {meta.get('name', '')} · {meta.get('commit', '')}", ""]
    counts = {k: sum(1 for r in rows if r.result == k) for k in ("PASS", "FAIL", "JUDGE", "AGENT", "SKIP")}
    lines.append(" · ".join(f"{k} {v}" for k, v in counts.items() if v) or "no rows")
    if meta.get("status"):
        lines.append(f"status: {meta['status']}")
    lines += ["", "| step | check | result | ms | evidence |", "|---|---|---|---|---|"]
    for r in rows:
        check = (r.check + (f" — {r.note}" if r.note else "")).replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {r.id} | {check} | {r.result} | {r.ms} | {r.evidence} |")
    return "\n".join(lines) + "\n"


def judge(out, row_id, verdict, note):
    """The tester agent's verdict on a judge row: PASS or FAIL with what it saw."""
    if verdict not in ("PASS", "FAIL"):
        raise GateError(f"a verdict is PASS or FAIL, not {verdict!r}")
    if not note.strip():
        raise GateError("a verdict says what was seen (the note)")
    rows = load_rows(out)
    for r in rows:
        if r.id == row_id:
            if not r.check.startswith("judge:"):
                raise GateError(f"{row_id} is no judge row ({r.check})")
            r.result, r.note = verdict, note.strip()
            save_rows(out, rows)
            return r
    raise GateError(f"no row {row_id} in {out / 'results.json'}")


# ---------------------------------------------------------------- the run


class Ctx:
    """What a run does in the world; qarig gives the real one, tests a fake.

    drive(verb, args, out) -> (ok, ms, output)   a qarig verb on the env: do / type / click / wait /
        see / snap / film / teammate / down. Evidence it keeps goes under `out`, named in its output
        as `evidence <path relative to out>`.
    shell(argv) -> (code, output)                a listed read in the env's env and checkout
    """

    def drive(self, verb, args, out):  # pragma: no cover - the real one is qarig's
        raise NotImplementedError

    def shell(self, argv):  # pragma: no cover
        raise NotImplementedError


def run(steps, ctx, out, vars_, meta, start=None, only=None, keep_going=False, clock=time.time, sleep=time.sleep):
    """Runs the steps (from `start`, or only those named) and returns (rows, status): status is
    `pass`, `fail` or `agent:<step>[:<next step>]` (the tester agent's turn). Rows of the steps run
    again replace their earlier rows; the others stay (a run picked up with --from)."""
    ids = [s.id for s in steps]
    for o in ([start] if start else []) + list(only or []):
        if o not in ids:
            raise GateError(f"no step {o}: {', '.join(ids)}")
    chosen = [s for s in steps if (not only or s.id in only) and (not start or ids.index(s.id) >= ids.index(start))]
    rerun = {s.id for s in chosen}
    rows = [r for r in load_rows(out) if r.step not in rerun]
    vars_ = {**load_vars(out), **vars_}
    outputs = {}
    status = "pass"

    def finish(st):
        save_rows(out, rows, {**meta, "status": st})
        save_vars(out, vars_)
        return rows, st

    for step in chosen:
        n = 0
        for a in step.actions:
            t0 = clock()

            def row(check, result, evidence="", note="", ms=None):
                nonlocal n
                n += 1
                rows.append(Row(f"{step.id}.{n}", step.id, check, result, int((clock() - t0) * 1000) if ms is None else int(ms), evidence, note))
                save_rows(out, rows, meta)

            # a teardown keeps the env for a look and a rerun: none after a FAIL, none picked up
            # with --from unless --only names its step
            if a.verb == "down":
                why = "after a FAIL" if status == "fail" else "from --from (name the step with --only)" if start and step.id not in (only or ()) else ""
                if why:
                    row("down: tears the env down", "SKIP", note=f"not run {why}", ms=0)
                    continue

            try:
                ok = act(a, ctx, out, vars_, outputs, row, clock, sleep)
            except GateError as e:
                row(a.text, "FAIL", note=str(e))
                ok = False
            save_vars(out, vars_)
            if ok == "agent":
                after = ids[ids.index(step.id) + 1 :]
                return finish(f"agent:{step.id}" + (f":{after[0]}" if after else ""))
            if not ok:
                status = "fail"
                if not keep_going:
                    return finish(status)
                break
    return finish(status)


def tail(text, n=300):
    text = (text or "").strip()
    return text.splitlines()[-1][-n:] if text else ""


def evidence_of(said):
    m = re.search(r"^evidence (\S+)", said or "", re.M)
    return m.group(1) if m else ""


def wait_re(w, ctx, out, clock, sleep):
    """`wait re:<regex>`: the trees (`see`, of the part asked) polled each second until the regex
    matches (or, `gone`, stops matching) across lines: a card in one column, a count."""
    rx = re.compile(w["text"][3:], re.M | re.S)
    t0 = clock()
    limit = parse_ms(w["within"])
    said = ""
    while True:
        ok, _, said = ctx.drive("see", ["", *([w["in"]] if w["in"] else [])], None)
        hit = ok and rx.search(said) is not None
        if hit != w["gone"]:
            return True, int((clock() - t0) * 1000), ""
        if (clock() - t0) * 1000 >= limit:
            _, _, kept = ctx.drive("timeout", [w["text"], said], out)  # trees, PNG, logs, a film
            return False, int((clock() - t0) * 1000), f"{kept}\ntimeout after {limit} ms: {w['text']!r}"
        sleep(1)


def parse_ms(text):
    t = str(text).strip()
    for suffix, mul in (("ms", 1), ("s", 1000), ("m", 60_000), ("h", 3_600_000)):
        if t.endswith(suffix) and t[: -len(suffix)].replace(".", "", 1).isdigit():
            return int(float(t[: -len(suffix)]) * mul)
    if t.isdigit():
        return int(t) * 1000
    raise GateError(f"not a time: {text!r} (90s, 10m, 500ms)")


def act(a, ctx, out, vars_, outputs, row, clock=time.time, sleep=time.sleep):
    v = a.verb
    if v in ("do", "type", "click"):
        arg = fill(a.args[0], vars_)
        if v == "do":
            no_lua(arg, f"line {a.line}")
        ok, ms, said = ctx.drive(v, [arg], out)
        if not ok:
            row(f"{v} {arg}", "FAIL", note=tail(said), ms=ms)
        return ok
    if v == "wait":
        w = dict(a.args[0], text=fill(a.args[0]["text"], vars_))
        desc = f"wait {'no ' if w['gone'] else ''}{w['text']!r} in {w['in'] or 'any'} within {w['within']}"
        if w["text"].startswith("re:"):
            ok, ms, said = wait_re(w, ctx, out, clock, sleep)
        else:
            ok, ms, said = ctx.drive("wait", [w], out)
        row(desc, "PASS" if ok else "FAIL", evidence_of(said), "" if ok else tail(said), ms=ms)
        return ok
    if v in ("see", "snap"):
        label = fill(a.args[0], vars_)
        check_label(label, f"line {a.line}")
        ok, ms, said = ctx.drive(v, [label, *a.args[1:]], out)
        if v == "see":
            outputs[label] = said  # `expect <see label> <regex>` reads the trees
        if not ok:
            row(f"{v} {label}", "FAIL", evidence_of(said), tail(said), ms=ms)
        return ok
    if v == "film":
        label, frames, every, keys = a.args
        label, keys = fill(label, vars_), fill(keys, vars_)
        check_label(label, f"line {a.line}")
        no_lua(keys, f"line {a.line}")
        ok, ms, said = ctx.drive("film", [label, int(frames), int(every), keys], out)
        if not ok:
            row(f"film {label}", "FAIL", evidence_of(said), tail(said), ms=ms)
        return ok
    if v in ("teammate", "scenario"):
        args = [fill(x, vars_) for x in a.args]
        ok, ms, said = ctx.drive(v, args, out)
        row(f"{v} " + " ".join(args), "PASS" if ok else "FAIL", note="" if ok else tail(said), ms=ms)
        return ok
    if v == "down":
        ok, ms, said = ctx.drive("down", [], out)
        row("down: nothing of the env runs after", "PASS" if ok else "FAIL", evidence_of(said), "" if ok else tail(said), ms=ms)
        return ok
    if v == "run":
        label, argv = a.args[0], [fill(x, vars_) for x in a.args[1]]
        check_read(argv, f"line {a.line}")
        code, said = ctx.shell(argv)
        outputs[label] = said
        f = out / "runs" / f"{label}.txt"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(f"$ {shlex.join(argv)}\n{said}")
        vars_[f"run:{label}"] = said
        row(f"run {label}: {shlex.join(argv)}", "PASS" if code == 0 else "FAIL", f"runs/{label}.txt", "" if code == 0 else f"exit {code}: {tail(said)}")
        return code == 0
    if v in ("expect", "capture"):
        label = a.args[0] if v == "expect" else a.args[1]
        said = outputs.get(label, vars_.get(f"run:{label}"))
        if said is None:
            raise GateError(f"{v}: no run {label} before it")
        rx = fill(a.args[-1], vars_)
        m = re.search(rx, said, re.M)
        if v == "expect":
            row(f"expect {label} ~ {rx}", "PASS" if m else "FAIL", f"runs/{label}.txt" if f"run:{label}" in vars_ else f"trees/{label}.txt")
            return m is not None
        if m is None:
            row(f"capture {a.args[0]} from {label} ~ {rx}", "FAIL", f"runs/{label}.txt", "no match")
            return False
        vars_[a.args[0]] = m.group(1)
        return True
    if v == "judge":
        row(f"judge: {fill(a.args[0], vars_)}", "JUDGE")
        return True
    if v == "agent":
        row(f"agent: {fill(a.args[0], vars_)}", "AGENT")
        return "agent"
    raise GateError(f"unknown action {v}")


def load_vars(out):
    f = out / "vars.json"
    return json.loads(f.read_text()) if f.exists() else {}


def save_vars(out, vars_):
    """The captured vars and the reads' outputs, for a run picked up with --from."""
    out.mkdir(parents=True, exist_ok=True)
    keep = {k: v for k, v in vars_.items() if k not in FIXED_VARS}
    (out / "vars.json").write_text(json.dumps(keep, indent=1, ensure_ascii=False) + "\n")
