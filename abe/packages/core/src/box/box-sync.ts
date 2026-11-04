/**
 * Box parity (3.2.1): what the Mac's serve sends a card's box workspace at launch and, when
 * something changed on the Mac, before each turn, so the box runs on what the person has locally.
 * Into the clone: the team's files the Mac changed and has not committed (`abe.yaml`,
 * `abe/workflows`, `abe/skills`, `.claude/skills`, the hook scripts' folders: its working copy
 * where it differs from the card's base), yours for the repo
 * (`.abe/settings.local.yaml`) and the Abe env files of the environments on for agents (prod only
 * when on), and the repo's worktree recipe's files (`worktree.link` and `copy`, the `worktree-setup` hook,
 * an env file of an environment off for agents left out: `recipeCopies`), each where the clone
 * does not track one: a link's replaced at each sync, a copy's put in once, the card's after.
 * Into a folder of the container's home no command sees (`SYNC_DIR`): the
 * access tokens of the repo's sources, merged into the box's Claude Code store under the key the
 * Mac's has (the Mac stays the owner and renews them), each environment's aws short-lived keys,
 * and your values for the sources' `${VAR}` references (`SYNC_SOURCE_VALUES`).
 * All of it crosses on stdin (`BOX_SYNC_SCRIPT`), never in an argv or a log; what it puts in is
 * read-only on the box, the team's files it changed held out of the card's commits
 * (`--skip-worktree`, `SYNC_LOCKED` lists them); a team file the Mac has unchanged stays the card's
 * own, writable and committed as usual (a card keeps its Verification pack on its branch). It is
 * gone with the workspace. Nothing goes from the box to the Mac. Pure: serve reads and sends.
 */
import { z } from 'zod';
import { DEFAULT_HOOKS, hookScriptDirs, REPO_SKILLS_DIR, RepoHooks } from '../repo-hooks';
import { ABE_ENVS, type AbeEnv, abeEnvFile } from '../install/credentials';
import { SOURCE_VALUES_PATH } from '../install/source-servers';
import {
  LOCAL_PATH,
  REPO_ABE_SKILLS_DIR,
  REPO_PATH,
  REPO_WORKFLOWS_DIR,
} from '../layer/settings/places';

/**
 * The team's paths whose uncommitted changes on the Mac a sync carries, held out of commits:
 * `abe.yaml`, Abe's workflows and skills in the repo, the repo's skills, and the folder of each
 * of the repo's hook scripts (`hooks`: the maps the Mac has, its settings' and its committed
 * one's). A path inside another is left out.
 */
export const syncTeamPaths = (...hooks: readonly RepoHooks[]): string[] => {
  const all = [
    ...new Set([
      REPO_PATH,
      REPO_WORKFLOWS_DIR,
      REPO_ABE_SKILLS_DIR,
      REPO_SKILLS_DIR,
      ...hooks.flatMap(hookScriptDirs),
    ]),
  ];

  return all.filter((p) => !all.some((o) => o !== p && p.startsWith(`${o}/`)));
};

/** Whether a path (from the top) is one of the team's a sync carries (`paths`, `syncTeamPaths`). */
export const isSyncTeamPath = (paths: readonly string[], path: string): boolean =>
  paths.some((p) => path === p || path.startsWith(`${p}/`));

/** Yours in the clone a sync owns: each one replaced, or removed when not sent. */
export const SYNC_YOURS_PATHS: readonly string[] = [LOCAL_PATH, ...ABE_ENVS.map(abeEnvFile)];

/** Where a sync's secrets are, from the container's home: hidden from every command. */
export const SYNC_DIR = '.abe/sync';

/**
 * Your values for the sources' `${VAR}` references (`SOURCE_VALUES_PATH` on the Mac), in
 * `SYNC_DIR`: the box's session's generated MCP config is filled from them, never the clone
 * (a command there reads it) nor the session's env.
 */
export const SYNC_SOURCE_VALUES = `${SYNC_DIR}/sources.env`;

/**
 * The team's paths the last sync changed in the clone, one a line from its top (in `SYNC_DIR`):
 * read-only to the session's commands (`boxJailScript`), given back to the card at the next sync.
 */
export const SYNC_LOCKED = `${SYNC_DIR}/locked`;

/**
 * The recipe's linked files the last sync wrote in the clone, one a line from its top (in
 * `SYNC_DIR`): removed at the next sync before it writes the ones the Mac has now.
 */
export const SYNC_RECIPE = `${SYNC_DIR}/recipe`;

/**
 * The block of the clone's `info/exclude` a sync owns (its first and last lines): the team's paths
 * it wrote that the clone does not track, anchored at the root, written anew at each sync.
 */
const EXCLUDE_START = '# Abe sync: the team files the Mac has not committed';
const EXCLUDE_END = '# Abe sync end';

/** A source's token is sent again once it is this close to its end (or past it). */
export const SYNC_TOKEN_MARGIN_MS = 5 * 60_000;

/** An environment's aws keys are fetched again after this long (they last an hour at least). */
export const SYNC_AWS_EVERY_MS = 30 * 60_000;

/** A file a sync writes: its path (from the clone's top, or `SYNC_DIR`), mode, bytes in base64. */
export type SyncFile = {
  path: string;
  mode: '400' | '444' | '555' | '600' | '644' | '755';
  base64: string;
};

/**
 * One of the recipe's files a sync writes in the clone: `link`, the Mac's, replaced at each sync
 * (read-only); `copy`, put in only where the clone has none, the card's own from then on.
 */
export type SyncRecipeFile = SyncFile & { kind: 'link' | 'copy' };

/** A source's access token as Claude Code keeps one (`mcpOAuth[key]`), without its refresh token. */
export const McpAccess = z.object({
  serverName: z.string(),
  serverUrl: z.string(),
  accessToken: z.string().min(1),
  expiresAt: z.number().optional(),
});
export type McpAccess = z.infer<typeof McpAccess>;

/** What one sync sends: the clone's files, the secrets, and what the box is told of them. */
export type BoxSync = {
  /** The team's files the Mac changed and has not committed (`isSyncTeamPath`), from the top. */
  team: readonly SyncFile[];
  /** The team's paths it carries (`syncTeamPaths`); none: today's places'. */
  teamPaths?: readonly string[];
  /** The team's files the Mac deleted and has not committed. */
  gone: readonly string[];
  /** Yours (`SYNC_YOURS_PATHS`): your settings for the repo, the Abe env files. */
  yours: readonly SyncFile[];
  /** The repo's worktree recipe's files, from the Mac's main checkout (`SyncRecipeFile`). */
  recipe?: readonly SyncRecipeFile[];
  /** The environments whose Abe env file is among `yours`. */
  envs: readonly AbeEnv[];
  /** The sources' access tokens by Claude Code's key (`<name>|<hash>`, the Mac's own). */
  mcp: Readonly<Record<string, McpAccess>>;
  /** Each environment's aws short-lived keys, as a process gets them (`AWS_ACCESS_KEY_ID`, …). */
  aws: Partial<Record<AbeEnv, Readonly<Record<string, string>>>>;
  /** Your `SOURCE_VALUES_PATH`'s text (`SYNC_SOURCE_VALUES` on the box); none: you have none. */
  sourceValues?: string;
};

/**
 * The environments whose Abe env file a sync sends: those on for agents (`on`, the checkout's
 * `agents.<env>`; dev and test by default), prod only when it is on.
 */
export const syncedEnvs = (on: (env: AbeEnv) => boolean | undefined): AbeEnv[] =>
  ABE_ENVS.filter((env) => on(env) ?? env !== 'prod');

/** A path a sync takes: relative, inside, one line, no `..`. */
export const syncPathOk = (path: string): boolean =>
  path !== '' &&
  !path.startsWith('/') &&
  !/[\t\n\r\0\\]/.test(path) &&
  !path.split('/').some((p) => p === '..' || p === '.' || p === '');

const Store = z.looseObject({ mcpOAuth: z.record(z.string(), z.unknown()).optional() });
const Stored = z.looseObject({
  serverName: z.string(),
  serverUrl: z.string(),
  accessToken: z.string(),
  expiresAt: z.number().optional(),
});

/**
 * The access token Claude Code's store (`store`, its parsed JSON: the Keychain's on a Mac, else
 * `~/.claude/.credentials.json`) keeps for each remote server of `servers` (name to definition, as
 * a session's generated config has it): the entry of that name and URL with a token, the latest
 * ending first, under its own key, so the box's Claude Code reads it for the same definition.
 * Never its refresh token or client secret: the Mac keeps renewing it.
 */
export const mcpAccessOf = (
  store: unknown,
  servers: Readonly<Record<string, unknown>>,
): Record<string, McpAccess> => {
  const entries = Object.entries(Store.safeParse(store).data?.mcpOAuth ?? {}).flatMap(
    ([key, value]) => {
      const e = Stored.safeParse(value);

      return e.success && e.data.accessToken !== '' ? [{ key, e: e.data }] : [];
    },
  );
  const out: Record<string, McpAccess> = {};

  for (const [name, def] of Object.entries(servers)) {
    const url = z.looseObject({ url: z.string() }).safeParse(def).data?.url;

    if (url === undefined) continue;
    const found = entries
      .filter(
        ({ key, e }) => key.startsWith(`${name}|`) && e.serverName === name && e.serverUrl === url,
      )
      .sort((a, b) => (b.e.expiresAt ?? Infinity) - (a.e.expiresAt ?? Infinity))[0];

    if (found !== undefined)
      out[found.key] = {
        serverName: name,
        serverUrl: url,
        accessToken: found.e.accessToken,
        ...(found.e.expiresAt === undefined ? {} : { expiresAt: found.e.expiresAt }),
      };
  }

  return out;
};

/** Whether a token ends within `SYNC_TOKEN_MARGIN_MS` of `now` (or has). */
export const mcpAccessEnding = (a: McpAccess, now: number): boolean =>
  a.expiresAt !== undefined && a.expiresAt - SYNC_TOKEN_MARGIN_MS <= now;

/** The server names of `servers` that have no token in `mcp` that lasts. */
export const mcpAccessWanted = (
  servers: Readonly<Record<string, unknown>>,
  mcp: Readonly<Record<string, McpAccess>>,
  now: number,
): string[] =>
  Object.keys(servers).filter(
    (name) =>
      z.looseObject({ url: z.string() }).safeParse(servers[name]).success &&
      !Object.values(mcp).some((a) => a.serverName === name && !mcpAccessEnding(a, now)),
  );

/**
 * A sync as `BOX_SYNC_SCRIPT` reads it on stdin: yours (each of `SYNC_YOURS_PATHS` removed first),
 * the team's changed and deleted files, and the secrets under `SYNC_DIR` (`base64`: a text's UTF-8
 * bytes in base64, the caller's). A team path that is none is refused.
 */
export const boxSyncPayload = (s: BoxSync, base64: (text: string) => string): string => {
  const secrets: SyncFile[] = [
    ...(Object.keys(s.mcp).length === 0
      ? []
      : [{ path: 'mcp.json', mode: '600' as const, base64: base64(JSON.stringify(s.mcp)) }]),
    ...ABE_ENVS.flatMap((env) => {
      const keys = s.aws[env];

      return keys === undefined
        ? []
        : [{ path: `aws/${env}.json`, mode: '600' as const, base64: base64(JSON.stringify(keys)) }];
    }),
    ...(s.sourceValues === undefined
      ? []
      : [
          {
            path: SYNC_SOURCE_VALUES.slice(SYNC_DIR.length + 1),
            mode: '600' as const,
            base64: base64(s.sourceValues),
          },
        ]),
  ];
  const row = (f: SyncFile) => {
    if (!syncPathOk(f.path)) throw new Error(`not a path a sync writes: ${f.path}`);

    return { p: f.path, m: f.mode, b: f.base64 };
  };

  const team = (path: string) => {
    if (!isSyncTeamPath(s.teamPaths ?? syncTeamPaths(DEFAULT_HOOKS), path) || !syncPathOk(path))
      throw new Error(`not a team path a sync writes: ${path}`);

    return path;
  };

  return JSON.stringify({
    // and your source values where an older sync put them, in the clone
    remove: [...SYNC_YOURS_PATHS, SOURCE_VALUES_PATH],
    files: s.yours.map(row),
    recipe: (s.recipe ?? []).map((f) => ({ ...row(f), k: f.kind })),
    team: s.team.map((f) => ({ ...row(f), p: team(f.path) })),
    gone: s.gone.map(team),
    secrets: secrets.map(row),
  });
};

/**
 * The sync in the container (sh, as the session user; `jq`, `base64` and `git` there): args the
 * clone and the home, the payload (`boxSyncPayload`) on stdin, kept in a file of the home's alone
 * until it ends. The team's paths the last sync changed (`SYNC_LOCKED`) given back to the card
 * (its base's, writable, no longer skip-worktree); then each team file the Mac changed written
 * read-only where it differs from the card's base (`HEAD`), each it deleted removed, those the
 * clone tracks marked `--skip-worktree`, those it does not kept out by the sync's own block of
 * the clone's `info/exclude` (written anew, so one given back is seen again), and listed anew;
 * the recipe's linked files the last sync wrote (`SYNC_RECIPE`) removed, then each recipe file the
 * clone does not track written (a copy only where the clone has none), kept out by the same block
 * and its links listed anew;
 * yours removed and written (env files 0400); the secrets put in `SYNC_DIR` anew (0600 in a 0700
 * folder); the sources' tokens merged into Claude Code's own store (`~/.claude/.credentials.json`,
 * 0600, through a rename). Exit 3: no clone; 8: a path out of it; 9: no payload.
 */
export const BOX_SYNC_SCRIPT = `set -eu
umask 077
repo=$1 home=$2
t=$(mktemp -d "$home/.abe-sync.XXXXXX")
trap 'rm -rf "$t"' EXIT
cat > "$t/in.json"
jq -e 'type == "object"' "$t/in.json" >/dev/null 2>&1 || exit 9
safe() { case "$1" in ''|/*|..|../*|*/..|*/../*) exit 8;; esac; }
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
tracked() { g ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }
writable() { if [ -e "$1" ] || [ -L "$1" ]; then chmod u+w -- "$1" 2>/dev/null || true; fi; }
tab=$(printf '\t')
s="$home/${SYNC_DIR}"
cd -- "$repo" 2>/dev/null || exit 3
g rev-parse --git-dir >/dev/null 2>&1 || exit 3
: > "$t/was"
if [ -f "$home/${SYNC_LOCKED}" ]; then cp -- "$home/${SYNC_LOCKED}" "$t/was"; fi
while IFS= read -r p; do
  safe "$p"
  writable "$p"
  if tracked "$p"; then
    g update-index --no-skip-worktree -- "$p"
    if g cat-file -e "HEAD:$p" 2>/dev/null; then g checkout -q HEAD -- "$p"; else rm -f -- "$p"; fi
  else
    rm -f -- "$p"
  fi
done < "$t/was"
umask 022
: > "$t/locked"
: > "$t/untracked"
jq -r '.team[] | [.p, .m, .b] | @tsv' "$t/in.json" > "$t/team"
while IFS="$tab" read -r p m b; do
  safe "$p"
  printf '%s' "$b" | base64 -d > "$t/blob"
  if g cat-file -e "HEAD:$p" 2>/dev/null && [ "$(g rev-parse "HEAD:$p")" = "$(g hash-object -- "$t/blob")" ]; then
    continue
  fi
  mkdir -p -- "$(dirname -- "$p")"
  writable "$p"
  rm -f -- "$p"
  cp -- "$t/blob" "$p"
  chmod "$m" "$p"
  if tracked "$p"; then g update-index --skip-worktree -- "$p"; else printf '/%s\n' "$p" >> "$t/untracked"; fi
  printf '%s\n' "$p" >> "$t/locked"
done < "$t/team"
if [ -f "$home/${SYNC_RECIPE}" ]; then
  while IFS= read -r p; do
    safe "$p"
    if ! tracked "$p"; then writable "$p"; rm -f -- "$p"; fi
  done < "$home/${SYNC_RECIPE}"
fi
: > "$t/recipe"
jq -r '(.recipe // [])[] | [.p, .m, .b, .k] | @tsv' "$t/in.json" > "$t/rl"
while IFS="$tab" read -r p m b k; do
  safe "$p"
  if tracked "$p"; then continue; fi
  printf '/%s\n' "$p" >> "$t/untracked"
  if [ "$k" = copy ] && { [ -e "$p" ] || [ -L "$p" ]; }; then continue; fi
  mkdir -p -- "$(dirname -- "$p")"
  writable "$p"
  rm -f -- "$p"
  printf '%s' "$b" | base64 -d > "$p"
  chmod "$m" "$p"
  if [ "$k" = link ]; then printf '%s\n' "$p" >> "$t/recipe"; fi
done < "$t/rl"
ex=$(g rev-parse --git-path info/exclude)
mkdir -p -- "$(dirname -- "$ex")"
if [ -f "$ex" ]; then sed '/^${EXCLUDE_START}$/,/^${EXCLUDE_END}$/d' "$ex" > "$t/ex"; else : > "$t/ex"; fi
if [ -s "$t/untracked" ]; then { printf '%s\n' '${EXCLUDE_START}'; cat "$t/untracked"; printf '%s\n' '${EXCLUDE_END}'; } >> "$t/ex"; fi
cat "$t/ex" > "$ex"
jq -r '.gone[]' "$t/in.json" > "$t/gone"
while IFS= read -r p; do
  safe "$p"
  if tracked "$p"; then
    writable "$p"
    rm -f -- "$p"
    g update-index --skip-worktree -- "$p"
    printf '%s\n' "$p" >> "$t/locked"
  fi
done < "$t/gone"
jq -r '.remove[]' "$t/in.json" > "$t/remove"
while IFS= read -r p; do
  safe "$p"
  writable "$p"
  rm -f -- "$p"
done < "$t/remove"
jq -r '.files[] | [.p, .m, .b] | @tsv' "$t/in.json" > "$t/files"
while IFS="$tab" read -r p m b; do
  safe "$p"
  mkdir -p -- "$(dirname -- "$p")"
  printf '%s' "$b" | base64 -d > "$p"
  chmod "$m" "$p"
done < "$t/files"
umask 077
rm -rf -- "$s"
mkdir -p -- "$s"
chmod 700 "$home/.abe" "$s"
cp -- "$t/locked" "$home/${SYNC_LOCKED}"
cp -- "$t/recipe" "$home/${SYNC_RECIPE}"
jq -r '.secrets[] | [.p, .m, .b] | @tsv' "$t/in.json" > "$t/secrets"
while IFS="$tab" read -r p m b; do
  safe "$p"
  mkdir -p -- "$s/$(dirname -- "$p")"
  printf '%s' "$b" | base64 -d > "$s/$p"
  chmod "$m" "$s/$p"
done < "$t/secrets"
if [ -f "$s/mcp.json" ]; then
  c="$home/.claude/.credentials.json"
  mkdir -p -- "$home/.claude"
  if ! jq -e 'type == "object"' "$c" >/dev/null 2>&1; then printf '{}' > "$c"; fi
  jq --slurpfile m "$s/mcp.json" '.mcpOAuth = ((.mcpOAuth // {}) + $m[0])' "$c" > "$t/c.json"
  chmod 600 "$t/c.json"
  mv -f -- "$t/c.json" "$c"
fi`;

/**
 * What `abe session run --sync` and `abe session sync` tell the box of a sync (3.2.1): no secret,
 * only names and the team's file.
 */
export const SessionSync = z.object({
  /** The Mac's working copy of `abe.yaml` (its text; null: none there), the box checkout's from now on. */
  repo: z.string().nullable(),
  /** The sources the Mac's install checked (`checkedSourceServers`): only these start on the box. */
  checked: z.array(z.string()),
  /** The environments whose Abe env file is in the clone now. */
  envFiles: z.array(z.enum(ABE_ENVS)),
  /**
   * The team's paths the Mac changed (`BoxSync.team`, `gone`): its file tools write none of them
   * there (`managedSettings`); one the card's base has the same stays writable to its commands.
   */
  locked: z.array(z.string()).default([]),
  /**
   * The repo's hook points as the Mac's main checkout has them committed (`HEAD:abe.yaml`): what
   * the box's `abe run` may run (`packScript`), never read from the clone. None: an older Mac's,
   * today's places.
   */
  hooks: RepoHooks.optional(),
});
export type SessionSync = z.infer<typeof SessionSync>;

/** `abe session sync`'s answer: the repo whose box checkout took the Mac's `abe.yaml`. */
export const SessionSyncData = z.object({ repo: z.string() });
export type SessionSyncData = z.infer<typeof SessionSyncData>;
