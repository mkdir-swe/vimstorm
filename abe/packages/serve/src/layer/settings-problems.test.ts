/**
 * `abe settings problems` (#108) through the socket: the settings files' problems, the logins' and
 * the tools' checks, worst first, each with its where-line and way out.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { envelope, SettingGetData, SettingsProblemsData } from '@abe/core';
import {
  fakeLoginStore,
  fakeLoginTools,
  fakeProfileStore,
  type FakeProfileStore,
  fakeToolProbe,
  printed,
  scenario,
  type ServeScenario,
} from '@abe/testing';

const open: { s: ServeScenario; dirs: string[] }[] = [];
/** Folders a test made beside its serves. */
const loose: string[] = [];

afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.s.close();
    for (const d of o.dirs) rmSync(d, { recursive: true, force: true });
  }
  for (const d of loose.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ALL_TOOLS = {
  node: printed('v22.11.0'),
  tmux: printed('tmux 3.5a'),
  docker: printed('27.3.1'),
  az: printed('{"azure-cli": "2.67.0"}'),
  gh: printed('gh version 2.63.0'),
  claude: printed('2.1.310 (Claude Code)'),
  git: printed('git version 2.47.1'),
  rg: printed('ripgrep 14.1.1'),
  aws: printed('aws-cli/2.22.0'),
};

/** Why the merged `board` names no board, as `boardOf` says it. */
const NO_BOARD = 'no board in the settings: set board (organization, project and team) in abe.yaml';

/** No AWS profile or region on this Mac. */
const NO_AWS = { profile: null, region: null };

const BOARD = 'board:\n  organization: https://dev.azure.com/acme\n  project: Shop\n  team: Web\n';

/**
 * A serve whose request folder is a checkout (ADR 0030): the repo's `abe.yaml` (`repo`,
 * after the board unless `board` is false: #158's setup done), yours for it
 * (`.abe/settings.local.yaml`, written so no move runs) and yours on this Mac (`mine`).
 */
const world = async (o: {
  repo: string;
  local?: string;
  mine?: string;
  board?: false;
  node?: boolean;
  aws?: { profile: string | null; region: string | null };
  profiles?: FakeProfileStore;
}) => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const tools = fakeLoginTools(home);

  tools.set('github', true);
  tools.set('claude', true);
  const probe = fakeToolProbe(ALL_TOOLS);

  if (o.node === false) probe.set('node', { found: false });
  const aws = o.aws;
  const s = await scenario({
    toolProbe: probe,
    storedLogins: { secret: null, store: fakeLoginStore(), tools, home },
    ...(aws === undefined ? {} : { awsReach: () => aws }),
    ...(o.profiles === undefined ? {} : { browserProfiles: { store: o.profiles } }),
  });

  open.push({ s, dirs: [home] });
  mkdirSync(join(s.state.dir, '.git'));
  mkdirSync(join(s.state.dir, '.abe'));
  mkdirSync(join(s.state.dir, '.config', 'abe'), { recursive: true });
  writeFileSync(join(s.state.dir, 'abe.yaml'), `${o.board === false ? '' : BOARD}${o.repo}`);
  writeFileSync(join(s.state.dir, '.abe', 'settings.local.yaml'), o.local ?? '');
  writeFileSync(join(s.state.dir, '.config', 'abe', 'settings.yaml'), o.mine ?? '');

  return s;
};

const problems = async (s: ServeScenario) => {
  const reply = await s.request('settings', 'problems', '--json');
  const doc = envelope(SettingsProblemsData).parse(JSON.parse(reply.stdout));

  expect(reply.exit).toBe(0);
  if (!doc.ok) throw new Error(doc.error.message);

  return doc.data;
};

describe('abe settings problems', () => {
  test('a login gone, a tool missing, an Override with no reason, a dropped setting: worst first', async () => {
    const s = await world({
      repo: 'overrides:\n  autoMerge:\n    value: true\ngithubIdentity: ann\n',
      local: 'effort: high\n',
      node: false,
    });
    const data = await problems(s);
    const repo = basename(s.state.dir);

    expect(data.checked).toEqual({ logins: true, tools: true });
    expect(data.problems.map((p) => [p.kind, p.text, p.way])).toEqual([
      [
        'login',
        'Azure DevOps login missing — sign in',
        { kind: 'fix', command: 'az login --allow-no-subscriptions' },
      ],
      ['tool', "node not found on serve's PATH", { kind: 'fix', command: 'brew install node' }],
      // #159: the repo's file gives no check a command
      [
        'checks',
        `repo ${repo} has no checks: tests, types, lint have no command, so a Factory run checks nothing before review — give each a run: command under checks: in abe.yaml (abe settings check . prints one from its scripts)`,
        { kind: 'open', page: 'factory-policy', row: 'checks' },
      ],
      [
        'override-reason',
        `Override without a reason: auto merge overridden by repo ${repo} — add the reason or remove the override`,
        { kind: 'open', page: 'factory-policy', row: 'autoMerge' },
      ],
      [
        'dropped',
        `GitHub login in repo ${repo} is dropped: githubIdentity is yours alone: set it in .abe/settings.local.yaml (abe settings set githubIdentity <value> --mine)`,
        { kind: 'open', page: 'board-team', row: 'githubIdentity' },
      ],
    ]);
    expect(data.problems[2]?.where).toBe(`Factory policy › Checks · abe.yaml in ${repo}`);
    expect(data.problems[3]?.where).toBe(`Factory policy › Auto merge · abe.yaml in ${repo}`);
  });

  test('a target Abe does not know, a box cap raised plainly, a theme no one has (#166, #165, #172)', async () => {
    const s = await world({
      repo: 'checks:\n  - { name: tests, run: bun test }\n',
      local: 'limits:\n  maxBoxesPerPerson: 20\n',
      mine: 'serve:\n  target: locall\nui.theme: no-such-theme\n',
    });
    const data = await problems(s);
    const repo = basename(s.state.dir);

    expect(data.problems.filter((p) => p.kind === 'dropped').map((p) => [p.text, p.way])).toEqual([
      [
        'Commands run in yours names locall, read as local (a target Abe does not know never means cloud): Invalid option: expected one of "cloud"|"local"',
        { kind: 'open', page: 'tools', row: 'serve.target' },
      ],
      [
        `Max boxes per person in yours for ${repo} is dropped: limits.maxBoxesPerPerson raises the box cap over 3 without an Override; the built-in value stays in force`,
        { kind: 'open', page: 'boxes-cloud', row: 'limits.maxBoxesPerPerson' },
      ],
      [
        'Theme in yours names no theme no-such-theme, so Islands Dark is drawn; the themes: islands-dark, islands-light, dark-modern',
        { kind: 'fix', command: 'abe theme list' },
      ],
    ]);
    expect((await s.request('settings', 'get', 'serve.target', '--json')).stdout).toContain(
      '"value":"local"',
    );
  });

  test('a file of yours that does not read is shown where it is, yours on this Mac from ~', async () => {
    // A repo pack with a check: no checks problem.
    const s = await world({
      repo: 'checks:\n  - { name: tests, run: bun test }\n',
      local: 'effort: [\n',
      mine: 'ui.theme: [\n',
    });
    const data = await problems(s);

    expect(data.problems.map((p) => [p.kind, p.where])).toEqual([
      ['login', 'Logins & tools › Azure DevOps · az account get-access-token'],
      ['layer-file', 'Layers › ~/.config/abe/settings.yaml'],
      ['layer-file', `Layers › .abe/settings.local.yaml in ${basename(s.state.dir)}`],
    ]);
  });

  test('without the login and tool checks the settings and the setup are listed, and it says so', async () => {
    const s = await scenario();

    open.push({ s, dirs: [] });
    const data = await problems(s);

    // #158: a new config has no board: not "No problems".
    expect(data).toMatchObject({ checked: { logins: false, tools: false } });
    expect(data.problems.map((p) => p.code)).toEqual(['no-board']);
    expect((await s.request('settings', 'problems')).stdout).toBe(
      [
        `! no board for this repo: ${NO_BOARD}`,
        '    Board & you › Provider · abe.yaml',
        '    open: Abe › Board & you › board#provider',
        'No other problems (logins, tools not checked)',
        '',
      ].join('\n'),
    );
    expect(JSON.parse((await s.request('card', 'list', '--json')).stdout)).toEqual({
      ok: false,
      error: { code: 'no-board', message: NO_BOARD },
    });
  });

  test('#158: no board, a board provider without cards, no AWS', async () => {
    const setup = async (
      o: { board?: false; repo?: string; mine?: string },
      aws?: { profile: string | null; region: string | null },
    ) => {
      const s = await world({
        repo: `${o.repo ?? ''}checks:\n  - { name: tests, run: bun test }\n`,
        ...(o.board === undefined ? {} : { board: o.board }),
        ...(o.mine === undefined ? {} : { mine: o.mine }),
        ...(aws === undefined ? {} : { aws }),
      });
      const data = await problems(s);

      return data.problems.filter((p) => p.kind === 'setup').map((p) => [p.code, p.text]);
    };

    expect(await setup({ board: false })).toEqual([
      ['no-board', `no board for this repo: ${NO_BOARD}`],
    ]);
    // a provider settings know that has no cards in Abe yet says so
    expect(
      await setup({ board: false, repo: `board:\n  provider: jira\n${BOARD.slice(7)}` }),
    ).toEqual([
      ['no-board', 'no board for this repo: board.provider "jira": jira has no cards in Abe yet'],
    ]);
    // sessions on this Mac by default (ADR 0042): no AWS is no problem
    expect(await setup({}, NO_AWS)).toEqual([]);
    expect(
      await setup({ mine: 'serve.target: cloud\n' }, { profile: null, region: 'eu-north-1' }),
    ).toEqual([
      [
        'no-aws',
        "serve.target is cloud but there is no AWS profile, so boxes can't be reached — name the AWS profile of your boxes' account: abe settings set box.profile <profile> (and box.region), then abe serve stop so serve starts on it, or run locally",
      ],
    ]);
    expect(await setup({ mine: 'serve.target: local\n' }, NO_AWS)).toEqual([]);
    // a board On this machine launches here: no box is reached, so none is missing
    expect(await setup({ board: false, repo: 'board:\n  provider: local\n' }, NO_AWS)).toEqual([]);
  });

  test('local mode on: launches stay on this machine, serve.target reads local and says why', async () => {
    const s = await world({ repo: 'checks:\n  - { name: tests, run: bun test }\n', aws: NO_AWS });

    writeFileSync(
      join(s.state.dir, '.config', 'abe', 'settings.yaml'),
      `localMode:\n  - ${realpathSync(s.state.dir)}\n`,
    );
    expect((await problems(s)).problems.filter((p) => p.kind === 'setup')).toEqual([]);
    const got = envelope(SettingGetData).parse(
      JSON.parse((await s.request('settings', 'get', 'serve.target', '--json')).stdout),
    );

    expect(got.ok ? [got.data.value, got.data.lowered] : got).toEqual([
      'local',
      `local mode is on in ${realpathSync(s.state.dir)}: agents run on this machine only (abe local off to launch in your environment)`,
    ]);
  });

  test('a serve without its settings refuses list and problems', async () => {
    const s = await scenario({ noSettings: true });

    open.push({ s, dirs: [] });
    for (const verb of ['list', 'problems']) {
      const reply = await s.request('settings', verb, '--json');

      expect(reply.exit).toBe(1);
      expect(JSON.parse(reply.stdout)).toMatchObject({ ok: false, error: { code: 'no-settings' } });
    }
  });

  test('#345: browser.default naming no profile, and a profile opened here but never stored', async () => {
    const store = fakeProfileStore('ada', () => '2026-10-25T03:00:00.000Z');

    store.stored.set('shop-admin', { text: '{}', storedAt: '2026-10-20T08:00:00.000Z' });
    const s = await world({
      repo: 'checks:\n  - { name: tests, run: bun test }\n',
      mine: [
        'browser:',
        '  default: gone',
        '  profiles:',
        '    - { name: shop-admin, purpose: admin }',
        '    - { name: shop-buyer, purpose: buyer }',
        '    - { name: shop-guest, purpose: never opened here }',
        '',
      ].join('\n'),
      profiles: store,
    });

    for (const name of ['shop-admin', 'shop-buyer'])
      mkdirSync(join(s.state.dir, '.config', 'abe', 'chrome', name), { recursive: true });
    const data = await problems(s);

    expect(
      data.problems.filter((p) => p.kind === 'browser').map((p) => [p.code, p.where, p.way]),
    ).toEqual([
      [
        'browser-default-missing',
        'Browser profiles › Default profile',
        { kind: 'open', page: 'browser-profiles', row: 'browser.default' },
      ],
      [
        'browser-not-stored',
        'Browser profiles › Profiles · shop-buyer',
        { kind: 'fix', command: 'abe browser open shop-buyer' },
      ],
    ]);
  });
});
