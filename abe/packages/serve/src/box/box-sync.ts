/**
 * Box parity from the Mac (3.2.1, core's `box-sync.ts`): what a card's box workspace gets so it runs
 * on what the person has here. Built from the main checkout of the checkout a launch came from:
 * the `abe.yaml` and `.claude/skills` files the person changed there and has not committed
 * (`teamChanges`), yours for the repo (`.abe/settings.local.yaml`,
 * without what is this Mac's alone), the Abe env files of the environments on for agents (prod only
 * when on), the access tokens Claude Code keeps here for the sources the install checked (a token
 * about to end renewed first by this Mac's Claude Code, its owner), each such environment's aws
 * short-lived keys from your profile for it, your values for the sources' references
 * (`SOURCE_VALUES_PATH`), and the repo's worktree recipe's files
 * (`recipeFiles`). `mark` is the cheap look before a turn (the files'
 * sizes and times and the environments on); `due` when a token or key wants sending again. Its
 * values are never logged: what failed says its names.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AbeEnv,
  ABE_ENVS,
  type EnvFileTo,
  abeEnvFile,
  agentEnvKey,
  type Answered,
  type BoxSync,
  type BoxSyncPort,
  boxSyncPayload,
  handedLayer,
  isSyncTeamPath,
  type InstallRepo,
  LOCAL_PATH,
  SOURCE_VALUES_PATH,
  localFile,
  mcpAccessOf,
  mcpAccessWanted,
  type McpAccess,
  type Outcome,
  REPO_PATH,
  type SessionSync,
  sourceServers,
  type SyncFile,
  type SyncRecipeFile,
  recipeCopies,
  recipePaths,
  withEveryRun,
  SYNC_AWS_EVERY_MS,
  SYNC_TOKEN_MARGIN_MS,
  syncedEnvs,
  syncPathOk,
  syncTeamPaths,
  repoHooksIn,
  type WorktreeRecipe,
} from '@abe/core';
import {
  claudeConfigFile,
  committedHooks,
  mainCheckout,
  readYamlFile,
  repoRoot,
  runOwn,
  yamlText,
} from '@abe/ports';
import { launchSettings } from '../session/sessions';
import { type SettingsService } from '../layer/settings';

/** A sync built for a launch or a turn: what goes, what the box is told, and when it is stale. */
export type BuiltSync = {
  sync: BoxSync;
  told: SessionSync;
  /** `mark` when it was built. */
  mark: string;
  /** When a token or aws key it holds wants sending again (ms); none: never by time. */
  due: number | null;
};

export type BoxSyncer = {
  /** The sync for a launch from `where` (its main checkout's), built now. */
  build: (where: string | null) => Promise<Outcome<BuiltSync>>;
  /** The cheap look at `where`'s files before a turn: a sync is built again when it differs. */
  mark: (where: string | null) => Promise<string>;
  /** `built` into the workspace `exec` reaches, on stdin. */
  push: (exec: readonly string[], built: BuiltSync) => Promise<Answered<null>>;
};

const MODES = { file: '444', exec: '555', secret: '400' } as const;

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** The main checkout of `where`, or none. */
const mainOf = (where: string | null): string | undefined => {
  const top = where === null ? undefined : repoRoot(where);

  return top === undefined ? undefined : (mainCheckout(top) ?? top);
};

/** Each file under `dir` (from `top`), symlinks and other kinds left out; in name order. */
const filesUnder = (top: string, dir: string): string[] => {
  const at = join(top, dir);
  let names: string[];

  try {
    names = readdirSync(at).sort();
  } catch {
    return [];
  }

  return names.flatMap((name) => {
    const rel = `${dir}/${name}`;
    const st = lstatSync(join(top, rel));

    if (st.isDirectory()) return filesUnder(top, rel);

    return st.isFile() && syncPathOk(rel) ? [rel] : [];
  });
};

/** Each of `paths` (from `top`) that is there: its size and time, so a change shows. */
const statsOf = (top: string, paths: readonly string[]): string =>
  paths
    .map((p) => {
      try {
        const st = statSync(join(top, p));

        return `${p}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${p}:-`;
      }
    })
    .join('\n');

export const boxSyncer = (o: {
  port: BoxSyncPort;
  settings: SettingsService;
  repo: InstallRepo;
  /** The sources the checkout's install checked (`checkedSourceServers`): only these are synced. */
  checked: (main: string) => Promise<readonly string[]>;
  /** The person's home: their Claude Code config, for a source named bare. */
  home: string | undefined;
  /**
   * The install's env map of the checkout (each repo env file and the environments it feeds), read
   * after abe.yaml's worktree groups (ADR 0040): a recipe's env file feeding only environments off
   * for agents is never synced. None: none.
   */
  envMap?: (main: string) => Promise<readonly { path: string; to: EnvFileTo }[]>;
  now: () => number;
  log: (message: string) => void;
}): BoxSyncer => {
  const enabledAt = (main: string): AbeEnv[] => {
    const values = o.settings.at(main).values;

    return syncedEnvs((env) => values[agentEnvKey(env)]);
  };

  /** The recipe's paths in `main` (`worktree.link`, `copy`), skips not yet judged. */
  const recipeAt = (main: string) => launchSettings({ settings: o.settings }, main).worktree;
  /** The hook points `main`'s settings have in force: its scripts, the worktree's among them. */
  const hooksAt = (main: string) => repoHooksIn(o.settings.at(main).values);

  const mark = async (where: string | null): Promise<string> => {
    const main = mainOf(where);

    if (main === undefined) return '';
    const recipe = recipeAt(main);
    const run = hooksAt(main)['worktree-setup'];
    const team = [
      REPO_PATH,
      LOCAL_PATH,
      ...ABE_ENVS.map(abeEnvFile),
      SOURCE_VALUES_PATH,
      // the team's paths a sync carries: Abe's workflows and skills, the repo's, the hook scripts'
      ...syncTeamPaths(hooksAt(main), await committedHooks(main))
        .filter((p) => p !== REPO_PATH)
        .flatMap((p) => filesAt(main, p)),
      ...[
        ...recipePaths(recipe?.link),
        ...recipePaths(recipe?.copy),
        ...(run === null ? [] : [run]),
      ]
        .filter(syncPathOk)
        .flatMap((p) => filesAt(main, p)),
    ];

    // a commit moves what is the person's uncommitted change
    const head = (await runOwn(['git', '-C', main, 'rev-parse', '-q', '--verify', 'HEAD'])).stdout;

    return createHash('sha256')
      .update(`${enabledAt(main).join(',')}\n${head}\n${statsOf(main, team)}`)
      .digest('hex');
  };

  /** The sources a session here loads, of those the install checked: name to definition. */
  const serversAt = (main: string, checked: readonly string[]) => {
    const sources = launchSettings({ settings: o.settings }, main).sources ?? [];
    let config: unknown = {};

    if (o.home !== undefined && sources.some((s) => typeof s === 'string'))
      try {
        config = JSON.parse(readFileSync(claudeConfigFile(o.home), 'utf8'));
      } catch {
        // no config: a bare name is none
      }
    const found = sourceServers({ config, mains: [main], sources });

    return Object.fromEntries(Object.entries(found.servers).filter(([n]) => checked.includes(n)));
  };

  /** The sources' tokens: those about to end renewed by this Mac's Claude Code first. */
  const tokensFor = async (
    main: string,
    servers: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, McpAccess>> => {
    if (Object.keys(servers).length === 0) return {};
    const first = mcpAccessOf(await o.port.claudeStore(), servers);
    const wanted = mcpAccessWanted(servers, first, o.now());

    if (wanted.length === 0) return first;
    // connecting a session's way renews the token (its refresh token stays here, Claude Code's)
    for (const name of wanted) await o.repo.mcp(main, name);
    const again = mcpAccessOf(await o.port.claudeStore(), servers);
    const still = mcpAccessWanted(servers, again, o.now());

    if (still.length > 0) o.log(`box sync: no live token for ${still.join(', ')} (sign in again)`);

    return again;
  };

  const build = async (where: string | null): Promise<Outcome<BuiltSync>> => {
    const main = mainOf(where);

    if (main === undefined)
      return {
        ok: false,
        error: { code: 'not-a-checkout', message: `${where ?? ''}: no checkout` },
      };
    const before = await mark(where);
    const envs = enabledAt(main);
    const text = (path: string) => {
      try {
        return readFileSync(join(main, path), 'utf8');
      } catch {
        return undefined;
      }
    };
    const raw = (path: string, mode: SyncFile['mode']): SyncFile | undefined => {
      try {
        return { path, mode, base64: readFileSync(join(main, path)).toString('base64') };
      } catch {
        return undefined;
      }
    };
    const team = text(REPO_PATH);
    const hooks = hooksAt(main);
    // what the box's abe run may run: the committed abe.yaml's, never the clone's
    const committed = await committedHooks(main);
    const teamPaths = syncTeamPaths(hooks, committed);
    // the team's files the person changed here and has not committed: the rest is the card's own
    const changed = await teamChanges(main, teamPaths);
    const teamFiles = changed.files.flatMap((p) => {
      const exec = (statSync(join(main, p)).mode & 0o111) !== 0;
      const f = raw(p, exec ? MODES.exec : MODES.file);

      return f === undefined ? [] : [f];
    });
    // yours for the repo, without what is this Mac's alone (its aws profiles, TEST yes)
    const localText = text(LOCAL_PATH);
    const local =
      localText === undefined
        ? []
        : [
            {
              path: LOCAL_PATH,
              mode: MODES.file,
              base64: base64(yamlText(localText, handedLayer({}, readYaml(localFile(main))).local)),
            },
          ];
    // your values for the sources' references: the box's session's MCP config is filled from them
    const sourceValues = text(SOURCE_VALUES_PATH);
    const envFiles = envs.flatMap((env) => {
      const f = raw(abeEnvFile(env), MODES.secret);

      return f === undefined ? [] : [{ env, f }];
    });
    const recipe = recipeFiles(
      main,
      recipeAt(main),
      hooks['worktree-setup'],
      (await o.envMap?.(main)) ?? [],
      envs,
    );

    for (const [path, why] of Object.entries(recipe.skipped))
      o.log(`box sync: ${path} not synced (${why})`);
    const checked = await o.checked(main);
    const servers = serversAt(main, checked);
    const mcp = await tokensFor(main, servers);
    const aws: Partial<Record<AbeEnv, Record<string, string>>> = {};
    const profiles = o.settings.at(main).values.credentials;

    for (const env of envs) {
      const profile = profiles[env]?.awsProfile;

      if (profile === undefined || profile === null) continue;
      const keys = await o.repo.awsCredentials(profile);

      if (keys.ok) aws[env] = keys.env;
      else o.log(`box sync: no aws keys for ${env} (profile ${profile})`);
    }
    const now = o.now();
    const ends = Object.values(mcp).flatMap((a) =>
      a.expiresAt === undefined ? [] : [a.expiresAt - SYNC_TOKEN_MARGIN_MS],
    );
    const dues = [...ends, ...(Object.keys(aws).length === 0 ? [] : [now + SYNC_AWS_EVERY_MS])];

    return {
      ok: true,
      data: {
        sync: {
          team: teamFiles,
          teamPaths,
          gone: changed.gone,
          yours: [...local, ...envFiles.map((e) => e.f)],
          recipe: recipe.files,
          envs: envFiles.map((e) => e.env),
          mcp,
          aws,
          ...(sourceValues === undefined ? {} : { sourceValues }),
        },
        told: {
          repo: team ?? null,
          checked: Object.keys(servers),
          envFiles: envFiles.map((e) => e.env),
          locked: [...teamFiles.map((f) => f.path), ...changed.gone],
          hooks: committed,
        },
        mark: before,
        due: dues.length === 0 ? null : Math.min(...dues),
      },
    };
  };

  return {
    build,
    mark,
    push: (exec, built) => o.port.push(exec, boxSyncPayload(built.sync, base64)),
  };
};

/** At most this many of the recipe's files go in one sync, and at most this many bytes. */
const RECIPE_FILES_MAX = 2000;
const RECIPE_BYTES_MAX = 32 * 1024 * 1024;

/** A recipe file's mode on the box: a link's read-only (the Mac's), a copy's the card's to write. */
const RECIPE_MODES = {
  link: { file: MODES.file, exec: MODES.exec },
  copy: { file: '644', exec: '755' },
} as const satisfies Record<SyncRecipeFile['kind'], Record<'file' | 'exec', SyncFile['mode']>>;

/** The files at `path` in `top` (a file, or each file under a folder), from the top. */
const filesAt = (top: string, path: string): string[] => {
  try {
    const st = lstatSync(join(top, path));

    if (st.isDirectory()) return filesUnder(top, path);

    return st.isFile() ? [path] : [];
  } catch {
    return [];
  }
};

/**
 * The repo's worktree recipe's files (`worktree:`) as a sync carries them from the Mac's main
 * checkout `main`: each linked file the Mac's, each copied one the card's once there, the
 * `worktree-setup` hook's script (`run`) as a link, executable; an env file placed (abe.yaml's groups, then the env map `mapping`) only in
 * environments off for agents (`envs`: those on) left out, with why (`skipped`). A folder's files
 * each, up to `RECIPE_FILES_MAX` files and `RECIPE_BYTES_MAX` bytes; the rest left out, said.
 */
export const recipeFiles = (
  main: string,
  recipe: WorktreeRecipe | undefined,
  run: string | null,
  mapping: readonly { path: string; to: EnvFileTo }[],
  envs: readonly AbeEnv[],
): { files: SyncRecipeFile[]; skipped: Record<string, string> } => {
  // the script goes every run: a grouped list's in its all group
  const listed = recipeCopies(
    run === null ? recipe : { ...recipe, link: withEveryRun(recipe?.link, run) },
    mapping,
    envs,
  );
  const skipped: Record<string, string> = {};
  const files: SyncRecipeFile[] = [];
  let bytes = 0;

  for (const c of listed) {
    if (c.skip !== undefined) {
      skipped[c.path] = c.skip;
      continue;
    }
    if (!syncPathOk(c.path)) continue;
    for (const path of filesAt(main, c.path)) {
      const full = join(main, path);
      const st = statSync(full);

      if (files.length >= RECIPE_FILES_MAX || bytes + st.size > RECIPE_BYTES_MAX) {
        skipped[path] = 'over what one sync carries';
        continue;
      }
      bytes += st.size;
      const kind = c.link === true ? 'link' : 'copy';

      files.push({
        path,
        kind,
        mode: RECIPE_MODES[kind][(st.mode & 0o111) !== 0 ? 'exec' : 'file'],
        base64: readFileSync(full).toString('base64'),
      });
    }
  }

  return { files, skipped };
};

/**
 * The team's files (`paths`, `syncTeamPaths`: `abe.yaml`, the skills, the hook scripts' folders)
 * of the main checkout `main` that differ from its `HEAD`: changed, added or untracked (`files`),
 * and deleted (`gone`); `git status` read, nothing written. None when git cannot say.
 */
export const teamChanges = async (
  main: string,
  paths: readonly string[],
): Promise<{ files: string[]; gone: string[] }> => {
  const ran = await runOwn([
    'git',
    '-C',
    main,
    '-c',
    'core.fsmonitor=false',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
    '--',
    ...paths,
  ]);
  const files: string[] = [];
  const gone: string[] = [];

  if (ran.exit !== 0) return { files, gone };
  for (const entry of ran.stdout.split('\0')) {
    const path = entry.slice(3);

    if (entry.length < 4 || !isSyncTeamPath(paths, path) || !syncPathOk(path)) continue;
    if (entry.startsWith('D') || entry[1] === 'D') gone.push(path);
    else files.push(path);
  }

  return { files, gone };
};

/** A YAML file's document, as the settings read it; none when it is not there or not YAML. */
const readYaml = (path: string): unknown => {
  if (!existsSync(path)) return undefined;
  const r = readYamlFile(path);

  return 'doc' in r ? r.doc : undefined;
};
