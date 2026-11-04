/**
 * The settings service at its interface, in process on a temp dir of Layer files: one merged
 * snapshot per checkout, a lookup reading no file, an edit taking effect at the next poll (a
 * `settings.changed` with the keys whose merged value moved), and the facts derived from it.
 * `abe watch` streaming the event is `settings.test.ts`'s.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SettingsChangedData } from '@abe/core';
import { type CheckoutFacts, type SettingsService, startSettings } from '.';

let root: string;
let service: SettingsService | undefined;
let events: SettingsChangedData[];

const write = (path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};
/** `path` (from the temp dir) made a checkout: a `.git` folder, or a worktree's `.git` file. */
const checkout = (path: string, worktreeOf?: string) => {
  if (worktreeOf === undefined) mkdirSync(join(root, path, '.git'), { recursive: true });
  else write(join(path, '.git'), `gitdir: ${join(root, worktreeOf, '.git', 'worktrees', 'w')}\n`);
};
const start = (environment?: Record<string, string>) => {
  service = startSettings({
    places: { configDir: join(root, 'mine'), home: root },
    emit: (data) => events.push(data),
    every: 3_600_000,
    ...(environment === undefined ? {} : { environment }),
  });

  return service;
};
/** Each path from the temp dir as the service names it; `.` the temp dir itself. */
const at = (path: string) => (path === '.' ? root : join(root, path));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-snapshot-')));
  // yours on this Mac, the repo's file and yours for the repo (written here: no move runs)
  write('mine/settings.yaml', 'serve.target: local\n');
  write('repo/abe.yaml', 'autoMerge: false\n');
  write('repo/.abe/settings.local.yaml', 'limits:\n  maxBoxSize: m8g.large\n');
  checkout('repo');
  events = [];
});

afterEach(() => {
  service?.stop();
  service = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** One step on the service: a lookup in a folder, a file written or removed, a poll, a checkout made. */
type Step =
  | { at: string }
  | { write: string; text: string }
  | { rm: string }
  | { checkout: string; of?: string }
  | { mv: string; to: string }
  | 'poll';

/** `steps` in turn; a lookup or a poll on `s`. */
const run = (steps: readonly Step[], s?: SettingsService) => {
  for (const step of steps)
    if (step === 'poll') s?.poll();
    else if ('at' in step) s?.at(at(step.at));
    else if ('write' in step) write(step.write, step.text);
    else if ('rm' in step) rmSync(join(root, step.rm), { recursive: true, force: true });
    else if ('mv' in step) renameSync(join(root, step.mv), join(root, step.to));
    else checkout(step.checkout, step.of);
};

/** The events, their repos from the temp dir (`.`: none). */
type Said = { keys: string[]; repo: string | null };

describe('a snapshot per checkout: what a lookup gives after which steps, and what is said', () => {
  test.each<[string, Step[], { values?: Record<string, Record<string, unknown>>; said: Said[] }]>([
    [
      'nothing changed, or a change that moves no value, is no event',
      [
        { at: 'repo' },
        'poll',
        { write: 'mine/settings.yaml', text: '# mine\nserve.target: local\n' },
        { write: 'repo/abe.yaml', text: '# the repo\nautoMerge: false\n' },
        'poll',
      ],
      { said: [] },
    ],
    [
      'an edit of yours on this Mac gives the keys whose merged value moved, once per checkout seen',
      [
        { at: 'repo' },
        { write: 'mine/settings.yaml', text: 'serve.target: cloud\nbox:\n  region: eu-north-1\n' },
        'poll',
        'poll',
      ],
      {
        values: { repo: { 'serve.target': 'cloud', 'box.region': 'eu-north-1' } },
        said: [
          { keys: ['serve.target', 'box.region'], repo: null },
          { keys: ['serve.target', 'box.region'], repo: 'repo' },
        ],
      },
    ],
    [
      "an edit of the repo's file or yours for it moves that checkout alone",
      [
        { at: 'repo' },
        { write: 'repo/abe.yaml', text: 'autoMerge: false\nbox:\n  size: m8g.large\n' },
        { write: 'repo/.abe/settings.local.yaml', text: 'limits:\n  maxBoxSize: m8g.xlarge\n' },
        'poll',
      ],
      { said: [{ keys: ['limits.maxBoxSize', 'box.size'], repo: 'repo' }] },
    ],
    [
      'a lookup reads no file: the files gone, it answers as before until the next poll',
      [{ at: 'repo' }, { rm: 'repo/.abe' }, { rm: 'mine' }],
      { values: { repo: { 'serve.target': 'local', 'limits.maxBoxSize': 'm8g.large' } }, said: [] },
    ],
    [
      'an edit takes effect at the next poll',
      [
        { at: 'repo' },
        { write: 'repo/.abe/settings.local.yaml', text: 'limits:\n  maxBoxSize: m8g.xlarge\n' },
        'poll',
      ],
      {
        values: { repo: { 'limits.maxBoxSize': 'm8g.xlarge' } },
        said: [{ keys: ['limits.maxBoxSize'], repo: 'repo' }],
      },
    ],
    [
      "a new file is a change: a checkout's abe.yaml appearing",
      [
        { checkout: 'other' },
        { at: 'other' },
        { write: 'other/abe.yaml', text: 'box:\n  size: m8g.large\n' },
        'poll',
        'poll',
      ],
      {
        values: { other: { 'box.size': 'm8g.large' } },
        said: [{ keys: ['box.size'], repo: 'other' }],
      },
    ],
    [
      "a worktree reads its main checkout's abe.yaml until its own appears",
      [
        { checkout: 'repo-wt/1', of: 'repo' },
        { write: 'repo/abe.yaml', text: 'box:\n  size: m8g.large\n' },
        { at: 'repo-wt/1' },
        { write: 'repo-wt/1/abe.yaml', text: 'box:\n  size: m8g.xlarge\n' },
        'poll',
      ],
      {
        values: { 'repo-wt/1': { 'box.size': 'm8g.xlarge', 'limits.maxBoxSize': 'm8g.large' } },
        said: [{ keys: ['box.size'], repo: 'repo-wt/1' }],
      },
    ],
    [
      'a checkout seen after an edit does not swallow that edit for the others',
      [{ write: 'mine/settings.yaml', text: 'serve.target: cloud\n' }, { at: 'repo' }, 'poll'],
      { said: [{ keys: ['serve.target'], repo: null }] },
    ],
    [
      'an entry refused for want of an Override moves nothing',
      [
        { at: 'repo' },
        { write: 'repo/.abe/settings.local.yaml', text: 'autoMerge: true\n' },
        'poll',
      ],
      {
        values: { repo: { autoMerge: false } },
        said: [{ keys: ['limits.maxBoxSize'], repo: 'repo' }],
      },
    ],
    [
      'a worktree whose main checkout moved reads its files where they are once git links it again',
      [
        { checkout: 'repo-wt/1', of: 'repo' },
        { at: 'repo-wt/1' },
        { mv: 'repo', to: 'repo-moved' },
        'poll',
        // `git worktree repair` in the moved checkout
        { checkout: 'repo-wt/1', of: 'repo-moved' },
        'poll',
      ],
      {
        values: { 'repo-wt/1': { 'limits.maxBoxSize': 'm8g.large', autoMerge: false } },
        said: [
          { keys: ['limits.maxBoxSize'], repo: 'repo-wt/1' },
          { keys: ['limits.maxBoxSize'], repo: 'repo-wt/1' },
        ],
      },
    ],
    [
      'a folder whose checkout is gone is looked up again at the next poll',
      [{ at: 'repo/src' }, { rm: 'repo/.git' }, 'poll'],
      { values: { 'repo/src': { 'limits.maxBoxSize': 'm8g.2xlarge' } }, said: [] },
    ],
  ])('%s', (_, steps, want) => {
    const s = start();

    run(steps, s);
    const values = Object.fromEntries(
      Object.entries(want.values ?? {}).map(([dir, keys]) => {
        const v: Record<string, unknown> = s.at(at(dir)).values;

        return [dir, Object.fromEntries(Object.keys(keys).map((k) => [k, v[k]]))];
      }),
    );

    const said: Said[] = events;

    expect({ values, said }).toEqual({
      values: want.values ?? {},
      said: want.said.map((e) => ({ ...e, repo: e.repo === null ? null : at(e.repo) })),
    });
  });
});

describe('the facts derived at a folder', () => {
  test.each<[string, Step[], string, Record<string, string> | undefined, Partial<CheckoutFacts>]>([
    [
      'none named: gh and az their own, no box profile, dev and test, not local',
      [],
      'repo',
      undefined,
      {
        githubAccount: null,
        azFolder: { from: 'none', dir: null },
        boxProfile: null,
        agentEnvs: ['dev', 'test'],
        localMode: undefined,
        yourCheckouts: [],
      },
    ],
    [
      'yours for this repo: its gh login, az folder, box profile and prod on for agents',
      [
        {
          write: 'repo/.abe/settings.local.yaml',
          text: 'logins.gh: me-work\nboard:\n  azureConfigDir: /az-shop\nbox:\n  profile: shop\nagents:\n  prod: true\n',
        },
      ],
      'repo/src',
      undefined,
      {
        githubAccount: 'me-work',
        azFolder: { from: 'checkout', dir: '/az-shop' },
        boxProfile: 'shop',
        agentEnvs: ['dev', 'test', 'prod'],
      },
    ],
    [
      "serve's own $AZURE_CONFIG_DIR over yours",
      [{ write: 'repo/.abe/settings.local.yaml', text: 'board:\n  azureConfigDir: /az-shop\n' }],
      'repo',
      { AZURE_CONFIG_DIR: '/az-serve' },
      { azFolder: { from: 'environment', dir: '/az-serve' } },
    ],
    [
      'your box profile on this Mac where the repo names none',
      [{ write: 'mine/settings.yaml', text: 'box:\n  profile: mine\n' }],
      'repo',
      undefined,
      { boxProfile: 'mine' },
    ],
    [
      'local mode: a card worktree counts as its checkout, and is one of your checkouts',
      [
        { write: 'mine/settings.yaml', text: 'localMode: [ROOT/repo]\n' },
        { checkout: 'repo-wt/1', of: 'repo' },
      ],
      'repo-wt/1',
      undefined,
      { localMode: 'ROOT/repo', yourCheckouts: ['ROOT/repo'] },
    ],
  ])('%s', (_, steps, dir, environment, want) => {
    const fixed = (steps: Step[]) =>
      steps.map((step) =>
        typeof step === 'object' && 'write' in step
          ? { ...step, text: step.text.replaceAll('ROOT', root) }
          : step,
      );

    run(fixed(steps));
    const facts: Record<string, unknown> = start(environment).facts(at(dir));

    const rooted = (v: unknown): unknown => {
      if (typeof v === 'string') return v.replaceAll('ROOT', root);

      return Array.isArray(v) ? v.map(rooted) : v;
    };

    expect(Object.fromEntries(Object.keys(want).map((k) => [k, facts[k]]))).toEqual(
      Object.fromEntries(Object.entries(want).map(([k, v]) => [k, rooted(v)])),
    );
  });
});

describe('what a lookup costs', () => {
  test('10 000 lookups in a checkout, the first after a poll included, well under 100 ms', () => {
    const s = start();
    const deep = join(root, 'repo', 'src', 'deep');

    mkdirSync(deep, { recursive: true });
    s.at(deep);
    s.poll();
    const t0 = performance.now();

    for (let i = 0; i < 10_000; i++) s.facts(deep);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
