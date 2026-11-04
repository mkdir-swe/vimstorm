/**
 * Your environment from the Layers (#344, #100), at the CLI seam: the real `abe` and its `serve`
 * started as VimStorm from the Dock starts it, with `env -i`'s bare environment (a `HOME`, a state
 * folder, a `PATH` with a fake `aws`) and your Layer naming the box profile, region and owner.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoxListData, SettingExplainData } from '@abe/core';
import { cli, type Cli, fakeAdo, fakeAws, type FakeAws, fakeAz, fakeLoginClis } from '@abe/testing';

const instances = {
  Reservations: [
    {
      Instances: [
        {
          InstanceId: 'i-0fa4e0000000000c1',
          InstanceType: 'm8g.xlarge',
          State: { Name: 'stopped' },
          Placement: { AvailabilityZone: 'eu-west-1a' },
          Tags: [
            { Key: 'abe:box', Value: 'demo-shop' },
            { Key: 'abe:owner', Value: 'ada' },
            { Key: 'abe:repo', Value: 'mkdir-swe/demo-shop' },
          ],
        },
      ],
    },
  ],
};

let abe: Cli | undefined;
let aws: FakeAws | undefined;

afterEach(async () => {
  await abe?.close();
  aws?.remove();
  abe = undefined;
  aws = undefined;
});

/**
 * A CLI on a bare environment whose own Layer (its config folder's settings.yaml) is `layer`; with
 * `mine`, it is typed in a checkout (its state folder) whose yours for this repo is `mine`, where
 * `board` and `board.azureConfigDir` are read (ADR 0030).
 */
const dockLaunched = (layer: string, more: Record<string, string> = {}, mine?: string) => {
  aws = fakeAws([['describe-instances', { json: instances }]]);
  const made = cli({ env: { PATH: aws.path, ...more } });
  const config = join(made.state.dir, 'config');

  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'settings.yaml'), layer);
  if (mine !== undefined) {
    mkdirSync(join(made.state.dir, '.git'));
    mkdirSync(join(made.state.dir, '.abe'));
    writeFileSync(join(made.state.dir, '.abe', 'settings.local.yaml'), mine);
  }
  abe = made;

  return { abe: made, aws, config };
};

/**
 * `az` in `dir` behind a front that writes down the `$AZURE_CONFIG_DIR` each call got: its PATH,
 * and the folders seen so far (only the calls whose arguments start with `first`, when given).
 */
const azSeen = (dir: string) => {
  const seen = join(dir, 'seen');
  const front = join(dir, 'front');

  mkdirSync(front);
  writeFileSync(
    join(front, 'az'),
    `#!/bin/sh\nprintf '%s\\t%s\\n' "$AZURE_CONFIG_DIR" "$1" >> '${seen}'\nexec '${dir}/az' "$@"\n`,
    { mode: 0o755 },
  );

  const dirs = (first?: string) =>
    readFileSync(seen, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split('\t'))
      .filter(([, arg]) => first === undefined || arg === first)
      .map(([d]) => d ?? '');

  return { front, dirs };
};

const LAYER = [
  'serve:',
  '  target: cloud',
  'box:',
  '  profile: abe-tooling',
  '  region: eu-west-1',
  '  owner: ada',
  '',
].join('\n');

describe('a serve with only the Layers (VimStorm from the Dock)', () => {
  test('lists your boxes: the profile, region and owner from your Layer, no gh asked', async () => {
    const at = dockLaunched(LAYER);
    const listed = await at.abe.jsonWith(
      { env: { ABE_CONFIG_DIR: at.config } },
      BoxListData,
      'box',
      'list',
    );

    expect(listed.doc).toMatchObject({
      ok: true,
      data: { boxes: [{ name: 'demo-shop', size: 'm8g.xlarge' }] },
    });
    const [call] = at.aws.calls();

    expect(call?.env.AWS_PROFILE).toBe('abe-tooling');
    expect(call?.argv).toContain('--region');
    expect(call?.argv[call.argv.indexOf('--region') + 1]).toBe('eu-west-1');
    expect(call?.argv).toContain('Name=tag:abe:owner,Values=ada');
  }, 20_000);

  test('explain names the environment where it overrides a Layer', async () => {
    const at = dockLaunched(LAYER, { ABE_BOX_PROFILE: 'abe-play', AWS_PROFILE: 'work' });
    const text = await at.abe.runWith(
      { env: { ABE_CONFIG_DIR: at.config } },
      'settings',
      'explain',
      'box.profile',
    );

    expect(text.stdout).toStartWith(
      'box.profile = abe-play  from environment ($ABE_BOX_PROFILE)\n',
    );
    expect(text.stdout).toContain(
      '  environment  abe-play  ($ABE_BOX_PROFILE overrides the Layers)\n',
    );
    const json = await at.abe.jsonWith(
      { env: { ABE_CONFIG_DIR: at.config } },
      SettingExplainData,
      'settings',
      'explain',
      'box.region',
    );

    // the Layer's own: no variable sets it
    expect(json.doc).toMatchObject({
      ok: true,
      data: { value: 'eu-west-1', winner: 'individual' },
    });
    expect(json.doc.ok && json.doc.data.environment).toBeUndefined();
  }, 20_000);

  test("the aws call itself: the region's variable wins, a shell's AWS_PROFILE not; settings set says when it applies", async () => {
    const at = dockLaunched(LAYER, { AWS_PROFILE: 'work', AWS_REGION: 'eu-north-1' });
    const env = { env: { ABE_CONFIG_DIR: at.config } };

    expect((await at.abe.runWith(env, 'box', 'list')).exit).toBe(0);
    const [call] = at.aws.calls();

    expect(call?.env.AWS_PROFILE).toBe('abe-tooling');
    expect(call?.argv[call.argv.indexOf('--region') + 1]).toBe('eu-north-1');
    const set = await at.abe.runWith(env, 'settings', 'set', 'box.region', 'eu-west-2');

    expect(set.stdout).toContain(
      'your environment: abe serve reads it as it starts · abe serve stop applies it now\n',
    );
  }, 20_000);

  test('serve.target local with a Layer naming the box profile: your boxes are still read', async () => {
    const at = dockLaunched(LAYER.replace('target: cloud', 'target: local'));
    const listed = await at.abe.jsonWith(
      { env: { ABE_CONFIG_DIR: at.config } },
      BoxListData,
      'box',
      'list',
    );

    expect(listed.doc).toMatchObject({ ok: true, data: { boxes: [{ name: 'demo-shop' }] } });
  }, 20_000);

  test('serve.target local and no box profile: boxes are off, EC2 never asked', async () => {
    const at = dockLaunched('serve:\n  target: local\n');
    const env = { env: { ABE_CONFIG_DIR: at.config } };
    const listed = await at.abe.runWith(env, 'box', 'list');

    expect(listed.exit).not.toBe(0);
    expect(listed.stderr).toContain('boxes are off: serve.target is local');
    expect((await at.abe.runWith(env, 'session', 'list')).stderr).not.toContain('region');
    expect(at.aws.calls()).toEqual([]);
  }, 20_000);

  test("the board's az folder from your Layer: serve's az reads the board with it", async () => {
    const ado = await fakeAdo();
    const az = fakeAz({ tokens: ['token-one'] });
    const seen = azSeen(az.dir);

    try {
      const board = { ...ado.board, azureConfigDir: '~/az-mine' };
      const at = dockLaunched('', ado.env, `board: ${JSON.stringify(board)}\n`);
      const listed = await at.abe.runWith(
        { env: { ABE_CONFIG_DIR: at.config, PATH: `${seen.front}:${az.path}` } },
        'card',
        'list',
      );

      expect(listed.exit).toBe(0);
      // `~` under serve's HOME, never the default az folder
      const [dir] = seen.dirs();

      expect(dir).toEndWith('/az-mine');
      expect(dir).not.toStartWith('~');
    } finally {
      await ado.stop();
      az.remove();
    }
  }, 20_000);

  test("abe login az: your Layer's az folder, kept from there, unless $AZURE_CONFIG_DIR names one", async () => {
    const clis = fakeLoginClis();
    const seen = azSeen(clis.dir);
    const store = mkdtempSync(join(tmpdir(), 'secrets-'));
    const given = mkdtempSync(join(tmpdir(), 'az-given-'));

    try {
      const at = dockLaunched(
        '',
        { ABE_LOGINS_SECRET: 'abe/octo/logins', ABE_LOGINS_STORE: `file://${store}` },
        'board:\n  azureConfigDir: ~/az-mine\n',
      );
      const env = { ABE_CONFIG_DIR: at.config, PATH: `${seen.front}:${clis.path}` };
      const home = at.abe.state.dir;

      expect((await at.abe.runWith({ env }, 'login', 'az')).stdout).toContain(
        'your az login is stored in abe/octo/logins',
      );
      // stored from the folder az wrote: az's default `~/.azure` never made
      expect(readFileSync(join(store, 'abe/octo/logins'), 'utf8')).toContain(
        '.azure/msal_token_cache.json',
      );
      expect(existsSync(join(home, '.azure'))).toBe(false);
      await at.abe.runWith({ env: { ...env, AZURE_CONFIG_DIR: given } }, 'login', 'az');

      expect(seen.dirs('login')).toEqual([join(home, 'az-mine'), given]);
    } finally {
      clis.remove();
      rmSync(store, { recursive: true, force: true });
      rmSync(given, { recursive: true, force: true });
    }
  }, 20_000);

  test("abe login az on the Mac: your secret looked up on the Layer's box profile and region", async () => {
    const at = dockLaunched(LAYER);

    // your boxes' profile is in your aws config: this Mac has boxes
    mkdirSync(join(at.abe.state.dir, '.aws'), { recursive: true });
    writeFileSync(join(at.abe.state.dir, '.aws', 'config'), '[profile abe-tooling]\n');
    const out = await at.abe.runWith({ env: { ABE_CONFIG_DIR: at.config } }, 'login', 'az');
    const lookups = at.aws.calls().filter((c) => c.argv.includes('secretsmanager'));

    expect(out.exit).not.toBe(0);
    expect(lookups.length).toBeGreaterThan(0);
    for (const call of lookups) {
      expect(call.env.AWS_PROFILE).toBe('abe-tooling');
      expect(call.env.AWS_REGION).toBe('eu-west-1');
    }
  }, 20_000);
});
