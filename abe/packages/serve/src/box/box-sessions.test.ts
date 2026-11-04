/**
 * `abe session run` on a box's `serve` through the CLI seam (`--json`), with the fake Docker
 * port whose workspace container is a stand-in on this machine (`standInWorkspace`): a Factory
 * run's session started in the workspace with its managed and own settings, its socket's folder
 * the session user's alone, its logs read inside the container, and the command's refusals.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FACTORY_RUN_INSTRUCTIONS,
  FactoryStatusData,
  LogShipData,
  MCP_CONFIG,
  PLAIN_SESSION_INSTRUCTIONS,
  readEnvelope,
  PROTOCOL,
  Reply,
  type Secrets,
  SessionData,
  SettingExplainData,
  StatusData,
} from '@abe/core';
import { ask, containerExec, containerRunTree, fileLogStore } from '@abe/ports';
import {
  claudeOutput,
  type FakeDocker,
  fakeDocker,
  fakeGh,
  type FakeGh,
  fakeMirrors,
  git,
  type RecordingRunTree,
  recordingRunTree,
  refusingTracking,
  scenario,
  type ServeScenario,
  type StandIn,
  standInWorkspace,
  tempState,
} from '@abe/testing';
import { z } from 'zod';

setDefaultTimeout(30_000);

const REPO = 'mkdir-swe/demo-shop';
const SESSION = '4-a1b2';
const TEXT = JSON.stringify({ title: 'Sign in', description: '', acceptanceCriteria: '' });
/** The Mac's words for a run, from a 3.2 Mac still naming its Grill choice (read past). */
const LAUNCH_TEXT = JSON.stringify({
  title: 'Sign in',
  description: '',
  acceptanceCriteria: '',
  asked: 'grill',
  note: { by: 'Ada Example', text: 'use the price helper', at: '2026-10-25T10:00:00.000Z' },
  standing: [{ text: 'write the test first', layer: 'repo' }],
  // the card's type and tags (an older serve's: the box picks by them), and the workflow
  // picked locally: yours, a .local.yaml the box's clone never has
  type: 'User Story',
  tags: ['hotfix'],
  workflow: {
    id: 'spike',
    name: 'Spike',
    layer: 'yours',
    steps: [{ name: 'implement', kind: 'build', reports: [], doneWhen: null }],
    loops: [],
  },
});

/** A `--reference` as the Mac sends it (#351), its files at `dir`. */
const reference = (dir: string) =>
  JSON.stringify({
    run: { spec: null, prototype: { kind: 'store', url: 'prototype://demo-shop/4/v1' }, dir },
    prompt: 'Read the prototype first.',
  });

/** The repo's settings, in the box's checkout of its default branch. */
const REPO_SETTINGS = [
  'environments:',
  '  test:',
  '    account: "111111111111"',
  '    region: eu-west-1',
  '    db:',
  '      read: { secret: abe/test/db-read }',
  '',
].join('\n');

const secrets: Secrets = {
  read: () => Promise.resolve({ ok: true, data: 'postgres://reader:r@test-db:5432/shop' }),
};
const logins = {
  read: () =>
    Promise.resolve({
      ok: true as const,
      data: { claude: 'fake-claude-login', github: 'fake-gh-login' },
    }),
};

/** The keys of a rendered settings file these tests read. */
const Rendered = z.object({
  allowedMcpServers: z.array(z.object({ serverName: z.string() })).optional(),
  allowManagedHooksOnly: z.boolean().optional(),
  allowManagedPermissionRulesOnly: z.boolean().optional(),
  permissions: z
    .object({ allow: z.array(z.string()).optional(), defaultMode: z.string().optional() })
    .optional(),
  sandbox: z
    .object({ network: z.object({ allowedDomains: z.array(z.string()).optional() }).optional() })
    .optional(),
});

const HookAnswered = z.object({
  state: z.string(),
  answer: z
    .object({
      hookSpecificOutput: z.object({ decision: z.object({ behavior: z.string() }) }),
    })
    .optional(),
});

/** A `hooks.jsonl` line: the event, and the auto-answer's log when the hook answered it. */
const Logged = z.object({
  event: z.string(),
  permission: z
    .object({ tool: z.string(), behavior: z.string(), reason: z.string(), input: z.string() })
    .optional(),
});

const answer = <T extends z.ZodType>(schema: T, reply: Reply) =>
  readEnvelope(schema, JSON.parse(reply.stdout));

const data = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> => {
  const doc = answer(schema, reply);

  if (!doc.ok) throw new Error(`${doc.error.code}: ${doc.error.message}`);

  return doc.data;
};

/** A PermissionRequest from a session's claude, with the real paths its hook adds. */
const permission = async (
  w: World,
  id: string,
  tool: string,
  input: Record<string, unknown>,
  real: Record<string, string> = {},
) => {
  const socket = join(w.box.state.dir, 'workspaces', '4', 's', id, 'session.sock');
  const payload = {
    cwd: '/workspace/repo',
    hook_event_name: 'PermissionRequest',
    tool_name: tool,
    tool_input: input,
    abe_real_paths: real,
  };
  const argv = ['hook', 'PermissionRequest', '--payload', JSON.stringify(payload), '--json'];
  const asked = await ask(socket, JSON.stringify({ v: PROTOCOL, argv, cwd: '/workspace/repo' }));

  if (!asked.ok) throw new Error('no answer');

  return data(HookAnswered, Reply.parse(JSON.parse(asked.line)));
};

const refusal = (reply: Reply) => {
  const doc = answer(SessionData, reply);

  if (doc.ok) throw new Error(`expected a refusal, got ${reply.stdout}`);

  return { exit: reply.exit, code: doc.error.code };
};

const until = async <T>(what: string, check: () => Promise<T | undefined>) => {
  const deadline = Date.now() + 15_000;

  for (;;) {
    const value = await check();

    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(40);
  }
};

/** What the session's `claude` was told after Claude Code's own system prompt. */
const instructionsOf = async (worktree: string) => {
  const argv = await until('claude started', () => {
    const got = z.array(z.string()).safeParse(claudeOutput(worktree).argv);

    return Promise.resolve(got.success ? got.data : undefined);
  });

  return argv[argv.indexOf('--append-system-prompt') + 1];
};

type World = {
  root: string;
  /** The box's checkout of the repo's default branch, where its settings are read. */
  checkout: string;
  docker: FakeDocker;
  gh: FakeGh;
  standIn: StandIn;
  tree: RecordingRunTree;
  box: ServeScenario;
  run: (...flags: string[]) => Promise<Reply>;
};

const world = async (): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-bs-'));
  const gh = fakeGh([['auth', { stdout: '' }]]);
  const docker = fakeDocker();
  const mirrors = fakeMirrors();
  const state = tempState();

  const checkout = join(root, 'checkout');

  mirrors.trees.set(REPO, 'tree1');
  mirrors.checkouts.set(REPO, checkout);
  mkdirSync(join(checkout, '.abe', 'workflows'), { recursive: true });
  git(checkout, 'init', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'abe.yaml'), REPO_SETTINGS);
  // #15: the repo's workflow for cards tagged hotfix: the Factory's steps, by another name
  writeFileSync(
    join(checkout, '.abe', 'workflows', 'tagged.yaml'),
    'name: Tagged\non: { tags: [hotfix] }\nsteps: [create-specification, build, checks, review, verify, pr]\n',
  );
  // yours for the repo, never committed
  writeFileSync(join(checkout, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(checkout, '.abe', 'settings.local.yaml'), '');
  const standIn = standInWorkspace({
    docker,
    stateDir: state.dir,
    path: [gh.dir],
  });
  const tree = recordingRunTree(containerRunTree(containerExec(docker, 'abe-ws-4')));
  const box = await scenario({
    state,
    box: { docker, mirrors },
    sessions: { runner: standIn.runner, tree },
    logins,
    secrets,
    reachTarget: 'cloud',
    tracking: {
      ...refusingTracking(),
      me: () => Promise.resolve({ ok: true, data: { login: 'octocat' } }),
    },
    logs: { store: fileLogStore(join(root, 'store')), every: 3_600_000 },
    // Its idle stop (#92), looked at only through status here (no look in the test's time).
    idle: {
      name: 'demo-shop-4',
      host: {
        shutdown: () => Promise.resolve({ ok: true, data: null }),
        attached: () => Promise.resolve(false),
      },
      everyMs: 3_600_000,
    },
  });
  const up = await box.request(
    'workspace',
    'up',
    '--repo',
    REPO,
    '--card',
    '4',
    '--title',
    'Sign in',
    '--json',
  );

  if (up.exit !== 0) throw new Error(up.stdout + up.stderr);

  return {
    root,
    checkout,
    docker,
    gh,
    standIn,
    tree,
    box,
    run: (...flags) => box.request('session', 'run', ...flags, '--json'),
  };
};

describe('abe session run --factory: a Factory run in the workspace', () => {
  let w: World;
  let s: SessionData;

  beforeAll(async () => {
    w = await world();
    s = data(
      SessionData,
      await w.run(
        '--id',
        SESSION,
        '--repo',
        REPO,
        '--card',
        '4',
        '--text',
        LAUNCH_TEXT,
        '--factory',
      ),
    );
    await until('the session waiting', async () => {
      const shown = data(SessionData, await w.box.request('session', 'show', SESSION, '--json'));

      return shown.state === 'waiting' ? true : undefined;
    });
  });

  afterAll(async () => {
    await w.box.close();
    await w.standIn.remove();
    w.gh.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  test('ok: the session in the workspace clone, on the card branch the workspace holds', () => {
    expect(s).toMatchObject({ id: SESSION, card: 4, repo: REPO, worktree: w.standIn.workdir });
  });

  test("a Factory run's instructions", async () => {
    expect(await instructionsOf(w.standIn.workdir)).toBe(FACTORY_RUN_INSTRUCTIONS);
  });

  test("the launch's workflow and notes came with the card's words; an old Grill choice is read past", async () => {
    const status = data(FactoryStatusData, await w.box.request('factory', 'status', '--json'));
    const argv = z.array(z.string()).parse(claudeOutput(w.standIn.workdir).argv);

    // the workflow picked locally, not the one the card's tags pick in the box's clone
    expect(status.runs.map((r) => [r.workflow?.id, r.workflow?.layer])).toEqual([
      ['spike', 'yours'],
    ]);
    expect(argv.some((a) => a.includes('The person asked to be grilled first'))).toBe(false);
    // the Launch note and standing notes the Mac sent (#347)
    expect(status.runs.map((r) => r.note?.text)).toEqual(['use the price helper']);
    expect(
      argv.some((a) =>
        a.includes(
          '## Notes from Ada Example\nuse the price helper\n\n## Standing notes\n- write the test first (the repo)',
        ),
      ),
    ).toBe(true);
  });

  test('the managed settings: only theirs count, the network open (ADR 0029)', () => {
    const managed = Rendered.parse(JSON.parse(readFileSync(w.standIn.managed, 'utf8')));

    expect(managed.allowManagedHooksOnly).toBe(true);
    expect(managed.allowManagedPermissionRulesOnly).toBe(true);
    // The in-session abe commands are allowed there, since --settings' rules no longer count.
    expect(managed.permissions?.allow).toContain('Bash(abe factory judge:*)');
    expect(managed.sandbox?.network).toBeUndefined();
  });

  test("its own settings: a Factory run's permission mode, so it never stops to ask", () => {
    const own = Rendered.parse(
      JSON.parse(
        readFileSync(join(w.standIn.home, '.abe', 'sessions', SESSION, 'settings.json'), 'utf8'),
      ),
    );

    expect(own.permissions?.defaultMode).toBe('acceptEdits');
  });

  test("its socket's folder is the session user's alone", () => {
    const socketDir = join(w.box.state.dir, 'workspaces', '4', 's', SESSION);
    const folder = statSync(socketDir);

    expect(folder.mode & 0o777).toBe(0o700);
    expect(folder.uid).toBe(process.getuid?.() ?? -1);
  });

  test('its logs: the transcript and the Evidence read inside the container, at its paths', async () => {
    const verify = join(w.standIn.workdir, '.scratch', '4', 'verify');

    mkdirSync(join(verify, 'evidence'), { recursive: true });
    writeFileSync(join(verify, '1-after.md'), 'After: pass\n');
    writeFileSync(join(verify, 'evidence', 'after-1.txt'), 'In stock\n');
    const shipped = data(LogShipData, await w.box.request('log', 'ship', SESSION, '--json'));

    expect(shipped.files.map((f) => f.name)).toEqual([
      'meta.json',
      'hooks.jsonl',
      'run.json',
      'transcript.jsonl',
      'verify/1-after.md',
      'verify/evidence/after-1.txt',
    ]);
    // Read where the session ran: its home and clone in the container, never the box's disk.
    const asked = w.tree.logsAsked.at(-1);

    expect(asked?.files[0]?.within).toBe(join(w.standIn.home, '.claude', 'projects'));
    expect(asked?.dirs.map((d) => d.within)).toEqual([w.standIn.workdir, w.standIn.workdir]);
  });

  test("a hook from its session starts the box's idle time again (#92)", async () => {
    const idle = async () => data(StatusData, await w.box.request('status', '--json')).idle;
    const before = await idle();

    w.box.clock.tick(10 * 60_000);
    expect((await idle())?.activeAt).toBe(before?.activeAt);
    const socket = join(w.box.state.dir, 'workspaces', '4', 's', SESSION, 'session.sock');
    const argv = [
      'hook',
      'PostToolUse',
      '--payload',
      '{"hook_event_name":"PostToolUse"}',
      '--json',
    ];
    const hooked = await ask(socket, JSON.stringify({ v: PROTOCOL, argv, cwd: '/workspace/repo' }));

    expect(hooked.ok && Reply.parse(JSON.parse(hooked.line)).exit).toBe(0);
    expect((await idle())?.activeAt).toBe(new Date(w.box.clock.now()).toISOString());
  });

  test("serve.target is the Mac's: a box's own serve launches on itself, never refused no-boxes", async () => {
    const out = await w.box.requestIn(
      w.checkout,
      'session',
      'launch',
      '--card',
      '4',
      '--repo',
      '.',
      '--json',
    );

    // Placed here, past serve.target: the card is read next, and the box's checkout names no board.
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, error: { code: 'no-board' } });
  });

  test('a permission prompt nobody sees is answered: sandboxed commands, workspace reads and the browser allowed, the rest refused, each answer in its log (#67)', async () => {
    const before = data(SessionData, await w.box.request('session', 'show', SESSION, '--json'));
    const behavior = async (tool: string, input: Record<string, unknown>, real = {}) =>
      (await permission(w, SESSION, tool, input, real)).answer?.hookSpecificOutput.decision
        .behavior;
    const bash = await permission(w, SESSION, 'Bash', { command: 'echo "${PIPESTATUS[0]}"' });

    expect(bash.answer?.hookSpecificOutput.decision.behavior).toBe('allow');
    // Answered, so nobody is waited on: the session's state stays as it was.
    expect(bash.state).toBe(before.state);
    expect(await behavior('Bash', { command: 'curl x', dangerouslyDisableSandbox: true })).toBe(
      'deny',
    );
    const inside = '/workspace/repo/src/a.ts';

    expect(await behavior('Read', { file_path: inside }, { [inside]: inside })).toBe('allow');
    const escape = '/workspace/repo/../../home/abe/.ssh/id_ed25519';

    expect(
      await behavior('Read', { file_path: escape }, { '/home/abe/.ssh/id_ed25519': '/x' }),
    ).toBe('deny');
    expect(await behavior('mcp__chrome-devtools__take_screenshot', {})).toBe('allow');
    expect(await behavior('WebFetch', { url: 'https://example.com' })).toBe('deny');
    const logged = readFileSync(join(w.box.state.dir, 'sessions', SESSION, 'hooks.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => Logged.parse(JSON.parse(line)))
      .flatMap((line) => (line.permission === undefined ? [] : [line.permission]));

    expect(logged.map((l) => [l.tool, l.behavior])).toEqual([
      ['Bash', 'allow'],
      ['Bash', 'deny'],
      ['Read', 'allow'],
      ['Read', 'deny'],
      ['mcp__chrome-devtools__take_screenshot', 'allow'],
      ['WebFetch', 'deny'],
    ]);
    expect(logged[1]).toEqual({
      tool: 'Bash',
      behavior: 'deny',
      reason: 'a command outside the sandbox',
      input: 'curl x',
    });
    expect(logged[3]?.reason).toContain('outside the workspace');
  });

  test('a card with no workspace on the box yet is refused: its workspace comes first (ADR 0022)', async () => {
    expect(refusal(await w.run('--repo', REPO, '--card', '5', '--text', TEXT))).toEqual({
      exit: 1,
      code: 'no-workspace',
    });
  });

  test("an id that is not the card's session is a usage error: its id names its workspace", async () => {
    expect(
      refusal(await w.run('--id', '5-a1b2', '--repo', REPO, '--card', '4', '--text', TEXT)),
    ).toEqual({ exit: 2, code: 'usage' });
  });

  test.each([
    [['--repo', 'nope', '--card', '4', '--text', TEXT]],
    [['--repo', REPO, '--card', 'x', '--text', TEXT]],
    [['--repo', REPO, '--card', '4', '--text', '{"words":1}']],
    [['--repo', REPO, '--card', '4']],
    // #351: the Mac's reference is a run's, at its own card's folder
    [['--repo', REPO, '--card', '4', '--text', TEXT, '--factory', '--reference', '{"run":1}']],
    [
      [
        '--repo',
        REPO,
        '--card',
        '4',
        '--text',
        TEXT,
        '--reference',
        reference('.scratch/4/prototype'),
      ],
    ],
    [
      [
        '--repo',
        REPO,
        '--card',
        '4',
        '--text',
        TEXT,
        '--factory',
        '--reference',
        reference('../x'),
      ],
    ],
  ])('%j is a usage error', async (flags) => {
    expect(refusal(await w.run(...flags))).toEqual({ exit: 2, code: 'usage' });
  });

  // Last: it ends the session.
  test("an ended session's worktrees git lost track of are pruned, outside the sandbox", async () => {
    const socket = join(w.box.state.dir, 'workspaces', '4', 's', SESSION, 'session.sock');
    const payload = '{"hook_event_name":"SessionEnd","reason":"prompt_input_exit"}';
    const argv = ['hook', 'SessionEnd', '--payload', payload, '--json'];
    const prune =
      'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C /workspace/repo worktree prune';
    const prunes = () =>
      w.docker.execs.filter((e) => e.name === 'abe-ws-4' && e.argv.join(' ') === prune);

    expect(prunes()).toEqual([]);
    const hooked = await ask(socket, JSON.stringify({ v: PROTOCOL, argv, cwd: '/workspace/repo' }));

    expect(hooked.ok && Reply.parse(JSON.parse(hooked.line)).exit).toBe(0);
    // As the container's own user, never the script user or root.
    expect(
      await until('the prune', () => Promise.resolve(prunes().length > 0 ? prunes() : undefined)),
    ).toEqual([{ name: 'abe-ws-4', argv: prune.split(' ') }]);
  });
});

describe("abe session run without --factory: a person's session in the workspace", () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    data(SessionData, await w.run('--id', SESSION, '--repo', REPO, '--card', '4', '--text', TEXT));
  });

  afterAll(async () => {
    await w.box.close();
    await w.standIn.remove();
    w.gh.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  test('a plain session is told it is no Factory run (#186)', async () => {
    expect(await instructionsOf(w.standIn.workdir)).toBe(PLAIN_SESSION_INSTRUCTIONS);
  });

  test("its permission prompts are the person's: the hook answers nothing, the session waits (#67)", async () => {
    const asked = await permission(w, SESSION, 'Bash', { command: 'ls' });

    expect(asked.answer).toBeUndefined();
    expect(asked.state).toBe('waiting');
    const lines = readFileSync(join(w.box.state.dir, 'sessions', SESSION, 'hooks.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => Logged.parse(JSON.parse(line)));

    expect(lines.some((line) => line.permission !== undefined)).toBe(false);
  });

  test('--reopen (#343): the session the box keeps goes on, its conversation resumed with the message', async () => {
    const state = async () =>
      data(SessionData, await w.box.request('session', 'show', SESSION, '--json'));
    const run = (...more: string[]) =>
      w.run('--repo', REPO, '--card', '4', '--text', TEXT, ...more);

    // its claude's own hooks heard (its transcript named), waiting on you
    await until('it waits', async () => {
      const now = await state();

      return now.state === 'waiting' && now.transcriptPath !== null ? true : undefined;
    });
    // the flags go together, and only with a session of this box
    expect(refusal(await run('--reopen'))).toEqual({ exit: 2, code: 'usage' });
    expect(refusal(await run('--id', SESSION, '--message', 'x'))).toEqual({
      exit: 2,
      code: 'usage',
    });
    expect(refusal(await run('--id', '4-ffff', '--reopen'))).toMatchObject({ code: 'no-session' });
    expect(refusal(await run('--id', SESSION, '--reopen'))).toMatchObject({ code: 'not-ended' });
    await w.box.request('session', 'stop', SESSION);
    await until('it ended', async () => ((await state()).state === 'ended' ? true : undefined));
    const claudeId = /([0-9a-f-]{36})\.jsonl$/.exec((await state()).transcriptPath ?? '')?.[1];

    expect(
      data(SessionData, await run('--id', SESSION, '--reopen', '--message', 'why?')),
    ).toMatchObject({ id: SESSION });
    const argv = await until('claude resumed', () => {
      const got = z.array(z.string()).safeParse(claudeOutput(w.standIn.workdir).argv);

      return Promise.resolve(got.success && got.data.includes('--resume') ? got.data : undefined);
    });

    expect(argv[argv.indexOf('--resume') + 1]).toBe(claudeId ?? '');
    expect(argv.at(-1)).toBe('why?');
    // a plain one stays plain: no run starts
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toStartWith(
      PLAIN_SESSION_INSTRUCTIONS,
    );
    expect((await state()).reopened).toHaveLength(1);
  });
});

/** The Mac's working copy of abe.yaml (3.2.1): sentry and linear defined, figma bare. */
const SYNCED_SETTINGS = [
  REPO_SETTINGS,
  'sources:',
  '  - { name: sentry, transport: http, url: https://mcp.sentry.dev/mcp, headers: { X-Sentry-Org: "${SENTRY_ORG}" } }',
  '  - { name: linear, transport: sse, url: https://mcp.linear.app/sse }',
  '  - figma',
  '',
].join('\n');

describe("a box session's sources (3.2.1): the Mac's synced abe.yaml sources:, never the box's own Claude Code config nor the repo's .mcp.json", () => {
  let w: World;
  let argv: string[];

  beforeAll(async () => {
    w = await world();
    // the clone: docs in its base branch's .mcp.json; the card branch adds figma there; neither read
    const git = (...args: string[]) => {
      const ran = Bun.spawnSync(
        ['git', '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...args],
        { cwd: w.standIn.workdir },
      );

      if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
    };
    const mcpJson = (servers: Record<string, unknown>) => {
      writeFileSync(join(w.standIn.workdir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
    };

    git('init', '-q', '-b', 'main');
    mcpJson({ docs: { command: 'docs-mcp' } });
    git('add', '.mcp.json');
    git('commit', '-q', '-m', 'docs');
    git('checkout', '-q', '-b', 'card/4-sign-in');
    mcpJson({ docs: { command: 'docs-mcp' }, figma: { command: 'figma-mcp' } });
    git('commit', '-q', '-am', 'figma');
    // the box's own Claude Code config (the platform Terraform's, before 3.2.1): never read now
    writeFileSync(
      join(w.standIn.home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          sentry: {
            type: 'http',
            url: 'https://mcp.sentry.dev/mcp',
            headers: { Authorization: 'Bearer box-token' },
          },
          other: { command: 'other-mcp' },
        },
      }),
    );
    // your value for sentry's reference, as the Mac's sync put it: out of the clone
    mkdirSync(join(w.standIn.home, '.abe', 'sync'), { recursive: true, mode: 0o700 });
    writeFileSync(join(w.standIn.home, '.abe', 'sync', 'sources.env'), 'SENTRY_ORG=fake-org-4\n');
    data(
      SessionData,
      await w.run(
        '--id',
        SESSION,
        '--repo',
        REPO,
        '--card',
        '4',
        '--text',
        TEXT,
        '--sync',
        // the Mac's install checked sentry alone; it synced dev's Abe env file
        JSON.stringify({
          repo: SYNCED_SETTINGS,
          checked: ['sentry'],
          envFiles: ['dev'],
          locked: ['abe.yaml', '.claude/skills/run-app/SKILL.md'],
        }),
      ),
    );
    argv = await until('claude started', () => {
      const got = z.array(z.string()).safeParse(claudeOutput(w.standIn.workdir).argv);

      return Promise.resolve(got.success ? got.data : undefined);
    });
  });

  afterAll(async () => {
    await w.box.close();
    await w.standIn.remove();
    w.gh.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  const sessionFile = (name: string) =>
    readFileSync(join(w.standIn.home, '.abe', 'sessions', SESSION, name), 'utf8');

  test("the config Abe generates of abe.yaml's checked sources, then Abe's own, strict: only Abe's servers and sentry start", () => {
    const at = argv.indexOf('--mcp-config');

    expect(argv.slice(at + 1, at + 4)).toEqual([
      join(w.standIn.home, '.abe', 'sessions', SESSION, 'sources.json'),
      MCP_CONFIG,
      '--strict-mcp-config',
    ]);
    // the same definition as the Mac's session's, so the token synced under its key signs it in
    // its reference filled from your synced value, in this config alone
    expect(JSON.parse(sessionFile('sources.json'))).toEqual({
      mcpServers: {
        sentry: {
          type: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          headers: { 'X-Sentry-Org': 'fake-org-4' },
        },
      },
    });
    expect(JSON.stringify(claudeOutput(w.standIn.workdir).env)).not.toContain('fake-org-4');
    expect(sessionFile('settings.json')).not.toContain('fake-org-4');
    const allowed = Rendered.parse(JSON.parse(sessionFile('settings.json'))).allowedMcpServers?.map(
      (s) => s.serverName,
    );

    expect(allowed).toContain('sentry');
    for (const name of ['docs', 'other', 'figma', 'linear']) expect(allowed).not.toContain(name);
    // never a copy of the box's own server: its token stays in its config alone
    expect(sessionFile('settings.json')).not.toContain('box-token');
    expect(sessionFile('sources.json')).not.toContain('box-token');
    // the Mac's abe.yaml is the box checkout's now: the box's settings are the person's
    expect(readFileSync(join(w.checkout, 'abe.yaml'), 'utf8')).toBe(SYNCED_SETTINGS);
  });

  test('every tool of the sources is allowed in the managed settings, the only rules that count there', () => {
    const managed = Rendered.parse(JSON.parse(readFileSync(w.standIn.managed, 'utf8')));

    expect(managed.permissions?.allow).toContain('mcp__sentry__*');
    expect(managed.permissions?.allow).toContain('Bash(abe factory judge:*)');
    // the team's files the Mac changed alone are no file tool's to write; the rest is the card's
    const deny = z
      .array(z.string())
      .parse(
        z
          .object({ permissions: z.object({ deny: z.array(z.string()) }) })
          .parse(JSON.parse(readFileSync(w.standIn.managed, 'utf8'))).permissions.deny,
      );

    expect(deny).toContain('Edit(//workspace/repo/.claude/skills/run-app/SKILL.md)');
    expect(deny.filter((r) => r.includes('.claude/skills'))).toEqual([
      'Edit(//workspace/repo/.claude/skills/run-app/SKILL.md)',
    ]);
  });

  test('figma (bare) and linear (not checked on the Mac): one line names sentry alone and says why each is not here, its record says so, and the env line names the synced file alone', async () => {
    expect(await instructionsOf(w.standIn.workdir)).toBe(
      `${PLAIN_SESSION_INSTRUCTIONS}\n\nAbe env files: .abe/abe.dev.env holds this repo's values per environment, synced read-only from the person's Mac into this clone (the Mac's copy is the one to change). Never print, quote or commit a value; a missing key is the person's to add there.\n\nSources: this repo also reads sentry through their MCP servers. Every tool of theirs is allowed, writes too. figma is not loaded on this box: a box's session loads a source only from the repo's abe.yaml sources: with its definition (abe install source <name> writes a bare name's), never from a repo's .mcp.json, and a claude.ai connector does not load on a box. linear is not checked at the install on the person's Mac, so not loaded on this box: a box starts a source's server only once the Mac's install signed it in and its one read passed (abe install there runs it again). Their tools are not here: say so to the person in one line at your start, and where a step needed one, say it was not read and go on; never ask for a token or set one up.`,
    );
    expect(
      data(SessionData, await w.box.request('session', 'show', SESSION, '--json')).sourcesMissing,
    ).toEqual(['figma', 'linear']);
    expect((await w.box.request('session', 'show', SESSION)).stdout).toContain(
      '  sources     not loaded here: figma, linear\n',
    );
  });
});

describe("abe session run --layer: the launching person's files are the box's (#222, ADR 0030)", () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  });

  afterAll(async () => {
    await w.box.close();
    await w.standIn.remove();
    w.gh.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  /** `abe settings explain autoMerge`, typed in the box's checkout of the repo. */
  const explained = async () =>
    data(
      SettingExplainData,
      await w.box.requestIn(w.checkout, 'settings', 'explain', 'autoMerge', '--json'),
    );
  const boxFile = () =>
    readFileSync(join(w.box.state.dir, '.config', 'abe', 'settings.yaml'), 'utf8');
  const localFile = () => readFileSync(join(w.checkout, '.abe', 'settings.local.yaml'), 'utf8');

  test("yours on the Mac is the box's own; yours for the repo, Overrides too, in force in its checkout", async () => {
    const layer = {
      machine: { 'box.idleMinutes': 45 },
      local: {
        overrides: {
          autoMerge: { value: true, reason: 'my sandbox', since: '2026-10-24T10:00:00Z' },
        },
      },
    };

    data(
      SessionData,
      await w.run(
        '--id',
        SESSION,
        '--repo',
        REPO,
        '--card',
        '4',
        '--text',
        TEXT,
        '--layer',
        JSON.stringify(layer),
      ),
    );
    const e = await explained();

    expect(e).toMatchObject({ value: true, winner: 'individual' });
    expect(e.lowered).toContain('my sandbox');
    expect(boxFile()).toContain('box.idleMinutes: 45');
    expect(localFile()).toContain('my sandbox');
  });

  test('a later launch under empty files takes the earlier ones out: autoMerge back to a person', async () => {
    await w.run(
      '--id',
      '4-c3d4',
      '--repo',
      REPO,
      '--card',
      '4',
      '--text',
      TEXT,
      '--layer',
      JSON.stringify({ machine: {}, local: {} }),
    );

    expect(await explained()).toMatchObject({ value: false, winner: 'core', lowered: null });
    expect(boxFile()).not.toContain('box.idleMinutes');
  });

  test('a --layer that is no { machine, local } maps of settings is refused before anything is written', async () => {
    const before = [boxFile(), localFile()];

    for (const bad of ['not json', '[1]', '"x"', '{}'])
      expect(
        refusal(await w.run('--repo', REPO, '--card', '4', '--text', TEXT, '--layer', bad)),
      ).toEqual({ exit: 2, code: 'usage' });
    expect([boxFile(), localFile()]).toEqual(before);
  });
});

test('a serve that is no box: not-a-box', async () => {
  await using s = await scenario();

  expect(
    refusal(
      await s.request('session', 'run', '--repo', REPO, '--card', '4', '--text', TEXT, '--json'),
    ),
  ).toEqual({ exit: 1, code: 'not-a-box' });
});
