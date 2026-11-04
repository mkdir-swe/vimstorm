/**
 * Prototype sessions: a real `serve` in this process wired as `abe serve` wires the Mac's (its
 * prototypes, board, GitHub and org store), the shop fixture as the repo (its start script run
 * from the prototype's worktree), the fake Azure DevOps, a fake `gh`, the fake `claude` in a real
 * `tmux` as the prototype's session. `prototype start --card` makes `proto/4-…` with no upstream
 * and a refusing hook, the session (kind `prototype`) on the prototype skill and its run in Build;
 * `stage-done build` is refused `prototype-never-ships` and a real `git push` is refused by the
 * hook. make-card makes a plain card with the diff in the org store (a folder) as its reference.
 * With no card (the Abe chat's `/abe:prototype`) the session is on no card, jailed, with no run.
 * Discard removes one, changes and branch too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CardShowData,
  DiscardData,
  FactoryStatusData,
  MakeCardData,
  OrgPrototypeVersion,
  PROTOTYPE_NEVER_SHIPS,
  PrototypeData,
  PrototypeListData,
  SessionData,
  SessionListData,
} from '@abe/core';
import {
  adoBoardFrom,
  claudeOneShot,
  fileOrgStore,
  ghTrackingFrom,
  localPrototypeApps,
  localPrototypeProxy,
  protoWorktrees,
} from '@abe/ports';
import {
  claudeOutput,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  fakeGh,
  type FakeGh,
  git,
  prototypeRepo,
  scriptClaude,
  served,
  type ServedCli,
  tempState,
  until,
} from '@abe/testing';
import { z } from 'zod';

type World = {
  root: string;
  repo: string;
  ado: FakeAdo;
  az: FakeAz;
  gh: FakeGh;
  claude: FakeClaude;
  mine: string;
  abe: ServedCli;
};

const world = async (
  o: {
    /** More of abe.yaml, after its board. */
    yaml?: string;
    /** More files committed in the shop (and the start script, when given). */
    start?: string;
    files?: Readonly<Record<string, string>>;
    /** Before serve starts: the main checkout's untracked files (its node_modules). */
    before?: (repo: string, home: string) => void;
  } = {},
): Promise<World> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-cp-')));
  const repo = join(root, 'shop');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const claude = fakeClaude();
  const gh = fakeGh([]);
  const mine = join(root, 'mine');

  prototypeRepo(repo, {
    ...(o.start === undefined ? {} : { start: o.start }),
    files: {
      'abe.yaml': `board: ${JSON.stringify(ado.board)}\nenvironments: {}\n${o.yaml ?? ''}`,
      ...o.files,
    },
  });
  // What the fake claude writes in its worktree is no work of the prototype's; yours for the
  // repo is never committed.
  appendFileSync(
    join(repo, '.git', 'info', 'exclude'),
    '.fake-claude/\n.abe/settings.local.yaml\n',
  );
  mkdirSync(join(repo, '.abe'), { recursive: true });
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, 'settings.yaml'), 'serve.target: local\n');
  const state = tempState();

  o.before?.(repo, state.dir);
  const layers = { ABE_CONFIG_DIR: mine };
  const own = {
    PATH: `${claude.dir}:${az.dir}:${gh.dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    ABE_ORG_STORE: `file://${join(root, 'org-store')}`,
    ...ado.env,
  };
  // serve's environment, as the `abe` that starts it gives it
  const env = { ...state.env, ...layers, ...own };
  const dir = join(state.dir, 'prototypes');
  // typed in the shop: its settings name the board
  const abe = await served({
    state,
    cwd: repo,
    env: layers,
    sessions: { env: own },
    board: adoBoardFrom(env, join(state.dir, 'images')),
    tracking: ghTrackingFrom(env),
    org: fileOrgStore(join(root, 'org-store')),
    oneShot: claudeOneShot(),
    prototypes: {
      dir,
      apps: localPrototypeApps({ dir, env }),
      proxy: localPrototypeProxy(),
      worktrees: protoWorktrees(env),
    },
  });

  return { root, repo, ado, az, gh, claude, mine, abe };
};

const ok = <T>(
  doc: { ok: true; data: T } | { ok: false; error: { code: string; message: string } },
) => {
  if (!doc.ok) throw new Error(`refused: ${doc.error.code}: ${doc.error.message}`);

  return doc.data;
};

const refusal = (doc: { ok: true } | { ok: false; error: { code: string } }): string =>
  doc.ok ? 'ok' : doc.error.code;

const AbeRun = z.object({ argv: z.array(z.string()), exit: z.number(), stdout: z.string() });

/** `git` in `cwd` to its end, its exit and stderr, never a throw. */
const gitRan = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
  });

  return { exit: ran.exitCode, stderr: ran.stderr.toString() };
};

describe('a prototype session: real code in a throwaway worktree', () => {
  let w: World;
  let p: PrototypeData;
  const start = (card: string) =>
    w.abe.json(PrototypeData, 'prototype', 'start', '--repo', w.repo, '--card', card);
  const live = (id: string) =>
    until(
      `${id} live`,
      async () => {
        const l = ok((await w.abe.json(PrototypeListData, 'prototype', 'list')).doc);
        const found = l.prototypes.find((x) => x.id === id);

        return found?.state === 'live' ? found : undefined;
      },
      { ms: 30_000 },
    );

  beforeAll(async () => {
    w = await world();
  }, 30_000);

  afterAll(async () => {
    await w.abe.close();
    await w.ado.stop();
    w.az.remove();
    w.gh.remove();
    w.claude.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  test('start --card: proto/4-… with no upstream and a refusing hook, a session of kind prototype on the skill, the app from its worktree', async () => {
    scriptClaude(w.abe.state.dir, [
      { write: { path: 'signin.ts', text: 'export const signIn = (email: string) => email;\n' } },
      { abe: ['factory', 'stage-done', 'build', '--json'] },
      { abe: ['factory', 'status', '--json'] },
      { say: 'A sign-in form behind ?variant=a|b.' },
    ]);
    p = ok((await start('4')).doc);
    const code = p.code;

    expect(code?.branch).toBe('proto/4-as-a-visitor-i-can');
    expect(code?.worktree).toBe(join(dirname(w.repo), 'shop-wt', 'proto-4-as-a-visitor-i-can'));
    const wt = code?.worktree ?? '';
    const branch = code?.branch ?? '';

    expect(p.card).toBe(4);
    expect(gitRan(w.repo, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`).exit).not.toBe(0);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(p.commit);
    expect(git(wt, 'config', '--worktree', 'core.hooksPath')).toEndWith('/hooks/abe-prototype');
    // the main checkout's own hooks and push are as they were
    expect(gitRan(w.repo, 'config', 'core.hooksPath').exit).not.toBe(0);
    const sessions = ok((await w.abe.json(SessionListData, 'session', 'list')).doc).sessions;

    expect(sessions).toMatchObject([
      {
        id: code?.session,
        card: 4,
        kind: 'prototype',
        prototype: { id: p.id, card: 4 },
        branch,
        worktree: wt,
      },
    ]);
    const shown = await live(p.id);
    const page = await fetch(shown.url ?? '');

    expect(await page.text()).toContain('<h1>Shop one</h1>');
    expect(existsSync(join(wt, '.scratch', 'run', 'port'))).toBe(true);
    const out = await until(
      'the first turn',
      () => {
        const o = claudeOutput(wt);

        return o.abe.length >= 2 ? o : undefined;
      },
      { ms: 30_000 },
    );
    const argv = JSON.stringify(out.argv);

    expect(argv).toContain('/abe:prototype Work on card AB#4');
    expect(argv).toContain('## A prototype session');
    // the prototype skill in its plugin
    const plugin = z.array(z.string()).parse(out.argv);
    const dir = plugin[plugin.indexOf('--plugin-dir') + 1] ?? '';

    expect(readFileSync(join(dir, 'skills', 'prototype', 'SKILL.md'), 'utf8')).toContain(
      'name: prototype',
    );
    expect(existsSync(join(dir, 'skills', 'prototype', 'UI.md'))).toBe(true);
    // its settings keep config.worktree from it, and a push typed as a command
    const settings = readFileSync(
      join(w.abe.state.dir, 'sessions', code?.session ?? '', 'settings.json'),
      'utf8',
    );

    expect(settings).toContain('config.worktree');
    expect(settings).toContain('Bash(git push:*)');
  }, 60_000);

  test('it sits in Build: stage-done build is refused prototype-never-ships, and so are its checks', async () => {
    const wt = p.code?.worktree ?? '';
    const runs = AbeRun.array().parse(claudeOutput(wt).abe);
    const done = runs.find((r) => r.argv.includes('stage-done'));

    expect(done?.exit).toBe(1);
    expect(done?.stdout).toContain(PROTOTYPE_NEVER_SHIPS);
    const st = ok((await w.abe.json(FactoryStatusData, 'factory', 'status', '4')).doc);

    expect(st.runs).toMatchObject([{ session: p.code?.session, stage: 'build', prototype: true }]);
    expect(refusal((await w.abe.json(z.unknown(), 'factory', 'checks', '4')).doc)).toBe(
      PROTOTYPE_NEVER_SHIPS,
    );
  });

  test('no push is possible: a real git push is refused by its hook', () => {
    const wt = p.code?.worktree ?? '';
    const bare = join(w.root, 'remote.git');

    git(w.root, 'init', '-q', '--bare', bare);
    git(wt, 'remote', 'add', 'bare', bare);
    const pushed = gitRan(wt, 'push', 'bare', `HEAD:refs/heads/${p.code?.branch ?? ''}`);

    expect(pushed.exit).not.toBe(0);
    expect(pushed.stderr).toContain(PROTOTYPE_NEVER_SHIPS);
    expect(gitRan(wt, 'push').exit).not.toBe(0);
    expect(git(bare, 'for-each-ref')).toBe('');
    // the main checkout still pushes: its hooks are its own
    expect(gitRan(w.repo, 'push', '-q', bare, 'main').exit).toBe(0);
  });

  test('start --card again: the same prototype, nothing new', async () => {
    const again = ok((await start('4')).doc);

    expect(again.id).toBe(p.id);
    expect(again.code?.session).toBe(p.code?.session);
  });

  test('make-card: a plain card in New tagged prototype, its Prototype section, the diff in the org store as its reference; once', async () => {
    const make = () =>
      w.abe.json(
        MakeCardData,
        'prototype',
        'make-card',
        '--id',
        p.id,
        '--title',
        'Sign in with email',
        '--description',
        '## Why\n\nVisitors want to sign in.',
      );
    const made = ok((await make()).doc);

    expect(made).toMatchObject({ prototype: p.id, title: 'Sign in with email', version: 1 });
    expect(made.line).toMatch(/^Prototype · proto\/4-\S+ at [0-9a-f]{7} · \d+ files?$/);
    const card = ok((await w.abe.json(CardShowData, 'card', 'show', String(made.card))).doc);

    expect(card.tags).toContain('prototype');
    expect(card.description).toContain('Visitors want to sign in.');
    expect(card.description).toContain(`## Prototype`);
    expect(card.description).toContain(`prototype://shop/${made.card}/v1`);
    // its diff in the org store: every run of the card reads it as its reference
    const store = join(w.root, 'org-store', 'prototypes', 'shop', String(made.card));
    const v1 = OrgPrototypeVersion.parse(
      JSON.parse(readFileSync(join(store, 'v1', 'meta.json'), 'utf8')),
    );

    expect(v1.code).toEqual({ branch: p.code?.branch ?? '', diff: 'prototype.diff' });
    expect(readFileSync(join(store, 'v1', 'prototype.diff'), 'utf8')).toContain(
      '+export const signIn',
    );
    // again: the same card, no second one
    expect(ok((await make()).doc).card).toBe(made.card);
  }, 60_000);

  test("no card (the Abe chat's /abe:prototype): proto/<id>-<words>, a prototype session on no card, jailed as a card session, no run, reopened", async () => {
    scriptClaude(w.abe.state.dir, [{ say: 'A VAT line, two ways.' }]);
    const q = ok(
      (await w.abe.json(PrototypeData, 'prototype', 'start', '--repo', w.repo, 'a', 'VAT', 'line'))
        .doc,
    );
    const branch = `proto/${q.id.slice('proto-'.length)}-a-vat-line`;

    expect([q.card, q.code?.branch]).toEqual([null, branch]);
    expect(q.code?.worktree).toBe(join(dirname(w.repo), 'shop-wt', branch.replace('/', '-')));
    const sessions = ok((await w.abe.json(SessionListData, 'session', 'list')).doc).sessions;

    expect(sessions.find((s) => s.id === q.code?.session)).toMatchObject({
      card: null,
      kind: 'prototype',
      prototype: { id: q.id, card: null },
      title: 'Prototype · a VAT line',
      branch,
    });
    // claude started in its worktree, on the prototype skill with the words
    const argv = await until('its claude', () => claudeOutput(q.code?.worktree ?? '').argv, {
      ms: 30_000,
    });

    expect(JSON.stringify(argv)).toContain('/abe:prototype a VAT line');
    // its jail, as a card session's: its hook fences its tools (the Abe chat alone runs unjailed)
    const env = z.record(z.string(), z.string()).parse(claudeOutput(q.code?.worktree ?? '').env);

    expect(env.FENCED_BY_ABE).toBe('1');
    // no run: it is on no card's lane
    const runs = ok((await w.abe.json(FactoryStatusData, 'factory', 'status')).doc).runs;

    expect(runs.some((r) => r.session === q.code?.session)).toBe(false);
    // ended, reopened: the same session, worktree and branch, its conversation resumed
    const id = q.code?.session ?? '';

    ok((await w.abe.json(z.unknown(), 'session', 'stop', id)).doc);
    const back = ok((await w.abe.json(SessionData, 'session', 'reopen', id)).doc);

    expect([back.id, back.kind, back.card, back.worktree, back.branch]).toEqual([
      id,
      'prototype',
      null,
      q.code?.worktree ?? '',
      branch,
    ]);
    expect(back.state).not.toBe('ended');
    ok((await w.abe.json(DiscardData, 'prototype', 'discard', q.id)).doc);
  }, 60_000);

  test('Discard: another prototype stopped, its worktree and branch removed, uncommitted work too', async () => {
    scriptClaude(w.abe.state.dir, [
      { write: { path: 'reset.ts', text: 'export const reset = 1;\n' } },
      { say: 'A reset link.' },
    ]);
    const q = ok((await start('5')).doc);
    const wt = q.code?.worktree ?? '';

    await until('its first turn', () => (existsSync(join(wt, 'reset.ts')) ? true : undefined), {
      ms: 30_000,
    });
    const d = ok((await w.abe.json(DiscardData, 'prototype', 'discard', q.id)).doc);

    expect(d).toMatchObject({ prototype: q.id, card: 5, fate: { worktree: 'removed' } });
    expect(existsSync(wt)).toBe(false);
    expect(git(w.repo, 'branch', '--list', q.code?.branch ?? '')).toBe('');
    const runs = ok((await w.abe.json(FactoryStatusData, 'factory', 'status', '5')).doc).runs;

    expect(runs).toEqual([]);
    // again: it is done with, said so
    expect(refusal((await w.abe.json(DiscardData, 'prototype', 'discard', q.id)).doc)).toBe(
      'prototype-ended',
    );
  }, 60_000);

  test('a session that ended: start again opens a new session on the same worktree, the old id is done with', async () => {
    scriptClaude(w.abe.state.dir, [{ say: 'ready' }]);
    const first = ok((await start('6')).doc);

    ok((await w.abe.json(z.unknown(), 'session', 'stop', first.code?.session ?? '')).doc);
    const second = ok((await start('6')).doc);

    expect(second.id).not.toBe(first.id);
    expect(second.code?.worktree).toBe(first.code?.worktree);
    expect(second.code?.session).not.toBe(first.code?.session);
    expect(refusal((await w.abe.json(DiscardData, 'prototype', 'discard', first.id)).doc)).toBe(
      'prototype-ended',
    );
    expect(existsSync(second.code?.worktree ?? '')).toBe(true);
    const runs = ok((await w.abe.json(FactoryStatusData, 'factory', 'status', '6')).doc).runs;

    expect(runs.map((r) => r.session)).toEqual([second.code?.session ?? '']);
    ok((await w.abe.json(DiscardData, 'prototype', 'discard', second.id)).doc);
  }, 60_000);
});

describe('a repo whose app takes fixed ports, on this Mac (ADR 0039)', () => {
  let w: World;
  let port: number;
  /** How many files the main checkout's node_modules holds (more for a measurement). */
  const FILES = Number(process.env.ABE_PROTO_FILES ?? '2000');
  const answers = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${String(port)}/`)).ok;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });

    port = probe.port ?? 0;
    await probe.stop(true);
    w = await world({
      // abe-only: the person's servers off, but for a prototype's Figma
      yaml: `ports.fixed: [${String(port)}]\nsession.mcp: abe-only\n`,
      start: `#!/bin/sh
set -eu
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
run="$root/.scratch/run"
mkdir -p "$run"
rm -f "$run/port"
nohup bun "$root/server.ts" "$run/port" ${String(port)} </dev/null >"$run/app.log" 2>&1 &
echo $! >"$run/app.pid"
i=0
while [ ! -s "$run/port" ]; do i=$((i + 1)); [ "$i" -gt 100 ] && exit 1; sleep 0.1; done
echo "http://localhost:${String(port)}"
`,
      files: {
        // no package.json: a session would need node on its PATH (the manifests: ports' tests)
        '.gitignore': '.scratch/\nnode_modules/\n',
        'packages/ui/index.js': 'module.exports = "ui";\n',
      },
      before: (repo, home) => {
        // the main checkout's install: a workspace's relative link, and many packages' files
        const nm = join(repo, 'node_modules');

        mkdirSync(join(nm, '@shop'), { recursive: true });
        symlinkSync('../../packages/ui', join(nm, '@shop', 'ui'));
        for (let i = 0; i < FILES; i++) {
          const dir = join(nm, `pkg-${String(Math.floor(i / 20))}`);

          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `f${String(i % 20)}.js`), `module.exports = ${String(i)};\n`);
        }
        // the person's own servers: their Figma one and another
        writeFileSync(
          join(home, '.claude.json'),
          JSON.stringify({
            mcpServers: {
              figma: { type: 'http', url: 'https://mcp.figma.com/mcp' },
              sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
            },
          }),
        );
      },
    });
  }, 120_000);

  afterAll(async () => {
    await w.abe.close();
    await w.ado.stop();
    w.az.remove();
    w.gh.remove();
    w.claude.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  test("the card session's app stopped for it, the prototype's started on the port in seconds, packages cloned, Figma loaded; Discard starts the card's again", async () => {
    // a card session's app on the fixed port, as the main checkout's would be
    scriptClaude(w.abe.state.dir, [{ abe: ['run', 'start'] }, { say: 'up' }]);
    const card = ok(
      (await w.abe.json(SessionData, 'session', 'launch', '--card', '4', '--repo', w.repo)).doc,
    );
    const cardRun = join(card.worktree, '.scratch', 'run');

    await until('the card app', async () => ((await answers()) ? true : undefined), {
      ms: 30_000,
    });
    const cardPid = readFileSync(join(cardRun, 'app.pid'), 'utf8').trim();

    scriptClaude(w.abe.state.dir, [{ say: 'ready' }]);
    const t0 = performance.now();
    const q = ok(
      (await w.abe.json(PrototypeData, 'prototype', 'start', '--repo', w.repo, 'a', 'VAT', 'line'))
        .doc,
    );
    const wt = q.code?.worktree ?? '';
    const shown = await until(
      'the prototype on the port',
      async () => {
        const l = ok((await w.abe.json(PrototypeListData, 'prototype', 'list')).doc);
        const found = l.prototypes.find((x) => x.id === q.id);

        return found?.state === 'live' && (await answers()) ? found : undefined;
      },
      { ms: 30_000, every: 50 },
    );
    const ms = performance.now() - t0;

    console.log(
      `prototype start → page on :${String(port)}: ${ms.toFixed(0)} ms (${String(FILES)} files in node_modules)`,
    );
    expect(ms).toBeLessThan(10_000);
    // the app's own URL, no proxy; started from its worktree by the start hook
    expect(shown.url).toBe(`http://localhost:${String(port)}`);
    // its ports said: the Preview opens it as a browser would (ADR 0041)
    expect(shown.ports).toEqual([port]);
    expect(existsSync(join(wt, '.scratch', 'run', 'app.pid'))).toBe(true);
    // the card's app stopped by its stop
    expect(existsSync(join(cardRun, 'app.pid'))).toBe(false);
    // its packages cloned, the workspace's link resolving inside it
    expect(realpathSync(join(wt, 'node_modules', '@shop', 'ui'))).toBe(join(wt, 'packages', 'ui'));
    expect(realpathSync(join(wt, 'node_modules', 'pkg-0', 'f0.js'))).toBe(
      join(wt, 'node_modules', 'pkg-0', 'f0.js'),
    );
    // its claude loads the person's Figma server, strict: none of their others
    const argv = z
      .array(z.string())
      .parse(await until('its claude', () => claudeOutput(wt).argv, { ms: 30_000 }));
    const configs = argv
      .slice(argv.indexOf('--mcp-config') + 1)
      .filter((_, i, all) => !all.slice(0, i + 1).some((x) => x.startsWith('--')));
    const loaded = configs.map((f) => readFileSync(f, 'utf8')).join('\n');

    expect(argv).toContain('--strict-mcp-config');
    expect(loaded).toContain('https://mcp.figma.com/mcp');
    expect(loaded).not.toContain('sentry');
    expect(JSON.stringify(argv)).toContain(
      `on the repo's own ports (:${String(port)}), with no proxy`,
    );
    // Discard: the port handed back, the card's app started again as it ran
    ok((await w.abe.json(DiscardData, 'prototype', 'discard', q.id)).doc);
    const again = await until(
      'the card app again',
      async () => {
        const file = join(cardRun, 'app.pid');
        const pid = existsSync(file) ? readFileSync(file, 'utf8').trim() : cardPid;

        return (await answers()) && pid !== cardPid ? pid : undefined;
      },
      { ms: 30_000 },
    );

    expect(again).not.toBe(cardPid);
  }, 120_000);
});
