"""qarig's own tests (stdlib only): python3 -m unittest app/scripts/qarig_test.py"""

import contextlib
import io
import json
import os
import re
import socket
import sys
import tempfile
import threading
import unittest
import importlib.machinery
import importlib.util
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qarig_drive  # noqa: E402
import qarig_gate  # noqa: E402

_loader = importlib.machinery.SourceFileLoader("qarig", str(Path(__file__).resolve().parent / "qarig"))
qarig = importlib.util.module_from_spec(importlib.util.spec_from_loader("qarig", _loader))
_loader.exec_module(qarig)


def fake_app(sock, answers):
    """A one-connection drive socket: answers each request line with the next of `answers`,
    keeping what it was asked."""
    asked = []
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(str(sock))
    srv.listen(4)

    def run():
        for answer in answers:
            c, _ = srv.accept()
            with c:
                buf = b""
                while not buf.endswith(b"\n"):
                    buf += c.recv(4096)
                asked.append(json.loads(buf))
                if answer is not None:
                    c.sendall((json.dumps(answer) + "\n").encode())
        srv.close()

    threading.Thread(target=run, daemon=True).start()
    return asked


class DriveClient(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir="/tmp", prefix="qdt")
        self.sock = Path(self.dir.name) / "d.sock"

    def tearDown(self):
        self.dir.cleanup()

    def test_a_request_gets_v1_and_its_answer(self):
        asked = fake_app(self.sock, [{"ok": True, "ms": 12}])
        self.assertEqual(qarig_drive.ask(self.sock, {"keys": "{@enter}"}), {"ok": True, "ms": 12})
        self.assertEqual(asked, [{"keys": "{@enter}", "v": 1}])

    def test_no_app_and_a_hang_up_say_so(self):
        with self.assertRaisesRegex(qarig_drive.DriveError, "no live app"):
            qarig_drive.ask(self.sock, {"see": []})
        fake_app(self.sock, [None])
        with self.assertRaisesRegex(qarig_drive.DriveError, "hung up"):
            qarig_drive.ask(self.sock, {"see": []})

    def test_the_drive_log_has_every_step_with_its_ms(self):
        qarig_drive.log(self.dir.name, "do", "{@tab}\n", {"ok": True}, 41)
        qarig_drive.log(self.dir.name, "wait", "'x' in chat", {"ok": False, "error": "timeout"}, 900)
        lines = (Path(self.dir.name) / "logs/drive.log").read_text().splitlines()
        self.assertEqual([l.split("\t")[1:] for l in lines], [["do", "{@tab}⏎", "ok", "41"], ["wait", "'x' in chat", "FAIL timeout", "900"]])


class Text(unittest.TestCase):
    def test_seen_as_blocks_in_order(self):
        ans = {
            "ok": True,
            "trees": {"main": "Island\n  ListRow text=\"#101\"\n", "layer": ""},
            "status": ["Factory ◆ 2"],
            "balloons": [],
            "view": "factory",
        }
        self.assertEqual(
            qarig_drive.seen_text(ans),
            "== view: factory\n== main\nIsland\n  ListRow text=\"#101\"\n== layer\n(empty)\n== status\nFactory ◆ 2\n== balloons\n(none)\n",
        )
        self.assertEqual(qarig_drive.seen_text(ans, ("layer",)), "== layer\n(empty)\n")

    def test_times(self):
        self.assertEqual(qarig_drive.parse_ms("90s"), 90_000)
        self.assertEqual(qarig_drive.parse_ms("10m"), 600_000)
        self.assertEqual(qarig_drive.parse_ms("500ms"), 500)
        self.assertEqual(qarig_drive.parse_ms("2"), 2000)
        with self.assertRaises(ValueError):
            qarig_drive.parse_ms("soon")


SCRIPT = """# Gate · demo

Prose a person reads.

## G0 · Setup

```gate
# a comment
run status abe status --no-start
expect status version \\d+
capture ver status version (\\S+)
see G0 main status
```

## G1 · Open a card

```gate
do {@super+alt+a}{wait:200}
type card {card:1}
wait 'Needs you' in chat within 2m
snap G1-{ver}
judge the banner shows on {name}
agent answer the grill's questions
```

## G2 · After

```gate
teammate azure move {card:2} Active --as sam
wait '#{card:2}' gone
down
```
"""


class FakeCtx(qarig_gate.Ctx):
    def __init__(self, fail=(), reads=None):
        self.calls, self.fail, self.reads = [], set(fail), reads or {}

    def drive(self, verb, args, out):
        self.calls.append((verb, *args))
        if verb in self.fail:
            return False, 7, "waited\nevidence timeouts/x\ntimeout after 7 ms"
        return True, 5, ""

    def shell(self, argv):
        self.calls.append(("shell", *argv))
        return self.reads.get(argv[1], (0, ""))


class Gate(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="qgt")
        self.out = Path(self.dir.name)
        self.steps = qarig_gate.parse(SCRIPT, "demo.md")
        self.vars = {"name": "gate-A", "repo": "/r", "seed_offset": 100}

    def tearDown(self):
        self.dir.cleanup()

    def run_gate(self, ctx, **kw):
        return qarig_gate.run(self.steps, ctx, self.out, self.vars, {"script": "demo.md", "name": "gate-A", "commit": "abc"}, clock=lambda: 0, **kw)

    def test_parse_steps_and_actions(self):
        self.assertEqual([(s.id, s.title) for s in self.steps], [("G0", "Setup"), ("G1", "Open a card"), ("G2", "After")])
        self.assertEqual([a.verb for a in self.steps[1].actions], ["do", "type", "wait", "snap", "judge", "agent"])
        self.assertEqual(self.steps[1].actions[2].args[0], {"text": "Needs you", "in": "chat", "gone": False, "within": "2m"})
        self.assertEqual(self.steps[0].actions[0].args, ["status", ["abe", "status", "--no-start"]])

    def test_parse_refuses_bad_lines_saying_where(self):
        for body, says in (
            ("frob x", "unknown action 'frob'"),
            ("run x abe card move 4 Done", "not a listed read"),
            ("run x gh pr view 3 | grep x", "no shell"),
            ("run x gh api -X POST repos/a/b/issues", "-X is not an option"),
            ("run x gh api -XDELETE repos/a/b", "-XDELETE is not an option"),
            ("run x gh api --method=DELETE repos/a/b", "--method is not an option"),
            ('run x git ls-remote --upload-pack="touch pwned" .', "--upload-pack is not an option"),
            ("run x git log --output=/tmp/x", "--output is not an option"),
            ("run x git branch -D main", "-D is not an option"),
            ("run x git branch topic", "not a listed read"),
            ("run x gh", "not a listed read"),
            ("run ../x abe status", "bad label"),
            ("see ../../x main", "bad label"),
            ("capture name x a(b)", "lower-case name"),
            ('do {lua:vim.fn.system("x"):lua}', "no \\{lua"),
            ("wait 'x' within soon", "not a time"),
            ("capture v x no-group", "needs a group"),
            ("click here", "click x,y"),
            ("wait 'x' sideways", "unexpected 'sideways'"),
            ("film f 10 x {@tab}", "film <label>"),
        ):
            with self.assertRaisesRegex(qarig_gate.GateError, f"demo.md:4: .*{says}"):
                qarig_gate.parse(f"## G0 · x\n\n```gate\n{body}\n```\n", "demo.md")
        with self.assertRaisesRegex(qarig_gate.GateError, "last action"):
            qarig_gate.parse("## G0 · x\n```gate\nagent a\ndo {@tab}\n```\n", "demo.md")
        with self.assertRaisesRegex(qarig_gate.GateError, "G0 twice"):
            qarig_gate.parse("## G0 · x\n```gate\ndo a\n```\n## G0 · y\n", "demo.md")

    def test_a_captured_value_never_turns_into_an_option_or_a_path(self):
        steps = qarig_gate.parse("## G0 · x\n```gate\nrun r gh pr view {pr}\nsee {pr} main\n```\n", "demo.md")
        for pr in ("--web", "../../x"):
            rows, status = qarig_gate.run(steps, FakeCtx(), self.out, {"pr": pr}, {}, clock=lambda: 0)
            self.assertEqual((status, rows[-1].result), ("fail", "FAIL"))
            self.assertRegex(rows[-1].note, "not an option|bad label")

    def test_a_regex_wait_polls_the_trees_until_it_matches(self):
        trees = iter(["#col:Active\n  #card:101\n#col:New\n  #card:102\n"] * 2 + ["#col:Active\n  #card:101\n  #card:102\n"])
        ctx = FakeCtx()
        ctx.drive = lambda verb, args, out: (True, 0, next(trees))
        steps = qarig_gate.parse("## G0 · x\n```gate\nwait 're:#col:Active\\n(  \\S+\\n)*?  #card:102' in main within 10s\n```\n", "demo.md")
        t = [0]
        rows, status = qarig_gate.run(steps, ctx, self.out, {}, {}, clock=lambda: t[0], sleep=lambda s: t.__setitem__(0, t[0] + s))
        self.assertEqual((status, rows[0].result, rows[0].ms), ("pass", "PASS", 2000))
        ctx.drive = lambda verb, args, out: (True, 0, "#col:New\n  #card:102\n")
        t[0] = 0
        rows, status = qarig_gate.run(steps, ctx, self.out, {}, {}, clock=lambda: t[0], sleep=lambda s: t.__setitem__(0, t[0] + s))
        self.assertEqual((status, rows[0].result, rows[0].ms), ("fail", "FAIL", 10000))

    def test_placeholders_fill_and_keys_stay(self):
        self.assertEqual(qarig_gate.fill("{@super+,}{type:x}{card:2} {name}", {"seed_offset": 200, "name": "B"}), "{@super+,}{type:x}202 B")
        with self.assertRaisesRegex(qarig_gate.GateError, r"no value for \{pr\}"):
            qarig_gate.fill("gh pr view {pr}", {})

    def test_a_run_stops_at_the_agents_turn_and_goes_on_from_the_next_step(self):
        ctx = FakeCtx(reads={"status": (0, "version 3.0.1\n")})
        rows, status = self.run_gate(ctx)
        self.assertEqual(status, "agent:G1:G2")
        self.assertEqual(
            ctx.calls,
            [("shell", "abe", "status", "--no-start"), ("see", "G0", "main", "status"), ("do", "{@super+alt+a}{wait:200}"), ("type", "card 101"), ("wait", {"text": "Needs you", "in": "chat", "gone": False, "within": "2m"}), ("snap", "G1-3.0.1")],
        )
        self.assertEqual([(r.id, r.result) for r in rows], [("G0.1", "PASS"), ("G0.2", "PASS"), ("G1.1", "PASS"), ("G1.2", "JUDGE"), ("G1.3", "AGENT")])
        self.assertEqual(rows[3].check, "judge: the banner shows on gate-A")
        ctx2 = FakeCtx()
        rows, status = self.run_gate(ctx2, start="G2", only=["G2"])
        self.assertEqual(status, "pass")
        self.assertEqual(ctx2.calls, [("teammate", "azure", "move", "102", "Active", "--as", "sam"), ("wait", {"text": "#102", "in": None, "gone": True, "within": "60s"}), ("down",)])
        self.assertEqual([r.id for r in rows], ["G0.1", "G0.2", "G1.1", "G1.2", "G1.3", "G2.1", "G2.2", "G2.3"])
        md = (self.out / "RESULT.md").read_text()
        self.assertIn("# Gate demo.md · gate-A · abc", md)
        self.assertIn("PASS 6 · JUDGE 1 · AGENT 1", md)
        self.assertIn("| G1.1 | wait 'Needs you' in chat within 2m | PASS | 5 |  |", md)

    def test_a_fail_stops_the_run_with_its_evidence_unless_keep_going(self):
        ctx = FakeCtx(fail={"wait"}, reads={"status": (0, "version 3\n")})
        rows, status = self.run_gate(ctx, only=["G0", "G2"])
        self.assertEqual(status, "fail")
        last = rows[-1]
        self.assertEqual((last.id, last.result, last.ms, last.evidence, last.note), ("G2.2", "FAIL", 7, "timeouts/x", "timeout after 7 ms"))
        self.assertNotIn(("down",), ctx.calls)
        ctx = FakeCtx(fail={"teammate"}, reads={"status": (1, "no serve\n")})
        rows, status = self.run_gate(ctx, keep_going=True, only=["G0", "G2"])
        self.assertEqual(status, "fail")
        self.assertEqual([(r.id, r.result) for r in rows], [("G0.1", "FAIL"), ("G2.1", "FAIL")])
        self.assertNotIn(("down",), ctx.calls)
        self.assertEqual(rows[0].note, "exit 1: no serve")

    def test_a_teardown_step_runs_only_when_nothing_failed_and_it_was_asked_for(self):
        steps = qarig_gate.parse("## G0 · x\n```gate\nwait 'x'\n```\n## G6 · Down\n```gate\ndown\n```\n", "demo.md")
        for kw, fail, down in (
            ({}, (), True),
            ({"keep_going": True}, ("wait",), False),
            ({"start": "G0", "keep_going": True}, (), False),
            ({"start": "G6"}, (), False),
            ({"start": "G6", "only": ["G6"]}, (), True),
            ({"only": ["G6"]}, (), True),
            ({"only": ["G0", "G6"], "keep_going": True}, ("wait",), False),
        ):
            ctx = FakeCtx(fail=fail)
            rows, _ = qarig_gate.run(steps, ctx, self.out, {}, {}, clock=lambda: 0, **kw)
            self.assertEqual(("down",) in ctx.calls, down, kw)
            self.assertEqual(rows[-1].result, "PASS" if down else "SKIP", kw)
            (self.out / "results.json").unlink()

    def test_a_judge_row_takes_the_agents_verdict(self):
        self.run_gate(FakeCtx(reads={"status": (0, "version 3\n")}))
        r = qarig_gate.judge(self.out, "G1.2", "PASS", "the banner reads Free shipping")
        self.assertEqual((r.result, r.note), ("PASS", "the banner reads Free shipping"))
        self.assertIn("| G1.2 | judge: the banner shows on gate-A — the banner reads Free shipping | PASS |", (self.out / "RESULT.md").read_text())
        with self.assertRaisesRegex(qarig_gate.GateError, "no judge row"):
            qarig_gate.judge(self.out, "G1.1", "PASS", "x")
        with self.assertRaisesRegex(qarig_gate.GateError, "says what was seen"):
            qarig_gate.judge(self.out, "G1.2", "FAIL", " ")

    def test_the_repo_gate_scripts_parse(self):
        root = Path(__file__).resolve().parents[2] / "tests/gate"
        scripts = sorted(root.glob("*.md"))
        self.assertTrue(scripts, f"no gate scripts in {root}")
        for f in scripts:
            self.assertTrue(qarig_gate.parse(f.read_text(), f.name), f.name)


class Build(unittest.TestCase):
    """The shared build is this checkout's; rebuild waits only for the live apps of its own build."""

    def test_the_build_lives_in_this_checkout(self):
        repo = Path(__file__).resolve().parents[2]
        self.assertEqual(qarig.REPO, repo)
        if not any(k in os.environ for k in ("QARIG_HOME", "QARIG_BIN", "QARIG_TARGET")):
            self.assertEqual(qarig.BIN, repo / ".scratch/qa/target/release/vimstorm")
            self.assertEqual(qarig.GATE_OUT, repo / ".scratch/qa/gate")

    def test_live_apps_names_each_running_one_with_its_binary(self):
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="qbl") as t:
            root = Path(t)
            me = os.getpgrp()
            for name, rig in [
                ("a", {"live_pgid": me, "live_bin": "/other/vimstorm"}),
                ("b", {"live_pgid": me}),  # before live_bin: this build's
                ("c", {"live_pgid": 0, "live_bin": str(qarig.BIN)}),  # not live
            ]:
                (root / name).mkdir()
                (root / name / "rig.json").write_text(json.dumps(rig))
            (root / "junk").mkdir()
            old, qarig.ROOT = qarig.ROOT, root
            try:
                self.assertEqual(qarig.live_apps(), [("a", "/other/vimstorm"), ("b", str(qarig.BIN))])
            finally:
                qarig.ROOT = old


class RealEnvServe(unittest.TestCase):
    """A --real env's serve runs under the real HOME (claude's transcripts), on the env's state."""

    def test_its_serve_is_under_the_real_home_with_the_envs_state_and_git_identity(self):
        d = Path("/tmp/qr/qrs")
        rig = {"real": True, "abe_bin": "/x/abe", "ado_port": 1, "extra_env": {}}
        env = qarig.serve_env(d, rig)
        self.assertEqual(
            [env["HOME"], env["ABE_STATE_DIR"], env["ABE_SOCKET"], env["ABE_CONFIG_DIR"], env["GIT_CONFIG_GLOBAL"]],
            [qarig.REAL_HOME, str(d / "s"), str(d / "s/s.sock"), str(d / "cfg"), str(d / "home/.gitconfig")],
        )
        self.assertEqual(qarig.serve_env(d, {**rig, "real": False})["HOME"], str(d / "home"))

    def test_its_own_serve_is_no_stray_but_one_on_the_real_state_is(self):
        d = Path("/tmp/qr/qrs")
        own = {"argv": ["abe", "serve"], "HOME": qarig.REAL_HOME, "ABE_STATE_DIR": str(d / "s")}
        yours = {"argv": ["abe", "serve"], "HOME": qarig.REAL_HOME}
        after = {1: own, 2: yours}
        self.assertEqual([p for p, _, _ in qarig.stray_serves({}, after, d, "x.png", qarig.REAL_HOME)], [2])
        self.assertEqual([p for p, _, _ in qarig.stray_serves({}, after, d, "x.png")], [1, 2])


class RealEnvClone(unittest.TestCase):
    """A --real env's clone: the gate Override in yours for the repo, kept out of git."""

    def test_the_clone_gets_the_gate_override_in_yours_for_the_repo(self):
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="qsm") as t:
            repo = Path(t)
            (repo / ".git/info").mkdir(parents=True)
            qarig.gate_local(repo)
            qarig.gate_local(repo)
            lines = (repo / ".abe/settings.local.yaml").read_text().splitlines()
            self.assertEqual(lines[1], "overrides:")
            self.assertIn("  limits.maxBoxesPerPerson:", lines)
            self.assertEqual((repo / ".git/info/exclude").read_text(), ".abe/settings.local.yaml\n")


class GateOrgStore(unittest.TestCase):
    """A real env's org store: its own gate/<name>-<4hex> prefix of the org bucket, emptied by down."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir="/tmp", prefix="qos")
        self.d = Path(self.dir.name)
        (self.d / "org-infra/terraform").mkdir(parents=True)
        (self.d / "org-infra/terraform/org.yaml").write_text('region: eu-west-1\ntooling:\n  account: "123456789012"\n  profile: abe-tooling\n')

    def tearDown(self):
        self.dir.cleanup()

    def test_the_layer_names_the_envs_prefix_of_the_org_bucket(self):
        url = qarig.gate_store(self.d / "org-infra", "gate-A", "1a2b")
        self.assertEqual(url, "s3://abe-org-store-123456789012/gate/gate-A-1a2b")
        self.assertEqual(qarig.gate_layer(url).splitlines(), [f"stores.org: {url}"])

    def test_no_account_or_a_bad_name_makes_no_store(self):
        with self.assertRaises(SystemExit):
            qarig.gate_store(self.d / "nowhere", "gate-A", "1a2b")
        with self.assertRaises(SystemExit):
            qarig.gate_store(self.d / "org-infra", "a/b", "1a2b")

    def down(self, store, code=0):
        asked = []

        def aws(rig, *args):
            asked.append(args)
            return subprocess.CompletedProcess(args, code, "", "denied" if code else "")

        rig = {"name": "gate-A", "org_store": store, "extra_env": {"AWS_PROFILE": "abe-tooling"}}
        qarig.save(self.d, rig)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            kept = qarig.down_store(self.d, rig, aws=aws)
        return asked, kept, json.loads((self.d / "rig.json").read_text())

    def test_down_empties_only_the_gate_prefix_and_forgets_it(self):
        url = "s3://abe-org-store-123456789012/gate/gate-A-1a2b"
        asked, ok, rig = self.down(url)
        self.assertEqual(asked, [("s3", "rm", url + "/", "--recursive", "--only-show-errors")])
        self.assertTrue(ok)
        self.assertIsNone(rig["org_store"])

    def test_down_leaves_a_store_that_is_no_gate_prefix_alone(self):
        for url in ("s3://abe-org-store-123456789012", "s3://abe-org-store-123456789012/prototypes", "s3://other/gate/gate-A-1a2b", "s3://abe-org-store-123456789012/gate/gate-A-1a2b/x"):
            asked, _, rig = self.down(url)
            self.assertEqual(asked, [], url)
            self.assertEqual(rig["org_store"], url)

    def test_a_failed_delete_keeps_the_prefix_for_the_next_down(self):
        url = "s3://abe-org-store-123456789012/gate/gate-A-1a2b"
        _, ok, rig = self.down(url, code=1)
        self.assertFalse(ok)
        self.assertEqual(rig["org_store"], url)


class FakeEnv(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="qfe")
        self.d = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def test_the_install_record_is_done_as_serve_reads_it(self):
        # serve's Done is every part passing (core's installDone over INSTALL_PARTS)
        src = (qarig.REPO / "abe/packages/core/src/install/install.ts").read_text()
        listed = src.split("export const INSTALL_PARTS = [", 1)[1].split("]", 1)[0]
        self.assertEqual(qarig.INSTALL_PARTS, tuple(re.findall(r"'([a-z-]+)'", listed)))
        seed = self.d / "seed.json"
        seed.write_text("{}")
        repo = self.d / "repo"
        repo.mkdir()
        qarig.installed(self.d, repo, seed)
        (rec,) = [json.loads(f.read_text()) for f in (self.d / "s/installs").glob("*/install.json")]
        self.assertEqual(rec["repo"], str(repo))
        self.assertEqual({p: c["state"] for p, c in rec["parts"].items()}, {p: "pass" for p in qarig.INSTALL_PARTS})

    def test_typed_text_goes_a_key_at_a_time(self):
        asked = []
        ans = qarig.type_slowly(self.d, "hello", 0, 5, ask=lambda req: asked.append(req) or {"ok": True})
        self.assertTrue(ans["ok"])
        self.assertEqual(asked, [{"type": c} for c in "hello"])
        stop = qarig.type_slowly(self.d, "ab", 0, 5, ask=lambda req: {"ok": False, "error": "no"})
        self.assertEqual(stop, {"ok": False, "error": "no"})

    def test_the_fake_gh_names_a_login_like_a_signed_in_gh(self):
        (self.d / "bin").mkdir()
        gh = self.d / "bin/gh"
        gh.write_text((Path(qarig.__file__).parent / "qarig_gh.py").read_text())
        run = lambda *a: subprocess.run([sys.executable, "-I", str(gh), *a], capture_output=True, text=True).stdout.strip()
        self.assertEqual(json.loads(run("api", "user"))["login"], "qa-rig")
        self.assertEqual(run("api", "user", "-q", ".login"), "qa-rig")


if __name__ == "__main__":
    unittest.main()
