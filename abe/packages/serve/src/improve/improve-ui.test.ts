/**
 * View tweaks and Improve's one-shot (ticket #85) through the CLI seam: the real `abe` and its
 * `serve`, the fake `claude -p` answering Improve's one-shot, a temporary personal Layer. A tweak
 * naming no node is refused at write time, and so is a proposal naming one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImproveData, SettingSetData } from '@abe/core';
import { cli, type Cli, fakeClaude, type FakeClaude, scriptOneShot } from '@abe/testing';

const SETTINGS = '# mine\n';
describe(':improve in VimStorm on a fake claude -p', () => {
  let root: string;
  let mine: string;
  let claude: FakeClaude;
  let abe: Cli;
  const settings = () => readFileSync(join(mine, 'settings.yaml'), 'utf8');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-improve-ui-'));
    mine = join(root, 'mine');
    mkdirSync(mine);
    writeFileSync(join(mine, 'settings.yaml'), SETTINGS);
    claude = fakeClaude();
    abe = cli({
      env: {
        PATH: `${claude.dir}:/usr/bin:/bin`,
        ABE_CONFIG_DIR: mine,
      },
    });
    await abe.run('status');
  });

  afterAll(async () => {
    await abe.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test('views: a node no screen has is refused at write time, unknown-node', async () => {
    const out = await abe.json(
      SettingSetData,
      'settings',
      'set',
      'views',
      '[{ screen: factory, node: shipping, hide: true }]',
    );

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'unknown-node' } });
    expect(out.doc.ok ? '' : out.doc.error.message).toContain('factory has no node shipping');
    expect(settings()).toBe(SETTINGS);
    // nor may Improve's proposal name one
    scriptOneShot(abe.state.dir, {
      answers: [
        JSON.stringify({
          kind: 'change',
          summary: 'Hide the Shipping column',
          files: [
            {
              path: 'settings.yaml',
              after: `${SETTINGS}views: [{ screen: factory, node: shipping, hide: true }]\n`,
            },
          ],
        }),
      ],
    });
    const asked = await abe.json(ImproveData, 'improve', 'hide the Shipping column');

    expect(asked.doc).toMatchObject({ ok: false, error: { code: 'unknown-node' } });
  });
});
