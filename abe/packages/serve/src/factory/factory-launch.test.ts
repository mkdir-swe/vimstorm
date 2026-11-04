/**
 * A Factory run's launch in a real `serve` in this test (fake clock), with the fake `claude` in a
 * real `tmux`, an in-memory board and a real git checkout: a `claude` that never starts (a
 * settings dialog, no hook) is ended at its start timeout and its run needs you, saying why; the
 * repo pack's setup runs in a worktree made at launch, before claude, and its failure needs you;
 * a card the board will not move holds nothing up.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  cardBranch,
  EventLine,
  HubData,
  INSTALL_PARTS,
  newInstall,
  type McpState,
  FactoryRunData,
  FactoryStatusData,
  INTERRUPTED_REASON,
  noStartReason,
  readEnvelope,
  type Reply,
  SessionData,
  SESSION_START_TIMEOUT_MS,
  type SourceProbeRead,
  worktreePath,
} from '@abe/core';
import {
  card,
  claudeOutput,
  fakeBoard,
  fakeClaude,
  type FakeClaude,
  fakeLoginStore,
  fakeLoginTools,
  type FakeLoginTools,
  installDone,
  installFakes,
  scenario,
  requestAt,
  scriptClaude,
  type ServeScenario,
  stuckClaude,
  tmuxPath,
  until,
  watching,
} from '@abe/testing';
import { copyAbeFiles, fileOrgStore } from '@abe/ports';
import { whoOf } from '../session/launch-note';
import { z } from 'zod';

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...GIT_ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

const ME = { name: 'Ada', email: 'ada@example.test' };
const BOARD = { organization: 'https://dev.azure.com/demo-org', project: 'Shop', team: 'Web' };

const doc = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> => {
  const read = readEnvelope(schema, JSON.parse(reply.stdout));

  if (!read.ok) throw new Error(JSON.stringify(read.error));

  return read.data;
};

/**
 * A checkout with one commit and the repo's settings, not committed (Just this Mac): the board,
 * its `setup` when given, then `settings`. Yours for it (`.abe/settings.local.yaml`) is there, empty.
 */
const checkout = (dir: string, setup?: string, settings = '') => {
  git(dirname(dir), 'init', '-q', '-b', 'main', dir);
  writeFileSync(join(dir, '.gitignore'), '.fake-claude/\n.scratch/\n');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  mkdirSync(join(dir, '.abe'));
  writeFileSync(
    join(dir, 'abe.yaml'),
    `board: ${JSON.stringify(BOARD)}\n${setup === undefined ? '' : `setup: ${JSON.stringify(setup)}\n`}${settings}`,
  );
  writeFileSync(join(dir, '.abe', 'settings.local.yaml'), '');

  return dir;
};

describe("a Factory run's launch", () => {
  let root: string;
  let repo: string;
  let claude: FakeClaude;
  let s: ServeScenario;
  let board: ReturnType<typeof fakeBoard>;
  let logins: FakeLoginTools;

  const status = async (id: number) =>
    doc(FactoryStatusData, await s.request('factory', 'status', String(id), '--json')).runs[0];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-fl-'));
    repo = join(root, 'demo');
    mkdirSync(join(root, 'mine'), { recursive: true });
    // yours on this Mac: sessions here (the board is the fake's, the checkouts' settings their own)
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    checkout(repo);
    claude = fakeClaude();
    board = fakeBoard(
      [
        card(4, 'Sign in with email'),
        card(5, 'Cart total'),
        card(6, 'Checkout button'),
        card(7, 'Order history'),
        card(8, 'Wish list'),
        card(9, 'Coupon codes'),
        card(10, 'Gift cards'),
        // #347: plain cards the Launch note launches
        card(14, 'VAT under every total'),
        card(15, 'Sort by price'),
        card(16, 'Price helper'),
        // a repo's logins: at launch
        card(17, 'Stock badge'),
        card(18, 'Stock count'),
        card(19, 'Stock alert'),
        // the repo's sources in a run
        card(20, 'Error page'),
        card(21, 'Error page copy'),
        card(23, 'Error page link'),
        card(24, 'Error page icon'),
        // a worktree made ready from its checkout
        card(22, 'Linked packages'),
        // a card's workflow, by its on: or --workflow
        card(30, 'Cart total wrong', { type: 'Bug' }),
        card(31, 'Try a cheaper lookup', { type: 'Bug' }),
        card(32, 'Cart rounding', { type: 'Bug' }),
        card(34, 'Why are carts slow?'),
        // Esc in its Claude Code
        card(33, 'Order notes'),
        // the Abe chat starts a run as the person
        card(35, 'Why do carts expire?'),
        // a source's secret, yours in .abe/sources.env
        card(36, 'Flag-gated banner'),
        // Launch again on a live session: --replace stops it first
        card(37, 'Saved addresses'),
        // two clones of one origin launch it
        card(38, 'Saved cards'),
        // origin has its branch, pushed by another clone
        card(39, 'Saved searches'),
        // launched from another card's worktree
        card(40, 'Saved lists'),
        card(41, 'Saved list names'),
      ],
      { states: ['New', 'Closed'], me: ME },
    );
    logins = fakeLoginTools(join(root, 'home'));
    s = await scenario({
      board,
      // a prototype's card launches only where its prototype can be read (#351)
      org: fileOrgStore(join(root, 'org-store')),
      // the Mac's logins: none kept in a secret, each tool's own check
      storedLogins: {
        secret: null,
        store: fakeLoginStore(),
        tools: logins,
        home: join(root, 'home'),
      },
      sessions: {
        env: {
          ...GIT_ENV,
          PATH: claude.path,
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
      },
    });
  }, 30_000);
  afterAll(async () => {
    await s.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    'a claude that never starts: ended at its start timeout, its run at Needs you with the reason; both events sent',
    { timeout: 30_000 },
    async () => {
      stuckClaude(s.state.dir, 'There was an error parsing your settings. Press Enter to exit.');
      // #190: the reason says what its terminal showed.
      const NO_START = noStartReason(
        'There was an error parsing your settings. Press Enter to exit.',
      );
      const w = watching(s.state.socket, ['watch', '--json', '--since', '0']);
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '4', '--repo', repo, '--json'),
      );

      expect(run).toMatchObject({ stage: 'spec', state: 'running' });
      await until('the dialog on its screen', async () => {
        const shown = Bun.spawn(
          [
            tmuxPath(),
            '-S',
            join(s.state.dir, 'tmux.sock'),
            'capture-pane',
            '-p',
            '-t',
            `=abe-${run.session}:`,
          ],
          { stdout: 'pipe', stderr: 'ignore' },
        );

        return (await new Response(shown.stdout).text()).includes('Press Enter') ? true : undefined;
      });
      expect(
        doc(SessionData, await s.request('session', 'show', run.session, '--json')),
      ).toMatchObject({ state: 'starting' });
      // Inside the minute it is only starting.
      s.clock.tick(59_000);
      expect(await status(4)).toMatchObject({ state: 'running', reason: null });
      s.clock.tick(1_000);
      expect(await status(4)).toMatchObject({
        stage: 'spec',
        state: 'needs-you',
        reason: NO_START,
      });
      expect(
        doc(SessionData, await s.request('session', 'show', run.session, '--json')),
      ).toMatchObject({ state: 'ended', reason: NO_START });
      // Its terminal is gone too.
      expect(doc(z.unknown(), await s.request('session', 'list', '--json'))).toMatchObject({
        sessions: [{ id: run.session, state: 'ended' }],
      });
      const seen: unknown[] = [];

      while (seen.length < 2) {
        const e = EventLine.parse(JSON.parse(await w.next(10_000)));

        if (e.type === 'session.state' || e.type === 'factory.stage') {
          const d = z
            .object({ state: z.string(), cause: z.string(), reason: z.string().nullish() })
            .parse(e.data);

          if (d.cause === 'no-start')
            seen.push({
              type: e.type,
              state: d.state,
              cause: d.cause,
              ...(d.reason === null || d.reason === undefined ? {} : { reason: d.reason }),
            });
        }
      }
      w.close();
      expect(seen).toEqual([
        { type: 'session.state', state: 'ended', cause: 'no-start', reason: NO_START },
        { type: 'factory.stage', state: 'needs-you', cause: 'no-start', reason: NO_START },
      ]);
    },
  );

  test(
    "the card's workflow: the one whose on: takes it, or --workflow's (yours a .local.yaml too); one that does not load refused with its problems",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      const wf = checkout(join(root, 'wf'));
      const put = (name: string, text: string) => {
        mkdirSync(join(wf, '.abe', 'workflows'), { recursive: true });
        writeFileSync(join(wf, '.abe', 'workflows', name), text);
      };

      // installed: Abe's copied into abe/, the team's Quick fix in place of Abe's (ADR 0033)
      copyAbeFiles(wf, '3.3.1');
      // the team dropped Abe's Bug: its Quick fix takes bugs
      rmSync(join(wf, 'abe', 'workflows', 'bug.yaml'));
      writeFileSync(
        join(wf, 'abe', 'workflows', 'quick-fix.yaml'),
        'name: Quick fix\non: bug\nsteps: [implement, checks, pr]\n',
      );
      put('spike.local.yaml', 'name: Spike\non: { tags: [spike] }\nsteps: [implement]\n');
      put('broken.local.yaml', 'name: Broken\non: bug\nsteps: [repro, implement]\n');
      const run = async (id: string, ...more: string[]) =>
        readEnvelope(
          FactoryRunData,
          JSON.parse(
            (await s.request('factory', 'run', id, '--repo', wf, ...more, '--json')).stdout,
          ),
        );
      const ran = async (id: string, ...more: string[]) => {
        const r = await run(id, ...more);

        if (!r.ok) throw new Error(r.error.message);
        await s.request('session', 'stop', r.data.session, '--json');

        return [r.data.workflow?.id, r.data.workflow?.name, r.data.workflow?.layer];
      };

      expect(await ran('30')).toEqual(['quick-fix', 'Quick fix', 'repo']);
      // its on: takes no Bug: it still runs it
      expect(await ran('31', '--workflow', 'spike')).toEqual(['spike', 'Spike', 'yours']);
      expect(await ran('32', '--workflow', 'feature')).toEqual(['feature', 'Feature', 'repo']);
      // no on: preselects Investigate: picked, it runs
      expect(await ran('34', '--workflow', 'investigate')).toEqual([
        'investigate',
        'Investigate',
        'repo',
      ]);
      const refusedWith = async (wfId: string) => {
        const r = await run('32', '--workflow', wfId);

        return r.ok ? 'launched' : `${r.error.code}: ${r.error.message}`;
      };

      expect(await refusedWith('nope')).toBe(
        'unknown-workflow: no workflow nope here: the workflows are feature, investigate, quick-fix, spike',
      );
      expect(await refusedWith('broken')).toBe(
        `workflow-problems: broken does not load (1 problem): ${join(realpathSync(wf), '.abe/workflows/broken.local.yaml')}:3: No skill named repro in any Layer`,
      );
    },
  );

  test(
    "the Abe chat's abe factory run <card> --workflow <id> is the person's; a card session's is refused",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      const hub = doc(HubData, await s.request('chat', '--repo', repo, '--json'));
      const asked = (id: string, card: string) =>
        requestAt(
          join(s.state.dir, 'sessions', id, 'session.sock'),
          repo,
          ...['factory', 'run', card, '--repo', repo, '--workflow', 'investigate', '--json'],
        );
      await until('its socket', () =>
        existsSync(join(s.state.dir, 'sessions', hub.id, 'session.sock')) ? true : undefined,
      );
      const ran = await asked(hub.id, '35');
      const run = doc(FactoryRunData, ran);

      expect([ran.exit, run.workflow?.id, run.card]).toEqual([0, 'investigate', 35]);
      // a card session asking the same: not its to run
      await until('its socket', () =>
        existsSync(join(s.state.dir, 'sessions', run.session, 'session.sock')) ? true : undefined,
      );
      const refused = await asked(run.session, '35');

      expect(refused.exit).not.toBe(0);
      expect(refused.stdout).toContain('not-in-session');
      await s.request('session', 'stop', run.session, '--json');
      await s.request('session', 'stop', hub.id, '--json');
    },
  );

  test(
    'Esc mid-turn (no hook comes, only its transcript line): its run at Needs you, your message goes on',
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ interrupt: true }], { 'Go on': [{ say: 'going on' }] });
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '33', '--repo', repo, '--json'),
      );

      await until('Needs you, saying why', async () =>
        (await status(33))?.reason === INTERRUPTED_REASON ? true : undefined,
      );
      expect(await status(33)).toMatchObject({ state: 'needs-you' });
      expect(
        doc(SessionData, await s.request('session', 'show', run.session, '--json')).state,
      ).toBe('waiting');
      await s.request('session', 'send', run.session, 'Go on');
      await until('running again', async () =>
        (await status(33))?.reason === null ? true : undefined,
      );
      expect(await status(33)).toMatchObject({ state: 'running' });
    },
  );

  test(
    "the repo pack's setup runs in a worktree made at launch, before claude; a reused one does not",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      // It runs in the session's environment.
      const setup = 'mkdir -p .scratch && echo "ran ${HOME:+with HOME}" >> .scratch/setup-ran';
      const shop = checkout(join(root, 'shop'), setup);
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '5', '--repo', shop, '--json'),
      );
      const ran = join(run.worktree, '.scratch', 'setup-ran');

      expect(run).toMatchObject({ state: 'running', reason: null });
      expect(readFileSync(ran, 'utf8')).toBe('ran with HOME\n');
      expect(
        doc(SessionData, await s.request('session', 'show', run.session, '--json')).setup,
        // the install's abe.yaml, not committed yet: the card's too, held out of its commits (3.2.1)
      ).toEqual({ run: setup, exit: 0, output: '', how: 'ran', copied: ['abe.yaml'] });
      // Stopped and launched again on the same worktree: its packages are there already.
      expect(
        doc(SessionData, await s.request('session', 'stop', run.session, '--json')).state,
      ).toBe('ended');
      const again = doc(
        FactoryRunData,
        await s.request('factory', 'run', '5', '--repo', shop, '--json'),
      );

      expect(again.worktree).toBe(run.worktree);
      expect(readFileSync(ran, 'utf8')).toBe('ran with HOME\n');
      expect(
        doc(SessionData, await s.request('session', 'show', again.session, '--json')).setup,
      ).toBeNull();
      // Its team file gone from the worktree meanwhile: launched again, it is put back, held out.
      await s.request('session', 'stop', again.session, '--json');
      rmSync(join(run.worktree, 'abe.yaml'));
      const third = doc(
        FactoryRunData,
        await s.request('factory', 'run', '5', '--repo', shop, '--json'),
      );

      expect(readFileSync(ran, 'utf8')).toBe('ran with HOME\n');
      expect(
        doc(SessionData, await s.request('session', 'show', third.session, '--json')).setup,
      ).toEqual({ run: '', exit: 0, output: '', how: 'none', copied: ['abe.yaml'] });
      expect(existsSync(join(run.worktree, 'abe.yaml'))).toBe(true);
      expect(git(run.worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    },
  );

  test(
    "a card launched from another card's worktree is the main checkout's: its worktree, repo and team files the main checkout's, with no install record",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      // the install's files not committed yet; no install record kept (an install reset)
      const shop = realpathSync(checkout(join(root, 'from-card')));

      mkdirSync(join(shop, '.claude', 'skills', 'run-app'), { recursive: true });
      writeFileSync(join(shop, '.claude', 'skills', 'run-app', 'SKILL.md'), '# run\n');
      writeFileSync(join(shop, 'CLAUDE.md'), '# notes\n');
      const first = doc(
        FactoryRunData,
        await s.request('factory', 'run', '40', '--repo', shop, '--json'),
      );
      // its workspace the project shown: the next launch names its worktree
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '41', '--repo', first.worktree, '--json'),
      );
      const shown = doc(SessionData, await s.request('session', 'show', run.session, '--json'));

      expect([run.worktree, shown.repo]).toEqual([
        worktreePath(shop, cardBranch('41', 'Saved list names')),
        shop,
      ]);
      expect(shown.setup?.copied).toEqual(['abe.yaml', '.claude/skills', 'CLAUDE.md']);
      expect(
        readFileSync(join(run.worktree, '.claude', 'skills', 'run-app', 'SKILL.md'), 'utf8'),
      ).toBe('# run\n');
      expect(git(run.worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      await s.request('session', 'stop', first.session, '--json');
      await s.request('session', 'stop', run.session, '--json');
    },
  );

  test(
    "a checkout with its packages installed: the worktree links them, gets the install's untracked files and no env file the recipe leaves out (public or test ones neither), and CI's NODE_OPTIONS",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      const shop = realpathSync(checkout(join(root, 'linked')));

      writeFileSync(join(shop, 'package.json'), '{"name":"shop"}\n');
      // bun's lockfile: no node needed on the fake's PATH
      writeFileSync(join(shop, 'bun.lock'), '{"lockfileVersion":1}\n');
      mkdirSync(join(shop, '.github', 'workflows'), { recursive: true });
      writeFileSync(
        join(shop, '.github', 'workflows', 'ci.yml'),
        'env:\n  NODE_OPTIONS: --max-old-space-size=8192\n',
      );
      writeFileSync(
        join(shop, '.gitignore'),
        '.fake-claude/\n.scratch/\nnode_modules\n.env*\n.abe/\n',
      );
      git(shop, 'add', '.');
      git(shop, 'commit', '-q', '-m', 'packages');
      mkdirSync(join(shop, 'node_modules', 'left-pad'), { recursive: true });
      mkdirSync(join(shop, '.claude', 'skills', 'run-app', 'scripts'), { recursive: true });
      writeFileSync(join(shop, '.claude', 'skills', 'run-app', 'scripts', 'start'), '#!/bin/sh\n');
      writeFileSync(join(shop, '.env.test'), 'VITE_API=http://localhost:3000\n');
      writeFileSync(join(shop, '.env.local'), 'API_TOKEN=never-copied\n');
      writeFileSync(join(shop, '.env.aws.dev'), 'VITE_REGION=eu-north-1\n');
      // public keys alone, or named for tests: the recipe's to list, never brought by Abe
      writeFileSync(
        join(shop, '.env.unittest'),
        'DATABASE_URL=postgres://t:pw@localhost/t\nAPI_SECRET=s3cret\n',
      );
      writeFileSync(join(shop, '.env.ci'), 'AWS_ACCESS_KEY_ID=x\nAWS_SECRET_ACCESS_KEY=y\n');
      await installDone(s.state.dir, shop);
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '22', '--repo', shop, '--json'),
      );
      const shown = await s.request('session', 'show', run.session);

      expect(run).toMatchObject({ state: 'running', reason: null });
      expect(realpathSync(join(run.worktree, 'node_modules', 'left-pad'))).toBe(
        join(shop, 'node_modules', 'left-pad'),
      );
      expect(
        [
          '.claude/skills/run-app/scripts/start',
          '.env.test',
          '.env.local',
          '.env.aws.dev',
          '.env.unittest',
          '.env.ci',
        ].map((f) => existsSync(join(run.worktree, f))),
        // run-app's script, the team's and not committed yet: the card's too (3.2.1), held out
      ).toEqual([true, false, false, false, false, false]);
      expect(shown.stdout).toContain(
        `  setup       packages linked from ${shop} (the same lockfile) · copied .claude/skills\n`,
      );
      expect(shown.stdout).not.toContain('s3cret');
      // held out by the worktree's own excludes: nothing of the team's for the card to commit
      expect(
        git(run.worktree, 'status', '--porcelain', '--untracked-files=all', '--', '.claude'),
      ).toBe('');
      await until('claude started', () => claudeOutput(run.worktree).env);
      expect(
        z.record(z.string(), z.string()).parse(claudeOutput(run.worktree).env).NODE_OPTIONS,
      ).toBe('--max-old-space-size=8192');
      await s.request('session', 'stop', run.session, '--json');
    },
  );

  test(
    'a setup that fails puts the run at Needs you with its output',
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      const broken = checkout(
        join(root, 'broken'),
        'echo "npm error code EUSAGE"; echo "npm error lockfile missing" >&2; exit 3',
      );
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '6', '--repo', broken, '--json'),
      );
      const reason =
        'the repo\'s setup `echo "npm error code EUSAGE"; echo "npm error lockfile missing" >&2; exit 3` failed (exit 3) in the new worktree:\nnpm error code EUSAGE\nnpm error lockfile missing';

      expect(run).toMatchObject({ stage: 'spec', state: 'needs-you', reason });
      expect(await status(6)).toMatchObject({ state: 'needs-you', reason });
      // Claude runs all the same: the person answers in Chat once it is fixed.
      await until('its claude started', () =>
        existsSync(join(run.worktree, '.fake-claude', 'env.json')) ? true : undefined,
      );
      // Launched again on that worktree: its setup has not passed there, so it runs again.
      expect(
        doc(SessionData, await s.request('session', 'stop', run.session, '--json')).state,
      ).toBe('ended');
      const again = doc(
        FactoryRunData,
        await s.request('factory', 'run', '6', '--repo', broken, '--json'),
      );

      expect(again).toMatchObject({ worktree: run.worktree, state: 'needs-you', reason });
    },
  );

  test.each([
    [
      'gh signed in, aws not: Needs you with its sign-in',
      17,
      { github: true, aws: false },
      "this repo needs logins that aren't usable here (its logins:). Sign in yourself in Terminal; the agent never types a password or reads a token:\n- aws (shop-test): missing, sign in with: abe login aws --profile shop-test",
    ],
    [
      'neither: both, in its logins: order',
      18,
      { github: false, aws: false },
      "this repo needs logins that aren't usable here (its logins:). Sign in yourself in Terminal; the agent never types a password or reads a token:\n- gh: missing, sign in with: gh auth login --web\n- aws (shop-test): missing, sign in with: abe login aws --profile shop-test",
    ],
    ['both signed in: it builds', 19, { github: true, aws: true }, null],
  ] as const)(
    "a repo's logins: checked at launch: %s",
    { timeout: 30_000 },
    async (_, id, works, reason) => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      const dir = join(root, `logins-${id}`);
      const shop = checkout(
        dir,
        undefined,
        'logins:\n  - gh\n  - aws: { profile: shop-test, sso: true }\n',
      );

      logins.set('github', works.github);
      logins.set('aws', works.aws);
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', String(id), '--repo', shop, '--json'),
      );

      expect(logins.awsProfiles.at(-1)).toBe('shop-test');
      if (reason === null) expect(run.state).not.toBe('needs-you');
      else expect(run).toMatchObject({ state: 'needs-you', reason });
      await s.request('session', 'stop', run.session, '--json');
    },
  );

  test(
    "a repo that needs node, and no node on the session's PATH: refused before anything starts (#145)",
    { timeout: 30_000 },
    async () => {
      const web = checkout(join(root, 'web'), 'npm ci');

      writeFileSync(join(web, 'package.json'), '{}\n');
      const reply = await s.request('factory', 'run', '10', '--repo', web, '--json');

      expect(reply.exit).toBe(1);
      expect(JSON.parse(reply.stdout)).toEqual({
        ok: false,
        error: {
          code: 'no-node',
          message: `no node runs on the session's PATH (${join(s.state.dir, 'bin')}:${claude.path}), and this repo needs it (package.json, setup \`npm ci\`): its setup and checks would fail. brew install node, then launch again (abe tools check shows what serve finds)`,
        },
      });
      // Nothing started: no worktree, no session.
      expect(existsSync(worktreePath(web, cardBranch('10', 'Gift cards')))).toBe(false);
      const listed = z.object({ sessions: z.array(z.object({ card: z.number().nullable() })) });

      expect(
        doc(listed, await s.request('session', 'list', '--json')).sessions.filter(
          (x) => x.card === 10,
        ),
      ).toEqual([]);
    },
  );

  test(
    "two clones of one origin on one card: a launch says the other's live session, else origin's branch another clone pushed; never refused",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      const origin = join(root, 'shop.git');

      git(root, 'init', '-q', '--bare', origin);
      const [a, b] = ['shop-a', 'shop-b'].map((name) => {
        const dir = checkout(join(root, name));

        git(dir, 'remote', 'add', 'origin', origin);

        return realpathSync(dir);
      });
      const run = async (dir: string) =>
        readEnvelope(
          FactoryRunData,
          JSON.parse((await s.request('factory', 'run', '38', '--repo', dir, '--json')).stdout),
        );
      const first = await run(a ?? '');

      if (!first.ok) throw new Error(first.error.message);
      expect(first.data.branchShared).toBeUndefined();
      const second = await run(b ?? '');

      if (!second.ok) throw new Error(second.error.message);
      expect(second.data.branchShared).toBe(
        `AB#38 runs in ${a} too (session ${first.data.session}), a clone of the same origin: both push ${cardBranch('38', 'Saved cards')} and one pull request`,
      );
      // no live session on it elsewhere, but origin had its branch at B's last fetch
      const branch = cardBranch('39', 'Saved searches');

      git(a ?? '', 'push', '-q', origin, `main:refs/heads/${branch}`);
      git(b ?? '', 'fetch', '-q', 'origin');
      const third = readEnvelope(
        FactoryRunData,
        JSON.parse((await s.request('factory', 'run', '39', '--repo', b ?? '', '--json')).stdout),
      );

      if (!third.ok) throw new Error(third.error.message);
      expect(third.data.branchShared).toBe(
        `origin has ${branch} already, not made here: another clone's pushes and pull request are on the same branch`,
      );
    },
  );

  test(
    "a card's live session: a launch refused card-has-session; with --replace it is stopped first (ended, its worktree kept), then the new one runs",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      const run = async (...more: string[]) =>
        readEnvelope(
          FactoryRunData,
          JSON.parse(
            (await s.request('factory', 'run', '37', '--repo', repo, ...more, '--json')).stdout,
          ),
        );
      const show = async (id: string) =>
        doc(SessionData, await s.request('session', 'show', id, '--json'));
      const first = await run();

      if (!first.ok) throw new Error(first.error.message);
      expect((await show(first.data.session)).state).not.toBe('ended');
      // without the flag: refused as ever, the live one untouched
      expect(await run()).toMatchObject({ ok: false, error: { code: 'card-has-session' } });
      expect((await show(first.data.session)).state).not.toBe('ended');
      const second = await run('--replace');

      if (!second.ok) throw new Error(second.error.message);
      expect(second.data.session).not.toBe(first.data.session);
      // as abe session stop leaves it: ended by your hand, its worktree there
      expect(await show(first.data.session)).toMatchObject({
        state: 'ended',
        stopped: true,
      });
      expect(existsSync(first.data.worktree)).toBe(true);
      expect((await show(second.data.session)).state).not.toBe('ended');
      await s.request('session', 'stop', second.data.session, '--json');
    },
  );

  test(
    'a worktree Claude Code asks to trust first: no start timeout, the person answers it',
    { timeout: 30_000 },
    async () => {
      stuckClaude(s.state.dir, 'Do you trust the files in this folder?');
      const elsewhere = checkout(join(root, 'mine-wt'));

      // The person's own worktree on the card's branch: not at Abe's place, not trusted.
      git(
        elsewhere,
        'worktree',
        'add',
        '-q',
        '-b',
        cardBranch('8', 'Wish list'),
        join(root, 'by-hand'),
      );
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '8', '--repo', elsewhere, '--json'),
      );

      expect(run.worktree).toEndWith('/by-hand');
      s.clock.tick(3_600_000);
      expect(await status(8)).toMatchObject({ state: 'running', reason: null });
      expect(
        doc(SessionData, await s.request('session', 'show', run.session, '--json')),
      ).toMatchObject({ state: 'starting', reason: null });
    },
  );

  test(
    'a card the board will not move: said on the run and as factory.card, and the run goes on',
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [
        {
          abe: ['factory', 'stage-done', 'create-specification', '--json'],
        },
        { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
        { abe: ['factory', 'stage-done', 'build', '--json'] },
      ]);
      const w = watching(s.state.socket, ['watch', '--json', '--since', '0']);
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '7', '--repo', checkout(join(root, 'orders')), '--json'),
      );
      const moved = await until('AB#7 in review', async () => {
        const r = await status(7);

        return r?.stage === 'review' && r.board !== null ? r : undefined;
      });
      const error = "'Active' is not a state of this card";

      // On past build all the same.
      expect(moved).toMatchObject({
        stage: 'review',
        board: { column: 'active', state: 'Active', error },
      });
      for (;;) {
        const e = EventLine.parse(JSON.parse(await w.next(10_000)));

        // an earlier launch's move may come first: this run's
        if (e.type !== 'factory.card' || !JSON.stringify(e.data).includes(run.session)) continue;
        expect(e.data).toEqual({
          card: 7,
          session: run.session,
          column: 'active',
          state: 'Active',
          error,
        });
        break;
      }
      w.close();
    },
  );

  test(
    'an Override in force where it launched: the run is a hard one (#87), from the start',
    { timeout: 30_000 },
    async () => {
      const lowered = checkout(
        join(root, 'coupons'),
        undefined,
        'overrides:\n  autoMerge: { value: false, reason: no checks yet }\n',
      );
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '9', '--repo', lowered, '--json'),
      );

      expect(run.hard).toEqual(['an Override (autoMerge)']);
      expect((await status(4))?.hard).toEqual([]);
    },
  );

  test(
    'your Override in force where it launched: the run keeps it, why and since when (#168)',
    { timeout: 30_000 },
    async () => {
      const here = checkout(join(root, 'mine-run'));

      // yours for this repo
      writeFileSync(
        join(here, '.abe', 'settings.local.yaml'),
        'overrides:\n  limits.maxBoxDisk: { value: 900, reason: long builds, since: 2026-10-24T09:30:00.000Z }\n',
      );
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', '10', '--repo', here, '--json'),
      );

      expect(run.personal).toEqual([
        {
          key: 'limits.maxBoxDisk',
          value: 900,
          shown: '900',
          reason: 'long builds',
          since: '2026-10-24T09:30:00.000Z',
        },
      ]);
    },
  );

  test(
    'a Launch note from a file and a standing note (#347): in the first prompt after the card, kept on the run and its session',
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      const here = checkout(join(root, 'helper'));

      writeFileSync(
        join(here, 'why.md'),
        "use the existing price helper, don't add a dependency\n",
      );
      // yours for this repo: a standing note
      writeFileSync(
        join(here, '.abe', 'settings.local.yaml'),
        'launch.notes: [write the test first]\n',
      );
      const run = doc(
        FactoryRunData,
        await s.requestIn(
          here,
          'factory',
          'run',
          '16',
          '--repo',
          here,
          '--note-file',
          'why.md',
          '--json',
        ),
      );

      expect(run.note?.text).toBe("use the existing price helper, don't add a dependency");
      // from your name on the board (Assign › Me's), not git's user
      expect(run.note?.by).toBe(ME.name);
      expect(run.standing).toEqual([{ text: 'write the test first', layer: 'individual' }]);
      const prompt = await until('claude started', () => {
        const a = z.array(z.string()).safeParse(claudeOutput(run.worktree).argv);

        return a.success ? a.data.at(-1) : undefined;
      });

      expect(prompt).toContain(
        `## Notes from ${ME.name}\nuse the existing price helper, don't add a dependency\n\n## Standing notes\n- write the test first (yours)`,
      );
      expect(
        doc(SessionData, await s.request('session', 'show', run.session, '--json')).note?.text,
      ).toBe(run.note?.text);
      // both, or a file that is not there, is refused before anything starts
      const both = await s.request(
        'factory',
        'run',
        '16',
        '--note',
        'a',
        '--note-file',
        'why.md',
        '--json',
      );

      expect(both.exit).toBe(2);
    },
  );

  // The repo's sources in a run (ADR 0031): its abe.yaml sources:, each definition as
  // it is (a bare name's from the main checkout's local scope, then your user scope), in a config
  // Abe generates out of the sandbox's reach, never a repo's .mcp.json (the checkout's or its
  // worktree's) nor a server of yours sources: does not name; only they and Abe's start, and of
  // them only those the install checked (signed in, its one read ok); one in no config or not
  // checked is told and kept, the run goes on.
  const passed = { mcp: 'connected', probe: 'ok' } as const;

  test.each<{
    name: string;
    card: string;
    mcpJson: string;
    checks: Record<string, { mcp: McpState; probe: SourceProbeRead | null }>;
    allowed: string[];
    missing: string[];
    told: string;
  }>([
    {
      name: "the checkout has no .mcp.json: none loads, though the card's worktree has one",
      card: '20',
      mcpJson: 'committed, then deleted in the checkout',
      checks: { linear: passed, sentry: passed },
      allowed: ['linear', 'sentry'],
      missing: ['figma', 'keyed'],
      // one line: what loaded, then what did not
      told: "Sources: this repo also reads linear and sentry through their MCP servers. Every tool of theirs is allowed, writes too. figma is not loaded in this session: a session on this machine loads a source only from the repo's abe.yaml sources: (a bare name there from the person's Claude Code, until abe install source <name> writes its definition), never from a repo's .mcp.json, and a claude.ai connector does not load there. keyed is not loaded in this session: its server's definition holds a header or env value, and Abe copies no secret into a session's MCP config. Their tools are not here: say so to the person in one line at your start, and where a step needed one, say it was not read and go on; never ask for a token or set one up.",
    },
    {
      name: "the checkout's own .mcp.json names figma: never loaded",
      card: '21',
      mcpJson: 'in the checkout alone',
      checks: { linear: passed, sentry: passed },
      allowed: ['linear', 'sentry'],
      missing: ['figma', 'keyed'],
      told: "Sources: this repo also reads linear and sentry through their MCP servers. Every tool of theirs is allowed, writes too. figma is not loaded in this session: a session on this machine loads a source only from the repo's abe.yaml sources: (a bare name there from the person's Claude Code, until abe install source <name> writes its definition), never from a repo's .mcp.json, and a claude.ai connector does not load there. keyed is not loaded in this session: its server's definition holds a header or env value, and Abe copies no secret into a session's MCP config. Their tools are not here: say so to the person in one line at your start, and where a step needed one, say it was not read and go on; never ask for a token or set one up.",
    },
    {
      name: 'sentry never signed in at install, linear not added: neither starts, both said',
      card: '23',
      mcpJson: 'none',
      checks: { sentry: { mcp: 'needs-auth', probe: null } },
      allowed: [],
      missing: ['figma', 'keyed', 'linear', 'sentry'],
      told: "Sources: this repo's figma is not loaded in this session: a session on this machine loads a source only from the repo's abe.yaml sources: (a bare name there from the person's Claude Code, until abe install source <name> writes its definition), never from a repo's .mcp.json, and a claude.ai connector does not load there. linear, sentry are not checked at install, so not loaded in this session: a session on this machine starts a source's server only once the install signed it in and its one read passed (abe install runs it again). keyed is not loaded in this session: its server's definition holds a header or env value, and Abe copies no secret into a session's MCP config. Their tools are not here: say so to the person in one line at your start, and where a step needed one, say it was not read and go on; never ask for a token or set one up.",
    },
    {
      name: "linear's one read timed out: sentry alone starts",
      card: '24',
      mcpJson: 'none',
      checks: { linear: { mcp: 'connected', probe: 'timeout' }, sentry: passed },
      allowed: ['sentry'],
      missing: ['figma', 'keyed', 'linear'],
      told: "Sources: this repo also reads sentry through their MCP servers. Every tool of theirs is allowed, writes too. figma is not loaded in this session: a session on this machine loads a source only from the repo's abe.yaml sources: (a bare name there from the person's Claude Code, until abe install source <name> writes its definition), never from a repo's .mcp.json, and a claude.ai connector does not load there. linear is not checked at install, so not loaded in this session: a session on this machine starts a source's server only once the install signed it in and its one read passed (abe install runs it again). keyed is not loaded in this session: its server's definition holds a header or env value, and Abe copies no secret into a session's MCP config. Their tools are not here: say so to the person in one line at your start, and where a step needed one, say it was not read and go on; never ask for a token or set one up.",
    },
  ])(
    "the repo's sources load in a run: $name",
    { timeout: 30_000 },
    async ({ card: id, mcpJson, checks, allowed, missing, told }) => {
      scriptClaude(s.state.dir, [{ say: 'ok' }]);
      const sourced = checkout(
        join(root, `sourced-${id}`),
        undefined,
        // linear defined in it; sentry, figma and keyed bare names (ADR 0027's)
        'sources:\n  - { name: linear, transport: http, url: "https://mcp.linear.app/mcp" }\n  - sentry\n  - figma\n  - keyed\n',
      );
      // the session's HOME is serve's here: its Claude Code config names sentry, not figma
      const config = join(s.state.dir, '.claude.json');
      const was: unknown = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
      const figma = '{"mcpServers":{"figma":{"type":"http","url":"https://mcp.figma.com/mcp"}}}\n';

      if (mcpJson !== 'none') writeFileSync(join(sourced, '.mcp.json'), figma);
      if (mcpJson === 'committed, then deleted in the checkout') {
        git(sourced, 'add', '.mcp.json');
        git(sourced, 'commit', '-q', '-m', 'mcp');
        rmSync(join(sourced, '.mcp.json'));
      }
      const sentry = { type: 'http', url: 'https://mcp.sentry.dev/mcp' };
      const linear = { type: 'http', url: 'https://mcp.linear.app/mcp' };
      const keyed = { type: 'http', url: 'https://k.test/mcp', headers: { Authorization: 'x' } };
      const prior = z
        .looseObject({ projects: z.record(z.string(), z.unknown()).optional() })
        .parse(was);

      // sentry yours in user scope; keyed (holding a value) and stray the main checkout's local
      // ones, stray in no sources: so never loaded; linear's definition is the repo's alone
      writeFileSync(
        config,
        JSON.stringify({
          ...prior,
          mcpServers: { sentry, other: { command: 'other-mcp' } },
          projects: {
            ...prior.projects,
            [realpathSync(sourced)]: {
              mcpServers: { keyed, stray: { type: 'http', url: 'https://stray.test/mcp' } },
            },
            '/elsewhere/shop': { mcpServers: { figma: { type: 'http', url: 'https://f.test' } } },
          },
        }),
      );
      // its install's Sources: each source added, checked as the row says
      await installDone(s.state.dir, sourced, {
        sources: Object.fromEntries(Object.keys(checks).map((n) => [n, 'add'])),
        sourceServers: Object.fromEntries(Object.keys(checks).map((n) => [n, { from: 'yours' }])),
        sourceChecks: Object.fromEntries(
          Object.entries(checks).map(([n, c]) => [
            n,
            { ...c, why: null, at: '2026-10-27T09:00:00.000Z', signIn: false },
          ]),
        ),
      });
      const run = doc(
        FactoryRunData,
        await s.request('factory', 'run', id, '--repo', sourced, '--json'),
      );
      const argv = z
        .array(z.string())
        .parse(await until('its claude started', () => claudeOutput(run.worktree).argv));
      const at = argv.indexOf('--mcp-config');
      const settings = z
        .object({
          allowedMcpServers: z.array(z.object({ serverName: z.string() })).optional(),
        })
        .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')));
      const generated = join(s.state.dir, 'sources', `${run.session}.json`);
      const files = allowed.length === 0 ? [] : [generated];
      const instructions = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';

      expect(run).toMatchObject({ state: 'running', reason: null });
      // a stalling server gives up in 15 s (Claude Code's MCP_TIMEOUT), inside serve's 60 s wait
      expect(z.record(z.string(), z.string()).parse(claudeOutput(run.worktree).env)).toMatchObject({
        MCP_TIMEOUT: '15000',
      });
      expect(SESSION_START_TIMEOUT_MS).toBe(60_000);
      // each checked definition as it is (so its sign-in is reused), out of the session's own
      // folder; none checked: no config at all, Claude Code waits on no server
      if (allowed.length === 0) {
        expect(existsSync(generated)).toBe(false);
        expect(at).toBe(-1);
        expect(argv).toContain('--strict-mcp-config');
        expect(settings.allowedMcpServers).toBeUndefined();
      } else {
        expect(JSON.parse(readFileSync(generated, 'utf8'))).toEqual({
          mcpServers: Object.fromEntries(
            Object.entries({ linear, sentry }).filter(([n]) => allowed.includes(n)),
          ),
        });
        expect(statSync(generated).mode & 0o777).toBe(0o600);
        expect(argv.slice(at + 1, at + 2 + files.length)).toEqual([
          ...files,
          '--strict-mcp-config',
        ]);
        expect(settings.allowedMcpServers).toEqual(allowed.map((serverName) => ({ serverName })));
      }
      expect(existsSync(join(run.worktree, '.mcp.json'))).toBe(
        mcpJson === 'committed, then deleted in the checkout',
      );
      expect(instructions).toEndWith(`\n\n${told}`);
      expect(instructions.split('\n').filter((l) => l.startsWith('Sources'))).toEqual([told]);
      expect(
        doc(SessionData, await s.request('session', 'show', run.session, '--json')).sourcesMissing,
      ).toEqual([...missing]);
      await s.request('session', 'stop', run.session, '--json');
      expect(existsSync(generated)).toBe(false);
    },
  );

  test("a source's ${VAR}: filled from yours in .abe/sources.env, in its MCP config alone", async () => {
    scriptClaude(s.state.dir, [{ say: 'ok' }]);
    const repo = checkout(
      join(root, 'flags'),
      undefined,
      'sources:\n  - { name: flags, transport: stdio, command: node, args: [fake-flags-mcp.js], env: { FLAGS_API_USER: "${FLAGS_API_USER}", FLAGS_API_PASSWORD: "${FLAGS_API_PASSWORD}" } }\n',
    );

    // the password yours; the user not: its reference stays for Claude Code to fill
    writeFileSync(join(repo, '.abe', 'sources.env'), 'FLAGS_API_PASSWORD=fake-pass-36\n');
    await installDone(s.state.dir, repo, {
      sources: { flags: 'add' },
      sourceServers: { flags: { from: 'yours' } },
      sourceChecks: {
        flags: { ...passed, why: null, at: '2026-10-27T09:00:00.000Z', signIn: false },
      },
    });
    const run = doc(
      FactoryRunData,
      await s.request('factory', 'run', '36', '--repo', repo, '--json'),
    );
    const argv = z
      .array(z.string())
      .parse(await until('its claude started', () => claudeOutput(run.worktree).argv));
    const generated = join(s.state.dir, 'sources', `${run.session}.json`);

    expect(argv).toContain(generated);
    expect(JSON.parse(readFileSync(generated, 'utf8'))).toEqual({
      mcpServers: {
        flags: {
          type: 'stdio',
          command: 'node',
          args: ['fake-flags-mcp.js'],
          env: { FLAGS_API_USER: '${FLAGS_API_USER}', FLAGS_API_PASSWORD: 'fake-pass-36' },
        },
      },
    });
    // never in the session's own env
    expect(JSON.stringify(claudeOutput(run.worktree).env)).not.toContain('fake-pass-36');
    await s.request('session', 'stop', run.session, '--json');
  });
});

describe('a card starts only where the install is done', () => {
  let root: string;
  let claude: FakeClaude;
  let s: ServeScenario;
  const AT = '2026-10-27T09:00:00.000Z';
  let install: ReturnType<typeof installFakes>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-fg-'));
    mkdirSync(join(root, 'mine'), { recursive: true });
    // yours on this Mac: sessions here (the board is the fake's, the checkouts' settings their own)
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    claude = fakeClaude();
    install = installFakes({ env: {}, dir: root });
    s = await scenario({
      board: fakeBoard([card(4, 'Sign in'), card(5, 'Cart'), card(6, 'Totals')], {
        states: ['New', 'Closed'],
        me: ME,
      }),
      cardsNeedInstall: true,
      install,
      sessions: {
        env: {
          ...GIT_ENV,
          PATH: claude.path,
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
      },
    });
  }, 30_000);
  afterAll(async () => {
    await s.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test.each<[string, string[], 'none' | 'local' | 'done', string | null]>([
    [
      'a run, no install',
      ['factory', 'run', '4'],
      'none',
      'no-install: finish the install first: this checkout has none (abe install starts it)',
    ],
    [
      "a card's session, the install at Verify",
      ['session', 'launch', '--card', '5'],
      'local',
      'install-not-done: finish the install first: Verify (abe install opens it)',
    ],
    ['a run, the install done', ['factory', 'run', '6'], 'done', null],
  ])('%s', { timeout: 30_000 }, async (name, argv, record, refusal) => {
    scriptClaude(s.state.dir, [{ say: 'ok' }]);
    const repo = realpathSync(checkout(join(root, name.replaceAll(/\W+/g, '-'))));

    if (record !== 'none')
      await install.store.write(repo, {
        ...newInstall(repo, AT),
        // every part before Verify passes; done, every one
        parts: Object.fromEntries(
          INSTALL_PARTS.filter(
            (p) => record === 'done' || INSTALL_PARTS.indexOf(p) < INSTALL_PARTS.indexOf('verify'),
          ).map((p) => [p, { state: 'pass', line: 'ok', checkedAt: AT }]),
        ),
      });
    const said = z
      .object({
        ok: z.boolean(),
        data: z.object({ session: z.string() }).optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      })
      .parse(JSON.parse((await s.request(...argv, '--repo', repo, '--json')).stdout));

    expect(said.error === undefined ? null : `${said.error.code}: ${said.error.message}`).toBe(
      refusal,
    );
    if (said.data !== undefined) await s.request('session', 'stop', said.data.session, '--json');
  });

  // every screen on the card reads Launching from the ask on, whoever asked, and no session again
  // once it is refused
  test('a launch is said from its ask to its answer: started, then ended refused and why', async () => {
    const repo = realpathSync(checkout(join(root, 'said')));
    const w = watching(s.state.socket, ['watch', '--json', '--since', '0']);

    await s.request('factory', 'run', '4', '--repo', repo, '--json');
    const said: unknown[] = [];

    while (said.length < 2) {
      const e = EventLine.parse(JSON.parse(await w.next(10_000)));
      const d = z.object({ repo: z.string() }).loose().safeParse(e.data);

      if (e.type.startsWith('launch.') && d.success && d.data.repo === repo)
        said.push({ type: e.type, data: e.data });
    }
    w.close();
    expect(said).toEqual([
      { type: 'launch.started', data: { card: 4, repo } },
      {
        type: 'launch.ended',
        data: {
          card: 4,
          repo,
          session: null,
          refused: {
            code: 'no-install',
            message: 'finish the install first: this checkout has none (abe install starts it)',
          },
        },
      },
    ]);
  });

  // ADR 0028: a card's session reads its Abe env files, linked into its worktree from the main
  // checkout, and is told where they are; their values only reach its logs redacted
  test('Abe env files in a run: linked, never denied, told', { timeout: 30_000 }, async () => {
    scriptClaude(s.state.dir, [{ say: 'ok' }]);
    const repo = realpathSync(checkout(join(root, 'abe-env')));

    mkdirSync(join(repo, '.abe'), { recursive: true });
    writeFileSync(join(repo, '.abe', 'abe.test.env'), 'API_KEY=fake-key-test-5\n');
    await install.store.write(repo, {
      ...newInstall(repo, AT),
      finishedAt: AT,
    });
    const run = doc(
      FactoryRunData,
      await s.request('factory', 'run', '6', '--repo', repo, '--json'),
    );
    const argv = z
      .array(z.string())
      .parse(await until('its claude started', () => claudeOutput(run.worktree).argv));
    const settings = readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8');
    const told = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';
    const linked = join(run.worktree, '.abe', 'abe.test.env');

    expect([
      settings.includes('abe.test.env'),
      lstatSync(linked).isSymbolicLink() && readlinkSync(linked),
      // told only of the Abe env files there is: test's
      told.includes('Abe env files: .abe/abe.test.env holds'),
    ]).toEqual([false, join(repo, '.abe', 'abe.test.env'), true]);
    await s.request('session', 'stop', run.session, '--json');
  });

  // ADR 0029: prod is off for agents unless the person turns it on; --prod (the Launch form's
  // toggle) for this one session alone, its Abe env file linked, not denied, and told so
  test.each<[string, string[], boolean]>([
    ['prod off by the repo’s settings: not linked, denied', [], false],
    ['--prod: on for this session alone', ['--prod'], true],
  ])('%s', { timeout: 30_000 }, async (name, more, on) => {
    scriptClaude(s.state.dir, [{ say: 'ok' }]);
    const repo = realpathSync(checkout(join(root, `prod-${String(on)}`)));

    writeFileSync(join(repo, '.abe', 'abe.prod.env'), 'PROD_TOKEN=fake-prod-1\n');
    await install.store.write(repo, {
      ...newInstall(repo, AT),
      finishedAt: AT,
    });
    const run = doc(
      FactoryRunData,
      await s.request('factory', 'run', '6', '--repo', repo, ...more, '--json'),
    );
    const argv = z
      .array(z.string())
      .parse(await until('its claude started', () => claudeOutput(run.worktree).argv));
    const settings = readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8');
    const told = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';

    expect([
      name,
      settings.includes('abe.prod.env'),
      existsSync(join(run.worktree, '.abe', 'abe.prod.env')),
      told.includes('this session reaches dev and test and prod'),
      doc(SessionData, await s.request('session', 'show', run.session, '--json')).prodOn ?? false,
    ]).toEqual([name, !on, on, on, on]);
    await s.request('session', 'stop', run.session, '--json');
  });

  // ADR 0031: a bare `sources:` name (ADR 0027's) is loaded from the main checkout's local
  // servers until the install writes its definition, and said missing once it is gone from them
  test.each<[string, boolean, string[]]>([
    ["still in the main checkout's local servers: loaded", true, []],
    ['removed from them since: said missing', false, ['datadog']],
  ])('a bare sources: name in a run: %s', { timeout: 30_000 }, async (_, there, missing) => {
    scriptClaude(s.state.dir, [{ say: 'ok' }]);
    const repo = realpathSync(
      checkout(join(root, `added-${String(there)}`), undefined, 'sources: [datadog]\n'),
    );
    const datadog = { type: 'http', url: 'https://mcp.datadoghq.test/mcp' };
    // the session's HOME is serve's here: its Claude Code config holds the main checkout's servers
    const config = join(s.state.dir, '.claude.json');
    const was: unknown = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
    const prior = z
      .looseObject({ projects: z.record(z.string(), z.unknown()).optional() })
      .parse(was);

    writeFileSync(
      config,
      JSON.stringify({
        ...prior,
        projects: { ...prior.projects, [repo]: { mcpServers: there ? { datadog } : {} } },
      }),
    );
    await install.store.write(repo, {
      ...newInstall(repo, AT),
      finishedAt: AT,
      sources: { datadog: 'add' },
      sourceServers: { datadog: { from: 'typed', transport: 'http', url: datadog.url } },
      // checked at the install's Sources: the one kind of server a session loads
      sourceChecks: { datadog: { mcp: 'connected', probe: 'ok', why: null, at: AT } },
    });
    const run = doc(
      FactoryRunData,
      await s.request('factory', 'run', '6', '--repo', repo, '--json'),
    );
    const argv = z
      .array(z.string())
      .parse(await until('its claude started', () => claudeOutput(run.worktree).argv));
    const told = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';

    expect(
      doc(SessionData, await s.request('session', 'show', run.session, '--json')).sourcesMissing ??
        [],
    ).toEqual(missing);
    expect(told.includes('datadog is not loaded in this session')).toBe(!there);
    expect(told.includes('this repo also reads datadog')).toBe(there);
    await s.request('session', 'stop', run.session, '--json');
  });

  // a session can't sign in to aws: an enabled environment's expired login refuses every card's launch
  test.each([
    ['factory run', ['factory', 'run', '6']],
    ['session launch --card', ['session', 'launch', '--card', '6']],
  ])(
    'an expired aws login of an enabled environment, %s: refused before anything starts',
    async (name, launch) => {
      const repo = realpathSync(checkout(join(root, `aws-expired-${name.split(' ')[0] ?? ''}`)));

      writeFileSync(
        join(repo, '.abe', 'settings.local.yaml'),
        'credentials:\n  dev: { awsProfile: shop-dev }\n  test: { awsProfile: shop-test }\n  prod: { awsProfile: shop-prod }\n',
      );
      await install.store.write(repo, { ...newInstall(repo, AT), finishedAt: AT });
      install.expired.set('shop-test', 'Token has expired');
      // prod is off for agents: its login is never read
      install.expired.set('shop-prod', 'Token has expired');
      const reply = await s.request(...launch, '--repo', repo, '--json');

      expect(JSON.parse(reply.stdout)).toEqual({
        ok: false,
        error: {
          code: 'aws-login-expired',
          message:
            "the aws login of test (shop-test) is expired or missing, and a run can't sign in: sign in yourself in Terminal, then launch again: abe login aws --profile shop-test",
        },
      });
      expect(existsSync(worktreePath(repo, cardBranch('6', 'Totals')))).toBe(false);
    },
  );
});

describe('whose a Launch note is from: the board name, else git user, else the login', () => {
  const down = {
    me: () =>
      Promise.resolve({ ok: false as const, error: { code: 'offline' as const, message: 'x' } }),
  };
  const up = {
    me: () => Promise.resolve({ ok: true as const, data: { name: 'Ada', email: 'i@x.test' } }),
  };
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'abe-who-'));
    checkout(join(dir, 'r'));
    git(join(dir, 'r'), 'config', 'user.name', 'Git Dev');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test.each<[string, Parameters<typeof whoOf>[0], unknown, string]>([
    ['the board answers', up, BOARD, 'Ada'],
    ['the board fails', down, BOARD, 'Git Dev'],
    ['no board in the settings', up, undefined, 'Git Dev'],
    ['no board port', undefined, BOARD, 'Git Dev'],
  ])('%s', async (_, b, setting, want) => {
    expect(await whoOf(b, setting, join(dir, 'r'))).toBe(want);
  });
});
