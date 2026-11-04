# 0029 · Agents reach only the enabled environments

Status: accepted, 28 Oct 2026. Supersedes ADR 0028's "one line: never write to prod" (prod as what `abe.prod.env` names, held by reading each command). ADR 0028's three Abe env files and their prefill stand, and so does "secret values never appear in logs".

Holding prod by reading commands could not hold:
- A command line names a host, a database or a profile, but a script it runs, an SDK call or a variable built at run time names none, so a write to prod got through unseen.
- Telling a read from a write needed a parser per tool (curl, aws, cdk, psql, migrations, deploys), and each one missed a form.
- A session could still read prod's keys and hosts, so one mistake was enough.

**Per checkout, each environment is on or off for agents.**
- `agents.dev`, `agents.test` and `agents.prod` are set in your own Layer's block for the checkout (`abe settings set agents.prod true --here`, or Settings › Agents › Environments). By default dev and test are on and prod is off.
- Only you turn an environment on. No org, team or repo Layer, and no Override there, does. A Layer's Reach write name for prod is refused too.
- Turning prod on shows a warning beside its toggle.

**The sandbox holds environment access only.** Only env reach (the env vars and env files of each environment: dev and test on by default, prod only if the person turns it on) and the person's credentials are held. Writes, Unix sockets (Docker, the local database, Playwright) and the network are open: a session writes anywhere but the files that decide its reach (the repo's `.abe/settings.yaml`, `.abe/settings.local.yaml`, the Abe env files) Abe's own state, config and plugins, and the main checkout's git config and hooks (serve's own git runs them, unjailed), so no agent turns prod on for itself; it connects to any socket but serve's, tmux's and another session's. A session's commands reach any host outbound, raw TCP and ssh included: a host that needs no key is fine to reach, and one that needs a key gets none.
- On this Mac every command runs under Abe's own Seatbelt profile (`CLAUDE_CODE_SHELL_PREFIX` → `sandbox-exec`). It writes anywhere but what decides its reach and Abe's own files; it reads none of the person's secrets (`~/.ssh`, `~/.aws`, `~/.azure` or the checkout's az folder, `~/.kube`, `~/.docker/config.json`, `~/.npmrc`, `~/.netrc`, `~/.pgpass`, `~/.my.cnf`, `~/.config/gcloud`, `~/.terraform.d`, `~/.vercel`, `~/.config/op`, `~/.claude.json`, shell histories, the Keychain files, browser profiles), no Abe state but its own folder, no Abe env file of an environment off and no other checkout's; it looks up no Keychain service and connects to no Unix socket under Abe's state but its own session's. Claude's file tools are held by the same paths as deny rules and by Abe's hook fence.
- On a box every command runs in bubblewrap with the network shared: the root written but what decides its reach (read-only), the secrets and the other sockets hidden, its own pid namespace and /proc (no other process's environment; the container runs with its system paths unmasked, which a fresh /proc needs) and Claude Code's login unset before bubblewrap starts (bubblewrap is pid 1 there). The container publishes no port, so nothing comes in.
- Claude Code's own sandbox is off for these sessions (it would hold the network). Every Bash command runs without asking (`Bash` allowed); the deny rules and the hooks still hold. Claude Code's credential scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) is off everywhere: on this Mac it forces sessions out of auto mode, on a box it runs each command in a bubblewrap of its own that forbids the jail's user namespace. Instead the jail drops Claude Code's own `CLAUDE_CODE_*_TOKEN` values before each command, and the session's environment is Abe's allowlist.

**On: reached in full, read and write.** The session reads the environment's Abe env file. Checks and `abe run --env <it>` get its values and its aws profile's short-lived keys.

**aws only through short-lived keys.** `~/.aws` (config, credentials, SSO cache) is denied to every local session's file tools and shell, whatever is enabled, and its shell's aws points at an empty config. `abe run` gets no profile there either (its script reads no `~/.aws`, its config is empty): only the keys of the environment it runs in. So turning test on never lets a session use prod's profile.

**Off: not reached at all, reads included.** No command is read to decide this:
- Its Abe env file is not linked into card worktrees. It is denied to the session's file tools and shell, in the main checkout and the worktree. The install's own session is the exception, because it fills all three files.
- Its aws profile's keys are never handed on.
- The repo env files that feed only it (the install's mapping), and those not placed yet, are denied the same way.
- Its hosts stay reachable, but with no key they take nothing.
- A check or a session's `abe run --env <it>` is refused: "<env> isn't enabled for agents in this repo".

**A change applies to the next session.** A live session launched on other environments is told to finish its turn and write a handoff. A new session starts with the new sandbox.

Considered:
- **Keep the command guard on prod.** That is what could not hold (above).
- **A prod line a Layer can lower.** A team setting could then open prod for everyone by mistake. Prod stays the person's to open, per checkout.
- **Hide prod's hosts.** aws's endpoints are the same for every account, so a host list cannot keep one account out, and a host allowlist kept dev databases and ssh out too (Claude Code's sandbox only proxies HTTP). Keys, not hosts, are what is held.
- **Claude Code's sandbox with an open network.** It has no such mode: it always isolates the network (macOS Seatbelt, Linux's network namespace), and raw TCP never passes its proxy.

Known limits:
- aws: prod's account is the same hosts as test's; only keys tell them apart, and a session gets prod's from nowhere. Checks and `abe run` get the profile's region with its keys; the checks' aws points at empty files too.
- Inbound on this Mac: Seatbelt cannot tell a localhost bind from any other (tried: 0.0.0.0, the LAN address, ::), so a dev server a session starts on all addresses is reachable from the network; that is the Mac firewall's to close. On a box nothing is published.
- A secret kept somewhere the deny list does not name is readable; a new one goes in the list.
- Renames are not held: a command may move a parent folder (`.abe`, the checkout) and put a prepared one in its place (on this machine; on a box the reach files are bind mounts, missing ones too, so they can be neither moved nor created).
- Docker's socket is open (steps need it): a container a session starts can mount any file, a secret or an off environment's env file too. The jail keeps a session from reaching them by mistake, not one set on it.
- `CLAUDE_CODE_SHELL_PREFIX` also wraps hooks and stdio MCP servers: a source's server that writes outside the jail's places (its own token cache) fails there.
- `ps` is setuid and never runs under Seatbelt; `lsof` does. macOS hands a user's process no other process's environment.

Hard to reverse: the keys are written per checkout in every person's Layer, and every session's jail is built from them.

Superseded in part by ADR 0030, 28 Oct 2026: `agents.dev`, `agents.test` and `agents.prod` are set in `.abe/settings.local.yaml` (`--mine`), not your own Layer's block for the checkout. The repo's `.abe/settings.yaml` setting one is refused.
