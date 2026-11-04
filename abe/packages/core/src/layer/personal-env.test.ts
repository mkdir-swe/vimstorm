import { describe, expect, test } from 'bun:test';
import { coreDefaults } from './settings';
import {
  explainedWithEnvironment,
  fromEnvironment,
  PERSONAL_ENV,
  withPersonalEnv,
} from './personal-env';
import { settingExplainText } from './settings/text';
import { type SettingExplainData } from './settings/contract';

const values = {
  ...coreDefaults(),
  'box.profile': 'abe-tooling',
  'box.region': 'eu-west-1',
  'box.owner': 'ada',
  'stores.logs': 's3://abe-logs-1',
  'stores.org': 'file:///tmp/org',
  board: { azureConfigDir: '~/az-demo' },
};

describe('your environment from the Layers (#344, #100)', () => {
  test('a Dock launch (none of it in the env): every value from the Layers', () => {
    expect(withPersonalEnv({ HOME: '/home/me' }, values, '/home/me')).toEqual({
      HOME: '/home/me',
      AWS_PROFILE: 'abe-tooling',
      AWS_REGION: 'eu-west-1',
      ABE_OWNER: 'ada',
      ABE_LOG_STORE: 's3://abe-logs-1',
      ABE_ORG_STORE: 'file:///tmp/org',
      AZURE_CONFIG_DIR: '/home/me/az-demo',
    });
  });

  test.each([
    // your Layer's box profile beats a shell's (a work one there is never abe's)
    [{ AWS_PROFILE: 'work' }, { AWS_PROFILE: 'abe-tooling' }],
    [{ ABE_BOX_PROFILE: 'abe-play' }, { ABE_BOX_PROFILE: 'abe-play', AWS_PROFILE: 'abe-play' }],
    [{ ABE_BOX_PROFILE: 'abe-play', AWS_PROFILE: 'work' }, { AWS_PROFILE: 'abe-play' }],
    // the Layer's value never goes beside it under the other name
    [
      { AWS_DEFAULT_REGION: 'eu-north-1' },
      { AWS_DEFAULT_REGION: 'eu-north-1', AWS_REGION: undefined },
    ],
    [{ ABE_OWNER: 'octocat' }, { ABE_OWNER: 'octocat' }],
    [{ AZURE_CONFIG_DIR: '/tmp/az' }, { AZURE_CONFIG_DIR: '/tmp/az' }],
  ])('the environment over the Layer: %j', (env, expected) => {
    const out = withPersonalEnv(env, values, '/h');

    for (const [name, value] of Object.entries(expected)) expect(out[name]).toBe(value);
  });

  test("board's az folder given as your own Layer's: a team's never fills it", () => {
    expect(withPersonalEnv({}, values, '/h', null).AZURE_CONFIG_DIR).toBeUndefined();
    expect(withPersonalEnv({}, values, '/h', '/mine/az').AZURE_CONFIG_DIR).toBe('/mine/az');
  });

  test('an empty variable is none: the Layer fills it', () => {
    expect(withPersonalEnv({ AWS_PROFILE: '' }, values, '/h').AWS_PROFILE).toBe('abe-tooling');
  });

  test.each([[{ PATH: '/bin' }], [{ AWS_PROFILE: 'work' }]])(
    'nothing in the Layers: the env as it was (a shell profile stands): %j',
    (env) => {
      expect(withPersonalEnv(env, coreDefaults(), '/h')).toEqual(env);
    },
  );

  test('which variable sets a key, in the order it wins', () => {
    const env = { AWS_PROFILE: 'work', ABE_BOX_PROFILE: 'abe-play', AWS_DEFAULT_REGION: 'x-1' };

    expect(fromEnvironment('box.profile', env)).toEqual({
      name: 'ABE_BOX_PROFILE',
      value: 'abe-play',
    });
    expect(fromEnvironment('box.region', env)).toEqual({
      name: 'AWS_DEFAULT_REGION',
      value: 'x-1',
    });
    expect(fromEnvironment('box.owner', env)).toBeUndefined();
    // a shell's $AWS_PROFILE overrides no Layer
    expect(fromEnvironment('box.profile', { AWS_PROFILE: 'work' })).toBeUndefined();
    expect(PERSONAL_ENV.map((p) => p.key)).toEqual([
      'box.profile',
      'box.region',
      'box.owner',
      'stores.logs',
      'stores.org',
      'board.azureConfigDir',
    ]);
  });
});

describe('explain names the environment (#344)', () => {
  const explained = (key: string, value: SettingExplainData['value']): SettingExplainData => ({
    key,
    value,
    winner: 'individual',
    lowered: null,
    layers: [],
    feel: 'vimstorm',
    problems: [],
  });

  test.each([
    [
      'abe-tooling',
      { ABE_BOX_PROFILE: 'abe-play', AWS_PROFILE: 'work' },
      { name: 'ABE_BOX_PROFILE', value: 'abe-play' },
      'box.profile = abe-play  from environment ($ABE_BOX_PROFILE)\n  environment  abe-play  ($ABE_BOX_PROFILE overrides the Layers)\n',
    ],
    [
      null,
      { AWS_PROFILE: 'work' },
      { name: 'AWS_PROFILE', value: 'work', fallback: true },
      'box.profile = work  from environment ($AWS_PROFILE)\n  environment  work  ($AWS_PROFILE the Layers name none)\n',
    ],
  ])('the variable in force: its value, and it named (Layer %j)', (layer, env, named, text) => {
    const d = explainedWithEnvironment(explained('box.profile', layer), env);

    expect(d).toMatchObject({ value: named.value, environment: named });
    expect(settingExplainText(d)).toBe(text);
  });

  test("board's azureConfigDir: the field the variable sets", () => {
    const d = explainedWithEnvironment(explained('board', { project: 'DemoShop' }), {
      AZURE_CONFIG_DIR: '/tmp/az',
    });

    expect(d.value).toEqual({ project: 'DemoShop', azureConfigDir: '/tmp/az' });
    expect(settingExplainText(d)).toStartWith(
      'board = {"project":"DemoShop","azureConfigDir":"/tmp/az"}  from yours\n',
    );
  });

  test('none set, or a key no variable overrides: as the Layers say', () => {
    expect(explainedWithEnvironment(explained('box.profile', 'x'), {}).environment).toBeUndefined();
    // a shell's $AWS_PROFILE under a Layer's profile: the Layer's
    expect(
      explainedWithEnvironment(explained('box.profile', 'x'), { AWS_PROFILE: 'work' }).environment,
    ).toBeUndefined();
    expect(
      explainedWithEnvironment(explained('autoMerge', true), { AWS_PROFILE: 'w' }).environment,
    ).toBeUndefined();
  });
});
