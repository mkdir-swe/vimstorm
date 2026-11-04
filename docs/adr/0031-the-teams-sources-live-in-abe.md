# 0031 · The team's sources live in .abe: abe.yaml, and .abe/ is yours

Status: accepted, 28 Oct 2026. Supersedes ADR 0027's "source servers live in the main checkout, as Claude Code local scope", and ADR 0030's place for the repo's file (`.abe/settings.yaml`) and the repo's skills (`.abe/skills/`).

ADR 0027 kept each source's MCP server in Claude Code's local scope for the main checkout (`~/.claude.json` `projects[<main>].mcpServers`), and Abe generated each session's MCP config from there. That could not hold:
- A person could not see which servers their repo's sessions load: they lived in a file of Claude Code's, not in the repo.
- A teammate who pulled the repo got none of them. Each person added each server by hand, or through their own install, and the definitions drifted apart.
- Every other factory setting moved into the repo (ADR 0030). Sources were the one left out.
- `.abe/` held both the team's files and yours (env files with secrets, your settings). Local only kept the whole folder out of git, the team's file with it, and Connected had to pick files out of it.

**The team's file is `abe.yaml` at the repo's root; `.abe/` is yours alone.**
- `abe.yaml` (was `.abe/settings.yaml`) holds board, environments, checks, setup, Overrides and `sources:`. `.claude/skills/` (was `.abe/skills/`) holds the repo's skills and the Verification pack.
- Abe writes both as ordinary files: they show in `git diff`, and the person commits and pushes them. Abe never commits them and never puts them in `.git/info/exclude`.
- `.abe/` is local only and always in `.git/info/exclude`: the Abe env files, `.abe/settings.local.yaml` and Abe's records.
- One constant names each place (`REPO_PATH`, `REPO_SKILLS_DIR`): every reader and writer takes it from there.
- No migration: an old `.abe/settings.yaml` or `.abe/skills/` is not read.

**Your logins are yours for the repo.** `.abe/settings.local.yaml` takes `logins: { gh, az }`, your account names per tool, never a token. `logins.gh` is the gh login Abe reads and writes GitHub as; `github.account`, its old name, is read when it is unset, and Abe writes `logins.gh`. The repo's `logins:` in `abe.yaml` stays the list of logins the repo needs.

**The team's sources are `sources:` in `abe.yaml`.** Each entry is `{ name, transport: http | sse | stdio, url }`, or for stdio `{ name, transport: stdio, command, args }`. The person commits it with the rest of `abe.yaml`; Abe never does. There are no personal sources: `sources:` in `.abe/settings.local.yaml` is refused `team-only`.

**Never a secret.** A header or env value in `sources:` is a `${VAR}` reference, Claude Code's own. A literal value is refused with its key named and its value never said. Tokens stay in Claude Code's own store: you sign in once.

**Every session's generated config is built from `sources:`.** A card's, a linked worktree's and an install's session on this Mac get the main checkout's `sources:`, never a worktree's copy. Each server goes in under its name with the definition Claude Code keeps for it (`type`, `url`, `headers`; or `command`, `args`, `env`). Claude Code keys a stored sign-in by name and definition, so a server you already signed in to with the same definition is signed in for the session too. A server of yours that `sources:` does not name never loads. Everything else in ADR 0027 stays:
- only a source whose check at the install passed (signed in, its one read ok) starts;
- `MCP_TIMEOUT` 15 s;
- `--strict-mcp-config`;
- the config file is mode 600, in serve's state, out of every sandbox's reach, and goes when the session ends.

**Adding one.** `abe install source <name|url>` writes `sources:`:
- a server your Claude Code has for the main checkout, its definition copied as it is;
- or a new one by URL or command.

One name never gets two definitions: a name your Claude Code or `sources:` has with another one is refused. Claude Code's needs-auth cache is keyed by name, and the other definition would skip connecting for minutes. `abe install sources --json` lists `sources:`, then each server your Claude Code has for the main checkout (its local scope, then your user scope) that `sources:` does not define, marked `found: local-scope | user-scope`. Only you or the install's session adds one, never another session.

**Migration, once, by asking.** A bare name in `sources:` (ADR 0027's shape) is still read from your Claude Code, the local scope then the user scope, until `abe install source <name>` writes its definition in its place. The install offers each found server to the person, and adds only those they say yes to. Abe never runs `claude mcp remove`: it deletes the token every session shares. The local-scope servers stay where they are, and keep working for your own Claude Code.

Considered:
- **Keep the local scope, as ADR 0027 did.** Nothing to see in the repo, and nothing shared with the team.
- **A `.mcp.json` in the repo.** Claude Code loads it in every session of the person's own and asks to approve each server. A card's session never loads a repo's `.mcp.json` (`--strict-mcp-config`), and one file for two readers drifts.
- **`sources:` in yours for the repo.** Personal sources, which the spec rules out: the team reads the same servers.

Hard to reverse: the install writes `sources:` into the team's file, and teammates' sessions load what it names. Going back means reading the local scope again and leaving those entries unread. Repos installed before keep a `.abe/settings.yaml` Abe no longer reads: they install again.

Superseded in part by ADR 0033, 29 Oct 2026: the team's workflows are files, `abe/workflows/<id>.yaml`, not `workflows:` in `abe.yaml`, which is no longer read.

Amended 1 Nov 2026: migration removed: no install predates it (`github.account` read as `logins.gh`).
