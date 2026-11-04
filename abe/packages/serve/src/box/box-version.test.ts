/**
 * A box on another abe than the Mac's (#188), through the CLI seam: the Mac's `abe` is the real
 * one, its boxes on the fake EC2, its link the fake box shell (`ABE_BOX_LINK=exec:`) onto a box
 * `serve` standing in for each box. Box OLD says abe 2.0.0-alpha.0 and its `abe` has not got the
 * newer commands (as 2.0's says it: `unknown command: box keep`, its help after it); box SAME
 * runs this Mac's abe.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOX_RELEASE_DOC, BoxListData } from '@abe/core';
import {
  cli,
  type Cli,
  fakeBoxShell,
  type FakeBoxShell,
  fakeEc2,
  type FakeEc2,
  scenario,
  type ServeScenario,
} from '@abe/testing';
import { VERSION } from '../process/version';

setDefaultTimeout(30_000);

const REPO = 'mkdir-swe/demo-shop';
const OLD = 'demo-shop-3';
const SAME = 'demo-shop-6';
const THEIRS = '2.0.0-alpha.0';
const STEP = `update the box release (${BOX_RELEASE_DOC})`;

type World = {
  root: string;
  ec2: FakeEc2;
  shell: FakeBoxShell;
  old: ServeScenario;
  same: ServeScenario;
  mac: Cli;
};

let w: World;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'abe-v-'));
  const ec2 = fakeEc2({ owner: 'octocat', bootMs: 300, stopMs: 300 });
  const shell = fakeBoxShell(ec2);
  const [old, same] = await Promise.all([
    scenario({ box: true, version: THEIRS }),
    scenario({ box: true }),
  ]);

  mkdirSync(join(root, 'mine'), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: cloud\n');
  ec2.put({ name: OLD, size: 'm8g.large', repo: REPO, card: 3, release: 11 });
  ec2.put({ name: SAME, size: 'm8g.large', repo: REPO, card: 6, release: 12 });
  shell.box(OLD, old.state.socket);
  shell.box(SAME, same.state.socket);
  shell.older(OLD, ['box keep', 'session transcript', 'session asks']);
  // A box on this same abe whose table lacks one: its own answer stands.
  shell.older(SAME, ['session asks']);
  const mac = cli({
    env: {
      PATH: ec2.path,
      ABE_OWNER: ec2.owner,
      ABE_BOX_LINK: `exec:${shell.path}`,
      ABE_CONFIG_DIR: join(root, 'mine'),
      // a stop and a start are waited on in 100 ms looks, not 2 s ones
      ABE_CLOUD_POLL_MS: '100',
    },
  });

  w = { root, ec2, shell, old, same, mac };
});

afterAll(async () => {
  await w.mac.close();
  await w.old.close();
  await w.same.close();
  w.shell.remove();
  w.ec2.remove();
  rmSync(w.root, { recursive: true, force: true });
});

/** stderr without the progress lines a wait past a second draws (#193; one per step off a terminal). */
const said = (stderr: string) =>
  stderr
    .split('\n')
    .filter((line) => !/^demo-shop-\d+: .*… \d+:\d\d$/.test(line))
    .join('\n');

const tooOld = (command: string) =>
  `${OLD} runs abe ${THEIRS}, this machine ${VERSION}: \`${command}\` needs this machine's abe on the box · ${STEP}`;

describe('a command the box’s abe has not got is said as that, never “unknown command”', () => {
  test('box keep: both versions and what to do', async () => {
    const out = await w.mac.run('box', 'keep', OLD);

    expect(said(out.stderr)).toBe(`abe: ${tooOld('box keep')}\n`);
    expect(out.exit).toBe(1);
  });

  test('--on: a cloud session’s transcript (#154), without the box’s help after it', async () => {
    const out = await w.mac.run('--on', OLD, 'session', 'transcript', '3-2329');

    expect(said(out.stderr)).toBe(`abe: ${tooOld('session transcript')}\n`);
    expect(out.exit).toBe(1);
    const json = await w.mac.run('--on', OLD, 'session', 'asks', '3-2329', '--json');

    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: { code: 'box-version', message: tooOld('session asks') },
    });
    expect(json.exit).toBe(1);
  });

  test('a command this Mac does not know either, or a box on this abe: the box’s own answer', async () => {
    const frob = await w.mac.run('--on', OLD, 'frob', 'it');

    expect(said(frob.stderr)).toStartWith('abe: unknown command: frob it\n');
    expect(frob.exit).toBe(2);
    const same = await w.mac.run('--on', SAME, 'session', 'asks', '6-1', '--json');

    expect(JSON.parse(same.stdout)).toMatchObject({ error: { code: 'unknown-command' } });
  });
});

test('box list: each running box’s abe, and the one not this Mac’s says so', async () => {
  const listed = await w.mac.json(BoxListData, 'box', 'list');

  if (!listed.doc.ok) throw new Error(listed.stderr);
  const byName = new Map(listed.doc.data.boxes.map((b) => [b.name, b]));

  expect(byName.get(OLD)).toMatchObject({
    abe: THEIRS,
    skew: `${OLD} runs abe ${THEIRS}, this machine ${VERSION}: commands newer than the box's abe fail there · ${STEP}`,
  });
  expect(byName.get(SAME)?.abe).toBe(VERSION);
  expect(byName.get(SAME)).not.toHaveProperty('skew');
  const text = await w.mac.run('box', 'list');

  expect(text.stdout).toContain(`${OLD}  running  m8g.large  v11  abe ${THEIRS}`);
  expect(text.stdout).toContain(`\n  ${OLD} runs abe ${THEIRS}, this machine ${VERSION}: `);
  expect(text.stdout).toContain(`${SAME}  running  m8g.large  v12  abe ${VERSION}  $0.00 today\n`);
});

test('box start on another abe than this Mac’s (#244): its boot may still put the release on it, said', async () => {
  const woke = `${OLD} woke on abe ${THEIRS}, this machine ${VERSION}: it stays on ${THEIRS} unless the boxes' release (abe/current) is another, which its boot then installs a minute or two from now · abe box status ${OLD} says which abe runs`;

  expect((await w.mac.run('box', 'stop', OLD)).exit).toBe(0);
  const started = await w.mac.run('box', 'start', OLD);

  expect(started.exit).toBe(0);
  expect(started.stdout).toContain(`\n  ${woke}`);
  // only the start says it: a list later does not
  expect((await w.mac.run('box', 'list')).stdout).not.toContain(' woke on abe ');
  // a box on this Mac's abe: nothing to say
  expect((await w.mac.run('box', 'stop', SAME)).exit).toBe(0);
  const same = await w.mac.run('box', 'start', SAME);

  expect(same.exit).toBe(0);
  expect(same.stdout).not.toContain(' woke on abe ');
});
