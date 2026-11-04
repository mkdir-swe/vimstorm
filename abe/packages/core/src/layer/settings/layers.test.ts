/** Rule tables for the Layers and Overrides (ADR 0030): the merge as every reader of a setting sees it. */
import { describe, expect, test } from 'bun:test';
import {
  checkPlan,
  coreDefaults,
  dropEntry,
  githubAccountOf,
  individualFile,
  isWriteName,
  type LayerSource,
  localFile,
  mergeSettings,
  overrideReason,
  personalOverrides,
  placeOfFile,
  type Place,
  putEntry,
  readValue,
  repoFile,
  type SettingKey,
} from '../../index';

const REPO = '/r/abe.yaml';
const LOCAL = '/r/.abe/settings.local.yaml';
const MAC = '/me/settings.yaml';
/** The repo's `abe.yaml`. */
const repo = (doc: unknown): LayerSource => ({ place: 'repo', file: REPO, doc });
/** Yours for this repo: `.abe/settings.local.yaml`. */
const mine = (doc: unknown): LayerSource => ({ place: 'local', file: LOCAL, doc });
/** Yours on this Mac: `~/.config/abe/settings.yaml`. */
const mac = (doc: unknown): LayerSource => ({ place: 'machine', file: MAC, doc });
const because = (value: unknown, reason?: unknown) => ({ value, reason });

describe('the repo sets, yours adds to it', () => {
  test.each<[string, LayerSource[], SettingKey, unknown, string]>([
    ['core alone', [], 'autoMerge', false, 'core'],
    [
      'the repo sets a value',
      [repo({ 'factory.done': 'merged' })],
      'factory.done',
      'merged',
      'repo',
    ],
    [
      'yours wins a plain key over the repo',
      [repo({ 'box.size': 'm8g.large' }), mine({ box: { size: 'm8g.2xlarge' } })],
      'box.size',
      'm8g.2xlarge',
      'individual',
    ],
    [
      'checks: the repo pack gives core checks their commands and adds its own; yours adds',
      [
        repo({
          checks: [
            { name: 'tests', run: 'bun test' },
            { name: 'e2e', run: 'bun run e2e' },
          ],
        }),
        mine({ checks: ['audit'] }),
      ],
      'checks',
      [
        { name: 'tests', run: 'bun test' },
        'types',
        'lint',
        'no-deleted-tests',
        'no-new-suppressions',
        { name: 'e2e', run: 'bun run e2e' },
        'audit',
      ],
      'individual',
    ],
    [
      'testFiles: each file adds patterns',
      [repo({ testFiles: ['e2e/'] }), mine({ testFiles: ['spec/'] })],
      'testFiles',
      ['*.test.*', '*.spec.*', 'test/', 'tests/', 'e2e/', 'spec/'],
      'individual',
    ],
    [
      'reach: reads add freely',
      [repo({ reach: ['ABE_AWS_READ_TEST'] }), mine({ reach: ['ABE_AWS_READ_PROD'] })],
      'reach',
      ['ABE_AWS_READ_TEST', 'ABE_AWS_READ_PROD'],
      'individual',
    ],
    [
      "board: the repo's, your az folder beside it",
      [
        repo({ board: { provider: 'azure', project: 'P' } }),
        mine({ board: { azureConfigDir: '/az' } }),
      ],
      'board',
      { provider: 'azure', project: 'P', azureConfigDir: '/az' },
      'individual',
    ],
    [
      'the repo sets allowedModels freely: it is the top file',
      [repo({ allowedModels: ['sonnet'] })],
      'allowedModels',
      ['sonnet'],
      'repo',
    ],
    [
      'an editor preference: yours on this machine',
      [mac({ ui: { theme: 'islands-light' } })],
      'ui.theme',
      'islands-light',
      'individual',
    ],
    [
      'box.profile: yours for this repo over yours on this machine',
      [mac({ box: { profile: 'home' } }), mine({ 'box.profile': 'work' })],
      'box.profile',
      'work',
      'individual',
    ],
    [
      "browser profiles: yours on this machine add to the repo's",
      [repo({ browser: { default: 'qa' } }), mac({ 'browser.default': 'me' })],
      'browser.default',
      'me',
      'individual',
    ],
  ])('%s', (_, sources, key, value, winner) => {
    const merged = mergeSettings(sources);

    expect(merged.values).toHaveProperty([key], value);
    expect(merged.explain(key)).toMatchObject({ value, winner, lowered: null, problems: [] });
    expect(merged.problems).toEqual([]);
  });

  test('every key starts at core', () => {
    expect(mergeSettings([]).values).toEqual(coreDefaults());
  });

  test('explain lists only the files a key is read from, top first', () => {
    const merged = mergeSettings([repo({ autoMerge: false }), mac({}), mine(undefined)]);

    expect(merged.explain('autoMerge').layers.map((l) => [l.layer, l.file])).toEqual([
      ['core', null],
      ['repo', REPO],
      ['individual', LOCAL],
    ]);
    expect(merged.explain('ui.theme').layers.map((l) => [l.layer, l.file])).toEqual([
      ['core', null],
      ['individual', MAC],
    ]);
  });
});

describe('where each setting is read from (ADR 0030)', () => {
  test.each<[string, SettingKey, unknown]>([
    ['a model', 'models.coordinator', 'haiku'],
    ['checks', 'checks', ['audit']],
    ['the board', 'board', { project: 'P' }],
    ['a GitHub login', 'logins.gh', 'me'],
    ['prod for agents', 'agents.prod', true],
  ])('%s in yours on this machine: not read, no problem', (_, key, value) => {
    const merged = mergeSettings([mac({ [key]: value })]);

    expect(merged.values[key]).toEqual(coreDefaults()[key]);
    expect(merged.problems).toEqual([]);
  });

  test.each<[string, Place, unknown, string, string]>([
    ['the theme in the repo', 'repo', { ui: { theme: 'x' } }, 'not-in-repo', 'ui.theme'],
    ['the Feel in yours for the repo', 'local', { ui: { feel: 'vim' } }, 'not-in-repo', 'ui.feel'],
    ['a log store in the repo', 'repo', { 'stores.logs': 's3://b' }, 'not-in-repo', 'stores.logs'],
    [
      'a box region in the repo',
      'repo',
      { box: { region: 'eu-west-1' } },
      'not-in-repo',
      'box.region',
    ],
    ['a box profile in the repo', 'repo', { box: { profile: 'p' } }, 'not-in-repo', 'box.profile'],
    ['a GitHub login in the repo', 'repo', { 'logins.gh': 'me' }, 'personal-only', 'logins.gh'],
    [
      'credentials in the repo',
      'repo',
      { credentials: { local: { envFile: '.env' } } },
      'personal-only',
      'credentials',
    ],
    ['the TEST yes in the repo', 'repo', { testWrites: true }, 'personal-only', 'testWrites'],
    ['a source in yours for the repo', 'local', { sources: ['sentry'] }, 'team-only', 'sources'],
    [
      'an az folder in the repo',
      'repo',
      { board: { azureConfigDir: '/az' } },
      'personal-only',
      'board',
    ],
  ])('%s: refused, saying why', (_, place, doc, code, key) => {
    const file = place === 'repo' ? REPO : LOCAL;
    const merged = mergeSettings([{ place, file, doc }]);

    expect(merged.problems).toMatchObject([{ code, key, file }]);
    expect(merged.values).toEqual(coreDefaults());
  });
});

describe('an environment on for agents is yours alone, for this repo (ADR 0029)', () => {
  test('by default dev and test on, prod off', () => {
    const v = mergeSettings([]).values;

    expect([v['agents.dev'], v['agents.test'], v['agents.prod']]).toEqual([true, true, false]);
  });

  test.each<[string, LayerSource]>([
    ['plainly', repo({ agents: { prod: true } })],
    ['by Override', repo({ overrides: { 'agents.prod': because(true, 'hotfix') } })],
  ])("the repo's file turning prod on %s: refused, and why", (_, source) => {
    const merged = mergeSettings([source]);

    expect(merged.values['agents.prod']).toBe(false);
    expect(merged.problems.map((p) => [p.code, p.layer])).toEqual([['personal-only', 'repo']]);
    expect(merged.problems[0]?.message).toContain(
      "only you turn prod on or off for this repo's agents, in .abe/settings.local.yaml",
    );
  });

  test('yours for this repo: on', () => {
    const merged = mergeSettings([repo({}), mine({ agents: { prod: true } })]);

    expect([merged.values['agents.prod'], merged.problems]).toEqual([true, []]);
  });
});

describe('an Override lowers the value above and is shown as lowered', () => {
  test.each<[string, LayerSource[], SettingKey, unknown, string]>([
    [
      'allowedModels narrowed by the repo',
      [repo({ overrides: { allowedModels: because(['haiku'], ' cost ') } })],
      'allowedModels',
      ['haiku'],
      'overridden by repo: cost',
    ],
    [
      'a check removed by the repo',
      [repo({ overrides: { checks: because(['tests', 'types'], 'no linter yet') } })],
      'checks',
      ['tests', 'types'],
      'overridden by repo: no linter yet',
    ],
    [
      'a write name granted by the repo, your reads added',
      [
        repo({ overrides: { reach: because(['ABE_AWS_WRITE_TEST'], 'migrations') } }),
        mine({ reach: ['ABE_AWS_READ_TEST'] }),
      ],
      'reach',
      ['ABE_AWS_WRITE_TEST', 'ABE_AWS_READ_TEST'],
      'overridden by repo: migrations',
    ],
    [
      'yours tightening: auto merge off under a repo that has it on',
      [repo({ autoMerge: true }), mine({ overrides: { autoMerge: because(false, 'I review') } })],
      'autoMerge',
      false,
      'overridden by individual: I review',
    ],
  ])('%s', (_, sources, key, value, lowered) => {
    const merged = mergeSettings(sources);
    const explained = merged.explain(key);

    expect(merged.values).toHaveProperty([key], value);
    expect(explained.lowered).toBe(lowered);
    expect(explained.problems).toEqual([]);
  });
});

describe("yours changing what the repo guards takes an Override; the repo's value stays", () => {
  test.each<[string, LayerSource[], SettingKey, unknown]>([
    ['autoMerge on', [mine({ autoMerge: true })], 'autoMerge', false],
    [
      'allowedModels changed',
      [repo({ allowedModels: ['opus', 'sonnet'] }), mine({ allowedModels: ['haiku'] })],
      'allowedModels',
      ['opus', 'sonnet'],
    ],
    [
      "a check's command changed",
      [
        repo({ checks: [{ name: 'audit', run: 'npm audit' }] }),
        mine({ checks: [{ name: 'audit', run: 'true' }] }),
      ],
      'checks',
      [...coreDefaults().checks, { name: 'audit', run: 'npm audit' }],
    ],
    [
      'the box cap raised',
      [repo({ limits: { maxBoxesPerPerson: 2 } }), mine({ limits: { maxBoxesPerPerson: 20 } })],
      'limits.maxBoxesPerPerson',
      2,
    ],
    [
      "the repo's abe-only MCP loosened",
      [repo({ session: { mcp: 'abe-only' } }), mine({ session: { mcp: 'yours' } })],
      'session.mcp',
      'abe-only',
    ],
  ])('%s', (_, sources, key, value) => {
    const merged = mergeSettings(sources);

    expect(merged.values).toHaveProperty([key], value);
    expect(merged.problems.map((p) => [p.code, p.layer, p.file])).toEqual([
      ['override-required', 'individual', LOCAL],
    ]);
  });

  test('the message names the file, the key and whose value stays', () => {
    const merged = mergeSettings([repo({ autoMerge: false }), mine({ autoMerge: true })]);

    expect(merged.problems[0]?.message).toBe(
      `${LOCAL}: autoMerge changes the value above without an Override; the repo value stays in force`,
    );
  });

  test('yours lowering a guarded value plainly is free', () => {
    const merged = mergeSettings([
      repo({ limits: { maxBoxesPerPerson: 3 } }),
      mine({ limits: { maxBoxesPerPerson: 1 } }),
    ]);

    expect([merged.values['limits.maxBoxesPerPerson'], merged.problems]).toEqual([1, []]);
  });
});

describe('an Override without a reason is refused and never applies', () => {
  test.each([
    ['no reason', because(true)],
    ['an empty reason', because(true, '')],
    ['a blank reason', because(true, '   ')],
    ['a reason that is not text', because(true, 3)],
  ])('%s', (_, entry) => {
    const merged = mergeSettings([repo({ overrides: { autoMerge: entry } })]);

    expect(merged.values.autoMerge).toBe(false);
    expect(merged.problems).toEqual([
      {
        code: 'reason-required',
        layer: 'repo',
        file: REPO,
        key: 'autoMerge',
        message: 'an Override of autoMerge needs a non-empty reason',
      },
    ]);
  });

  test.each<[unknown, string | undefined]>([
    ['  why ', 'why'],
    ['', undefined],
    [undefined, undefined],
    [1, undefined],
  ])('overrideReason(%p) is %p', (reason, read) => {
    expect(overrideReason(reason)).toBe(read);
  });
});

describe('write names: the repo grants one by Override, yours never, prod never', () => {
  test.each([
    ['ABE_AWS_WRITE_PROD', true],
    ['ABE_DB_WRITE_URL_TEST', true],
    ['ABE_AWS_READ_PROD', false],
    ['ABE_REWRITE', false],
  ])('%s is a write name: %p', (name, write) => {
    expect(isWriteName(name)).toBe(write);
  });

  test("the repo's plain write name takes an Override", () => {
    const merged = mergeSettings([repo({ reach: ['ABE_AWS_WRITE_TEST'] })]);

    expect([merged.values.reach, merged.problems.map((p) => p.code)]).toEqual([
      [],
      ['override-required'],
    ]);
  });

  test.each<[string, LayerSource]>([
    ['plainly', mine({ reach: ['ABE_AWS_WRITE_TEST'] })],
    ['by Override', mine({ overrides: { reach: because(['ABE_AWS_WRITE_TEST'], 'my box') } })],
  ])('yours granting a write %s: refused, no Override would do', (_, source) => {
    const merged = mergeSettings([repo({ reach: ['ABE_AWS_READ_PROD'] }), source]);

    expect(merged.values.reach).toEqual(['ABE_AWS_READ_PROD']);
    expect(merged.problems.map((p) => [p.code, p.layer])).toEqual([
      ['write-below-repo', 'individual'],
    ]);
  });

  test.each<[string, LayerSource[]]>([
    ['the repo, plainly', [repo({ reach: ['ABE_AWS_WRITE_PROD'] })]],
    [
      'the repo, by Override',
      [repo({ overrides: { reach: because(['ABE_DB_WRITE_URL_PROD'], 'ops') } })],
    ],
    [
      'yours, by Override',
      [mine({ overrides: { reach: because(['ABE_AWS_WRITE_LIVE'], 'mine') } })],
    ],
  ])('a write to prod by %s: refused, and why', (_, sources) => {
    const merged = mergeSettings(sources);

    expect(merged.values.reach.filter((n) => n.includes('WRITE'))).toEqual([]);
    expect(merged.problems.map((p) => p.code)).toEqual(['prod-off']);
    expect(merged.problems[0]?.message).toContain(
      'agents reach prod only when you turn it on for this repo',
    );
  });
});

describe('what else a settings file may get wrong', () => {
  test.each<[string, unknown, string, string | null]>([
    ['an unknown key', { colour: 'red' }, 'unknown-setting', 'colour'],
    ['an unknown nested key', { limits: { port: 1 } }, 'unknown-setting', 'limits.port'],
    ['a wrong type', { autoMerge: 'yes' }, 'invalid-setting', 'autoMerge'],
    ['a word no board has', { board: { provider: 'trello' } }, 'invalid-setting', 'board'],
    [
      'an Override that is no { value, reason }',
      { overrides: { autoMerge: true } },
      'invalid-override',
      'autoMerge',
    ],
    ['not a map', ['a'], 'bad-layer-file', null],
  ])('%s', (_, doc, code, key) => {
    const merged = mergeSettings([repo(doc)]);

    expect(merged.problems).toMatchObject([{ code, key, layer: 'repo', file: REPO }]);
    expect(merged.values).toEqual(coreDefaults());
  });

  test('a file that does not parse is named, and the rest still merge', () => {
    const merged = mergeSettings([
      { place: 'repo', file: REPO, error: 'bad indentation' },
      mine({ 'factory.done': 'merged' }),
    ]);

    expect(merged.values['factory.done']).toBe('merged');
    expect(merged.problems).toMatchObject([
      { code: 'bad-layer-file', key: null, message: 'bad indentation' },
    ]);
  });

  test('a key written both dotted and nested is a duplicate, the last one used', () => {
    const merged = mergeSettings([repo({ 'box.size': 'm8g.large', box: { size: 'm8g.xlarge' } })]);

    expect(merged.values['box.size']).toBe('m8g.xlarge');
    expect(merged.problems).toMatchObject([{ code: 'duplicate-setting', key: 'box.size' }]);
  });

  test("where cards run is the repo's: abe.yaml over yours on this Mac, yours for the repo over both (3.2.2)", () => {
    const target = (...sources: LayerSource[]) => {
      const merged = mergeSettings(sources);

      return [
        merged.values['serve.target'],
        merged.explain('serve.target').winner,
        merged.problems,
      ];
    };

    expect(target(mac({ serve: { target: 'local' } }))).toEqual(['local', 'individual', []]);
    expect(
      target(repo({ serve: { target: 'local' } }), mac({ serve: { target: 'cloud' } })),
    ).toEqual(['local', 'repo', []]);
    expect(
      target(
        repo({ serve: { target: 'local' } }),
        mac({ serve: { target: 'local' } }),
        mine({ serve: { target: 'cloud' } }),
      ),
    ).toEqual(['cloud', 'individual', []]);
  });

  test('a target Abe does not know is this Mac, never cloud (#166)', () => {
    const merged = mergeSettings([mac({ serve: { target: 'locall' } })]);

    expect(merged.values['serve.target']).toBe('local');
    expect(merged.problems[0]?.message).toContain(
      ', read as local (a target Abe does not know never means cloud)',
    );
  });
});

describe('every setting takes a personal Override, with its reason and since when (#168)', () => {
  test.each<[string, LayerSource[], SettingKey, unknown]>([
    [
      'auto merge switched on',
      [mine({ overrides: { autoMerge: because(true, 'me') } })],
      'autoMerge',
      true,
    ],
    [
      'a model the repo took out put back',
      [
        repo({ allowedModels: ['opus'] }),
        mine({ overrides: { allowedModels: because(['opus', 'haiku'], 'cheap') } }),
      ],
      'allowedModels',
      ['opus', 'haiku'],
    ],
    [
      'more boxes than the repo allows',
      [
        repo({ limits: { maxBoxesPerPerson: 2 } }),
        mine({ overrides: { 'limits.maxBoxesPerPerson': because(20, 'many') } }),
      ],
      'limits.maxBoxesPerPerson',
      20,
    ],
    [
      'the Feel by Override on this machine',
      [mac({ overrides: { 'ui.feel': because('vim', 'habit') } })],
      'ui.feel',
      'vim',
    ],
  ])('%s: applied, yours, shown as overridden by you', (_, sources, key, value) => {
    const merged = mergeSettings(sources);

    expect(merged.values).toHaveProperty([key], value);
    expect(merged.problems).toEqual([]);
    expect(merged.explain(key).winner).toBe('individual');
    expect(merged.explain(key).lowered).toStartWith('overridden by individual: ');
  });

  test('since when is kept; your Overrides list key, value, reason, since', () => {
    const merged = mergeSettings([
      repo({ overrides: { 'box.idleMinutes': because(60, 'repo') } }),
      mine({
        overrides: {
          autoMerge: { value: true, reason: 'my sandbox', since: '2026-10-24T09:30:00.000Z' },
          checks: because(['tests'], 'spike'),
        },
      }),
    ]);

    expect(merged.explain('autoMerge').lowered).toBe(
      'overridden by individual: my sandbox · since 2026-10-24',
    );
    expect(personalOverrides(merged)).toEqual([
      {
        key: 'autoMerge',
        value: true,
        shown: 'on',
        reason: 'my sandbox',
        since: '2026-10-24T09:30:00.000Z',
      },
      { key: 'checks', value: ['tests'], shown: 'tests', reason: 'spike', since: null },
    ]);
  });
});

describe('where the files are, and what check reads', () => {
  test.each<[string, Place]>([
    ['/r/abe.yaml', 'repo'],
    ['/r/.abe/settings.local.yaml', 'local'],
    ['/me/settings.yaml', 'machine'],
  ])('%s is %s', (file, place) => {
    expect(placeOfFile(file)).toBe(place);
  });

  test('the layout', () => {
    expect([repoFile('/r'), localFile('/r/'), individualFile('/me')]).toEqual([
      '/r/abe.yaml',
      '/r/.abe/settings.local.yaml',
      '/me/settings.yaml',
    ]);
  });

  test('a checkout: each file alone, as its place says', () => {
    expect(checkPlan({ top: undefined, repo: REPO, local: LOCAL })).toEqual([
      { file: REPO, place: 'repo' },
      { file: LOCAL, place: 'local' },
    ]);
  });
});

describe('abe settings set: the value typed and the file written', () => {
  test.each<[SettingKey, string, unknown, unknown]>([
    ['autoMerge', 'true', true, true],
    ['limits.maxBoxesPerPerson', '2', 2, 2],
    ['checks', '[e2e]', ['e2e'], ['e2e']],
    ['logins.gh', '123', 123, '123'],
  ])('%s %s', (key, typed, parsed, value) => {
    expect(readValue(key, parsed, typed)).toEqual({ ok: true, value });
  });

  test('a value the key does not take is refused', () => {
    expect(readValue('autoMerge', 'maybe', 'maybe')).toMatchObject({ ok: false });
  });

  test('a plain entry goes in nested, replacing an Override of the key; the rest is kept', () => {
    const doc = { team: 'web', overrides: { 'serve.target': because('x', 'y') }, serve: { a: 1 } };

    expect(putEntry(doc, 'serve.target', { kind: 'plain', value: 'cloud' })).toEqual({
      team: 'web',
      serve: { a: 1, target: 'cloud' },
    });
  });

  test('an Override goes under overrides, replacing a plain entry of the key', () => {
    expect(
      putEntry({ autoMerge: true, checks: ['a'] }, 'autoMerge', {
        kind: 'override',
        value: true,
        reason: 'demo',
      }),
    ).toEqual({ checks: ['a'], overrides: { autoMerge: { value: true, reason: 'demo' } } });
  });

  test.each<[string, Record<string, unknown>, SettingKey, Record<string, unknown>]>([
    ['a plain entry', { boardReadOnly: [], team: 'web' }, 'boardReadOnly', { team: 'web' }],
    [
      'an Override of it, and the overrides key with the last one',
      { overrides: { boardReadOnly: { value: [], reason: 'x' } } },
      'boardReadOnly',
      {},
    ],
    [
      'a dotted entry',
      { 'serve.target': 'a', autoMerge: true },
      'serve.target',
      { autoMerge: true },
    ],
  ])('dropEntry takes %s out, the rest kept', (_, doc, key, left) => {
    expect(dropEntry(doc, key)).toEqual(left);
  });

  test('a dotted entry is replaced too', () => {
    expect(
      putEntry({ 'serve.target': 'a' }, 'serve.target', { kind: 'plain', value: 'b' }),
    ).toEqual({ serve: { target: 'b' } });
  });
});

describe("sources: the team's MCP servers, in the repo's file (ADR 0031)", () => {
  const SENTRY = { name: 'sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp' } as const;

  test('read from the repo: each definition, a bare name as it is', () => {
    expect(mergeSettings([repo({ sources: [SENTRY, 'figma'] })]).values.sources).toEqual([
      SENTRY,
      'figma',
    ]);
  });

  test('a literal header refused, saying why: none of the list read', () => {
    const merged = mergeSettings([
      repo({ sources: [{ ...SENTRY, headers: { Authorization: 'Bearer abc' } }] }),
    ]);

    expect(merged.values.sources).toEqual([]);
    expect(merged.problems).toMatchObject([{ code: 'invalid-setting', key: 'sources' }]);
    expect(merged.problems[0]?.message).toContain(
      "header Authorization holds a value: abe.yaml is the team's and never holds a secret",
    );
    expect(merged.problems[0]?.message).not.toContain('abc');
  });

  test("yours for the repo: refused as the team's, the repo's kept", () => {
    const merged = mergeSettings([repo({ sources: [SENTRY] }), mine({ sources: ['figma'] })]);

    expect(merged.values.sources).toEqual([SENTRY]);
    expect(merged.problems).toMatchObject([{ code: 'team-only', key: 'sources' }]);
  });
});

describe('yours for the repo: logins: { gh, az }, your account names (ADR 0031)', () => {
  test('read as logins.gh and logins.az; the repo keeps its list', () => {
    const merged = mergeSettings([
      repo({ logins: ['gh', 'az'] }),
      mine({ logins: { gh: 'ann-acme', az: 'ann@acme.test' } }),
    ]);

    expect(merged.problems).toEqual([]);
    expect([merged.values.logins, merged.values['logins.gh'], merged.values['logins.az']]).toEqual([
      ['gh', 'az'],
      'ann-acme',
      'ann@acme.test',
    ]);
    expect(githubAccountOf(merged.values)).toBe('ann-acme');
  });
});
