# Part: prototype

Optional. Passes when the `prototype-start` hook (`abe/scripts/prototype-start`, unless `abe.yaml`'s `hooks:` names another) starts the app for a prototype and `abe install check prototype` proves it step by step, or when nothing runs here. A repo with no web app leaves it: Done never waits on it. A team part: the script is an ordinary change for the person to commit, in the repo's `abe/` folder.

A prototype is throwaway code on a `proto/…` branch: Abe runs its app from a worktree of its own (this Mac, or a box with its port forwarded) and shows it in VimStorm's preview. Its start is this script. Without one, Abe falls back to the Verification pack's `.claude/skills/run-app/scripts/start`, which may take fixed ports and so can't run two prototypes at once.

Do it after [verify](verify.md): the app runs locally, and the pack's Launch says how it starts.

## 1. Write the script

Write `abe/scripts/prototype-start`, executable (`chmod +x`). Abe runs it in the prototype's worktree with `ABE_PORT_BASE`, `DATABASE_URL` (its own database, seeded by `.claude/skills/run-app/scripts/seed` when just made) and the values of the Abe env file its `# abe-env:` line names. It:

- **listens on `$ABE_PORT_BASE`**: the app's port is `ABE_PORT_BASE`, the rest count up from it (10 ports). Never a fixed port: two prototypes would fight over it. A dev server that pins its port in its config (`server.port` in `vite.config.ts`) is made to read it from the environment;
- **picks its env file** with a `# abe-env: dev` (or `test`) line near its top: the environment whose values a prototype gets, as `abe run --env` hands them; dev when none. Pick the one the app runs against locally (verify's gate passed it); test when dev's backends are not on this machine. It never sources an env file itself: on a box the env files are the box's synced ones, readable only through Abe;
- **signs in**, when the app needs a login to show anything: `# abe-login: <USER_KEY> <PASSWORD_KEY>` names the env file's keys of the account a prototype uses, names only. The script seeds that account or uses it (the app's dev sign-in, a seeded session, a login URL), so the page it prints is signed in. Ask the person which account with `AskUserQuestion` (each candidate by its key and the env file it is in, `No login`, `Not sure: find out`), never a value;
- **starts the app in the background** (`&`, its output to a log under `.scratch/`), **waits until it answers** (`curl -sf` in a loop, a time limit), and **prints the URL to open as its last line**: `http://127.0.0.1:$ABE_PORT_BASE/<page>`. Nothing after it;
- runs anywhere: on this Mac and on a Linux box. No Mac-only paths, `open`, `brew` or `/Applications`; paths from the script's own folder (`root="$(cd "$(dirname "$0")/../.." && pwd)"`).

When the Verification pack's Launch already starts the app on `ABE_PORT_BASE`, reuse it: call `.claude/skills/run-app/scripts/start` from the script (it then prints the URL) and add only what a prototype needs more (its page, its sign-in). Write `abe/scripts/prototype-stop` only when stopping needs more than ending what the start left running (a `docker compose down`): Abe ends the start's process group by itself.

```sh
#!/usr/bin/env bash
# abe-env: dev
# abe-login: SHOP_DEMO_USER SHOP_DEMO_PASS
# Abe passes ABE_PORT_BASE, DATABASE_URL and the dev env file's values.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/.scratch/prototype"
npm --prefix "$root/web" run dev -- --host 127.0.0.1 --port "$ABE_PORT_BASE" \
  >"$root/.scratch/prototype/app.log" 2>&1 &
for _ in $(seq 120); do
  curl -sf "http://127.0.0.1:$ABE_PORT_BASE/" >/dev/null && break
  sleep 1
done
echo "http://127.0.0.1:$ABE_PORT_BASE/products"
```

## 2. Check it

Run `abe install check prototype`. serve starts the script as a prototype's (a throwaway worktree of the default branch with what a card's gets, the script not committed yet too, its own port base and database), then, step by step, each only after the one before passed:

| Step         | Passes when                                                                      | Refused                                                                     |
| ------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `script`     | the script is there and executable; each `# abe-login:` key is in its env file   | `no-start-script`, `start-script-not-executable`, `login-key-missing`       |
| `start`      | its env file's values were had; it ended 0, its last line a URL on this machine  | `env-not-ready`, `start-failed`, `start-timeout` (it never ended), `no-url` |
| `ready`      | the URL's port is within `ABE_PORT_BASE`'s 10, and the app answers there in 20 s | `port-not-base`, `not-ready`                                                |
| `page`       | the printed URL answers 2xx                                                      | `no-page`                                                                   |
| `login`      | with `# abe-login:`, the page is no sign-in page (a password field, `/login`)    | `login-failed`                                                              |
| `screenshot` | this Mac's headless Chrome kept one                                              | `no-screenshot` (a warning: the app ran)                                    |

Then it stops the app, its port base and database go. The line names the failing step, its code and the fix; `abe install status --json` has the try under `prototype` (each step, the URL, the start's log `start.out` and the screenshot, both in serve's state). Fix the script (or the app's port config) and check again. Never pass it by printing a URL the app does not serve.

## After the install

A prototype that does not start (its preview says why, with the start's log) is fixed in the script: edit it, run `abe install check prototype`, and tell the person to commit `abe/scripts/prototype-start`.
