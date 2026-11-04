# In-app QA: driving the app without OS keystrokes

For a QA agent checking a change in the real app (Rust window + Abe), several at once. Never drive the installed app or any visible window with `osascript` / OS keys: keys go to whichever window is in front, so two testers type into each other's windows, and the installed app is not yours.

## Pick the cheapest tool that shows it

| What you check | Use |
| --- | --- |
| Behaviour a test can pin (keys, focus, layout, a screen's tree) | a cargo window test (`app/tests`, fake bridge, contract trees) or a bun test (`abe/`) |
| What an Abe screen says, no Rust | `abe ui render <screen>` (headless; skips key routing, layout, look) |
| One picture or film after a fixed key string | `qarig shot` (one app start per shot) |
| A live app driven step by step: wait for what is drawn, act, look again | `qarig live` + `do / see / wait / snap / film` (this doc) |
| A scripted pass with `RESULT.md` | `qarig gate <env> tests/gate/<script>.md` (`app/scripts/qarig_gate.py`) |

## The pieces

- **Drive socket** (`app/src/devtools/drive.rs`, `shots` build only, never the release binary): `VIMSTORM_DRIVE=<socket>` starts the app offscreen (never shown, never takes focus, own XDG state) and keeps it up. It takes one JSON line per request on a 0600 unix socket, peer uid checked. The window draws at a steady pace (`VIMSTORM_DRIVE_FPS`, default 10), so timers and balloons behave as on screen.
- **qarig** (`app/scripts/qarig`, its `--help`): the client and the env maker. An env `<name>` lives under `/tmp/qr/<name>`: its own `HOME`, `ABE_STATE_DIR` / `ABE_SOCKET` / `ABE_CONFIG_DIR`, XDG dirs, `VIMSTORM_NO_INSTANCE=1`, its own `abe serve`, a fake Azure DevOps on a free port, fake `az` / `gh` / `claude` / `aws` (EC2) and a demo repo with a local bare origin. Nothing of the real `~/.config/abe`, the Mac serve or real logins is read.

## Build once

qarig runs a shared shots build that belongs to the checkout it is in (`<checkout>/.scratch/qa/`):

```sh
app/scripts/qarig rebuild             # this checkout's HEAD, in .scratch/qa/build (a detached worktree)
app/scripts/qarig rebuild --ref <sha> # another commit
QARIG_BUILD=$PWD app/scripts/qarig rebuild   # this checkout as it is, uncommitted changes too (BUILT says -dirty)
```

Rebuild takes a lock and refuses while live apps of the same build run. Overrides: `QARIG_HOME` (moves `.scratch/qa`), `QARIG_BIN` (any shots binary, e.g. `$CARGO_TARGET_DIR/debug/vimstorm` after `cargo build --features shots`), `QARIG_ABE_BIN` (an `abe` from `bun run build:darwin`), `QARIG_BUILD` (the checkout whose fakes and gate scripts are used; set it with `QARIG_BIN` to the checkout that built it). Keep the same overrides on every qarig call of a run.

## The loop

```sh
q=app/scripts/qarig
$q up i7a                          # env; pick a name unique to you (/tmp/qr is machine-wide)
$q live i7a --abe                  # live app on the env's demo repo, Abe view shown
$q see i7a main layer              # the trees, as `abe ui render`'s outline
$q do i7a '{@super+,}'             # keys (grammar below); --type '<text>', --click x,y
$q wait i7a 'Settings' --in layer --timeout 10s   # exit 1 on timeout, evidence kept
$q snap i7a settings               # PNG: /tmp/qr/i7a/shots/settings/settings.png
$q film i7a open '{@enter}' --frames 20 --every 100   # frames while keys play + flipbook
$q scenario i7a list               # fake serve states (Needs you, stages, boxes…)
$q down i7a                        # quits the app, serve and fakes
```

- **Wait, don't sleep.** `wait` polls what is drawn every 100 ms; `--gone` waits for text to go. A timeout is a finding: report it with its evidence, never work around it by hand.
- **Look with `see`, prove with PNGs.** Checks read the trees (exact, cheap). PNGs and films are evidence and for judging the look; read them with the Read tool.
- Parts of `see` / `wait --in`: `main`, `chat`, `pane`, `review` (bridge slots), `layer` (popup / dialog), `status` (status bar widgets, then the bridge's line), `balloons`, `title`, `view` (`factory` or `editor`). The Editor's text is not a tree: read it with `{lua:…:lua}` in keys.
- Several apps: run the loop for several names at once (each its own process), or `qarig fleet <n> --prefix i7 --abe` (envs `i71…i7n`, each live). One env's keys never reach another's app.
- Proof it holds: `tests/gate/parallel.md`, run by two testers at once (`qarig up p-A`, `qarig up p-B --seed-offset 100`, `qarig live … --abe`, `qarig gate <env> tests/gate/parallel.md` for each, in parallel) and once alone. The RESULT.md tables match and neither env's trees name the other's cards.

## Keys

The `VIMSTORM_SHOT_KEYS` grammar (`app/src/devtools/shot.rs`, one parser for shots and the socket; an unknown `{@…}` is refused before anything plays):

- plain text: nvim input (nvim notation, `<D-S-a>`, `<Esc>`)
- `{@super+alt+a}`, `{@enter}`, `{@ö}`: a GPUI keystroke (Rust-owned keys; the Abe view takes only these). `{@shift}{@shift}` double Shift, `{@hold ctrl}` / `{@release}`
- `{type:text}`: each char as a GPUI keystroke (a Rust-owned text field)
- `{@click x,y}`, `{@move x,y}`, `{@scroll dy}`: logical px from the window's top left
- `{wait:ms}` (only to let an animation finish; prefer `qarig wait`), `{shot:label}`, `{lua:code:lua}`

Keys are the app's own (README.md): `k/l/ö/ä` move, ⌘⌥A Factory ↔ Editor, ⌘, Settings.

## Evidence

Per env, `/tmp/qr/<name>/`:

- `logs/drive.log`: every `live / do / wait / snap / film / scenario / teammate` with time, ok / FAIL and ms. It is the record that no key was sent outside your script.
- `logs/timeouts/`: a timed-out wait's trees and PNG. `logs/live.log`: the app's output; `logs/serve.log`, `logs/ado-requests.log`.
- `shots/<label>/`: snaps and films (`-frames.tsv`, flipbook). `qarig diff <name> <label>` flags shifts and flicker in a film cheaply.

Report paths, not pasted dumps.

## The raw socket

Without qarig (a test, another client): `/tmp/qr/<name>/live.sock` (or your own `VIMSTORM_DRIVE`; a socket path is at most 104 bytes). One JSON line each way, `"v":1`:

```text
{"v":1,"keys":"{@super+alt+a}{@ö}{@enter}"}              → {"ok":true,"ms":412}
{"v":1,"type":"own words"}                              → {"ok":true,"ms":…}
{"v":1,"click":[640,312]}   ("dblclick", "move" too)     → {"ok":true,"ms":…}
{"v":1,"scroll":[0,-80]}                                → {"ok":true,"ms":…}
{"v":1,"see":["main","layer"]}   ([]: all)               → {"ok":true,"view":…,"trees":{…},"status":[…],"balloons":[…],"title":…}
{"v":1,"wait":{"text":"Needs you","in":"chat","ms":600000}} → {"ok":true,"ms":…} | {"ok":false,"error":"timeout",…what was seen}
{"v":1,"wait":{"text":"Saving","gone":true}}
{"v":1,"shot":"/tmp/qr/a/shots/s12.png"}                 → {"ok":true,"path":…}
{"v":1,"film":{"to":"…/f3/f3.png","frames":40,"every":100},"keys":"…"} → {"ok":true,"ms":…,"frames":40}
{"v":1,"quit":true}
```

`see` and `wait` answer at once beside anything else; keys, shots, films and quit play one at a time in order. Each request answers within its own time plus 30 s, else `{"ok":false,"error":"stuck: …"}`.

## Rules

- Isolated always: only qarig envs (or your own dirs with the variables above). Never the installed app, `/Applications`, `~/.config/abe`, the Mac serve, your own projects.
- Fakes only. `qarig up --real` (real GitHub repo copy, AWS box, Claude) is for the release gate run, never a QA agent's check; it reads its GitHub org, repos and AWS profile from `app/scripts/qarig.local.toml` (untracked; copy `qarig.local.example.toml`).
- Clean up: `qarig down` every env you made, also after a failure. `qarig ls` shows what still runs.

## When it breaks

- `no shared build` / `no shared abe`: `qarig rebuild`, or point `QARIG_BIN` / `QARIG_ABE_BIN` at builds.
- `the live app did not come up`: the tail of `logs/live.log` is printed; check the build has `--features shots`.
- `env … was made before …`: `qarig down <name> && qarig up <name>`.
- A refused key (`refused: …`): the grammar above; nothing of that request played.

Tests of the pieces: `cargo test --features shots --test app drive::` (two live apps at once, a balloon's timer), `python3 -m unittest app/scripts/qarig_test.py`.
