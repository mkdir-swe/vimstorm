/**
 * Azure DevOps for tests. The fake server, `fake-ado/server.ts`, runs under Bun as a process on a
 * free port with a seed file. A fake `az` hands out tokens. `abe` reaches the fake through
 * `ABE_ADO_BASE_URL`, with a board setting that names an ordinary dev.azure.com organization, so
 * the real adapter runs end to end.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { T0 } from '../in-process/clock';

const SERVER = join(import.meta.dir, 'fake-ado', 'server.ts');

/**
 * The seed the fake starts from by default. It has a Sandbox project, team Sandbox and cards 1 to
 * 13.
 */
export const ADO_SEED = join(import.meta.dir, 'fake-ado', 'seed.json');

const SeedNames = z.object({ project: z.string(), team: z.object({ name: z.string() }) });

export type FakeAdo = {
  /** Where it listens, as `http://127.0.0.1:<port>`. */
  url: string;
  /** The board setting that points at it, together with `env`. */
  board: { organization: string; project: string; team: string };
  /** What `abe serve` needs to send the board's requests to the fake. */
  env: { ABE_ADO_BASE_URL: string };
  /** Each request so far, like `PATCH /demo-org/Sandbox/_apis/wit/workitems/4?… → 200`. */
  requests: () => string[];
  stop: () => Promise<void>;
};

export type FakeAdoOptions = {
  /** A seed file. Defaults to `ADO_SEED`. */
  seed?: string;
  /** Tokens the fake answers 401, as Azure DevOps does one that ran out. */
  expired?: readonly string[];
  /**
   * When the fake's clock starts, in ms. Its dates follow it. Defaults to `T0`, the scenarios'
   * start.
   */
  now?: number;
};

/** The fake Azure DevOps on a free port, once it says where it listens. */
export const fakeAdo = async (o: FakeAdoOptions = {}): Promise<FakeAdo> => {
  const dir = mkdtempSync(join(tmpdir(), 'ado-'));
  const log = join(dir, 'requests.log');
  const child = Bun.spawn(
    [
      process.execPath,
      SERVER,
      '--port',
      '0',
      '--seed',
      o.seed ?? ADO_SEED,
      '--log',
      log,
      ...(o.expired ?? []).flatMap((t) => ['--expired', t]),
      '--now',
      String(o.now ?? T0),
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );
  const { promise: listening, resolve, reject } = Promise.withResolvers<string>();

  void (async () => {
    const decoder = new TextDecoder();
    let held = '';

    for await (const chunk of child.stdout) {
      held += decoder.decode(chunk, { stream: true });
      const at = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(held)?.[1];

      if (at !== undefined) resolve(at);
    }
    reject(new Error('the fake Azure DevOps ended before it listened'));
  })();
  const url = await listening;
  const seed = SeedNames.parse(JSON.parse(readFileSync(o.seed ?? ADO_SEED, 'utf8')));

  return {
    url,
    board: {
      organization: 'https://dev.azure.com/demo-org',
      project: seed.project,
      team: seed.team.name,
    },
    env: { ABE_ADO_BASE_URL: url },
    requests: () =>
      readOr(log)
        .split('\n')
        .filter((l) => l !== ''),
    stop: async () => {
      void child.stdin.end();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export type FakeAz = {
  dir: string;
  /** `PATH` with this `az` first and only the system's tools after it. */
  path: string;
  /** Each call's argv, in order. */
  calls: () => string[][];
  /** The names of the environment variables each call got, in order. */
  envs: () => string[][];
  /** Each call's `$AZURE_CONFIG_DIR` (`''`: none), in order. */
  dirs: () => string[];
  remove: () => void;
};

/** A file's text, `''` when there is none yet. */
const readOr = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * A fake `az` on disk. `az account get-access-token` hands out `tokens` in turn, each good for an
 * hour, and repeats the last one once they run out. `az account show` names the account,
 * `ada@example.com`, and does not count as a call. `tokens: []` means no login, and exits 1.
 */
export const fakeAz = (o: { tokens: readonly string[] }): FakeAz => {
  const dir = mkdtempSync(join(tmpdir(), 'az-'));
  const answers = o.tokens.map((token, i) => {
    const file = join(dir, `token.${i + 1}`);

    writeFileSync(
      file,
      `${JSON.stringify({ accessToken: token, expires_on: 'EXPIRES', tokenType: 'Bearer' })}\n`,
    );

    return file;
  });
  const script = [
    '#!/bin/sh',
    `d=${quote(dir)}`,
    // `az account show --query user.name -o tsv` prints the account's name, as real az does.
    ...(answers.length === 0
      ? []
      : ['[ "$1 $2" = "account show" ] && { echo ada@example.com; exit 0; }']),
    'printf \'%s\\0\' "$@" >> "$d/argv"',
    'printf \'\\n\' >> "$d/argv"',
    "/usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/tr '\\n' ' ' >> \"$d/envs\"",
    'printf \'\\n\' >> "$d/envs"',
    'printf \'%s\\n\' "$AZURE_CONFIG_DIR" >> "$d/dirs"',
    'n=$(($(cat "$d/count" 2>/dev/null || echo 0) + 1))',
    'echo $n > "$d/count"',
    ...(answers.length === 0
      ? ['echo "ERROR: Please run \'az login\' to setup account." >&2', 'exit 1']
      : [
          `[ $n -gt ${answers.length} ] && n=${answers.length}`,
          'exp=$(($(date +%s) + 3600))',
          'sed "s/\\"EXPIRES\\"/$exp/" "$d/token.$n"',
        ]),
    '',
  ].join('\n');

  writeFileSync(join(dir, 'az'), script, { mode: 0o755 });

  return {
    dir,
    path: `${dir}:/usr/bin:/bin`,
    calls: () =>
      readOr(join(dir, 'argv'))
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => l.split('\0').filter((a) => a !== '')),
    envs: () =>
      readOr(join(dir, 'envs'))
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => l.split(' ').filter((n) => n !== '')),
    dirs: () => readOr(join(dir, 'dirs')).split('\n').slice(0, -1),
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export type BoardLayers = {
  /** `ABE_CONFIG_DIR` for a CLI run with these files. */
  env: { ABE_CONFIG_DIR: string };
  /** A checkout whose `abe.yaml` names `board`: where commands are typed. */
  repo: string;
  remove: () => void;
};

/**
 * The files a board is read from (ADR 0030): a checkout `demo` whose `abe.yaml` names
 * `board`, and yours on this Mac with your environment.
 */
export const boardLayers = (board: unknown): BoardLayers => {
  const root = mkdtempSync(join(tmpdir(), 'abe-board-'));
  const repo = join(root, 'demo');

  mkdirSync(join(repo, '.abe'), { recursive: true });
  mkdirSync(join(root, 'mine'));
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(board)}\n`);
  // there already: the repo's one-time move of your old settings has nothing to do
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
  // Launches in these worlds run on this machine, where the tests drive a fake claude.
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');

  return {
    env: { ABE_CONFIG_DIR: join(root, 'mine') },
    repo,
    remove: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
};
