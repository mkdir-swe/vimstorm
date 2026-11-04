import { describe, expect, test } from 'bun:test';
import {
  boxRuns,
  buildStepOf,
  building,
  clockText,
  launchBegun,
  launchFailText,
  launchFromBox,
  type LaunchProgress,
  launchStepped,
  launchText,
} from './launch';

const T0 = '2026-10-24T10:55:46.000Z';
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const BOX = 'demo-shop-901';

/** QA F's cold launch on a new box (#142), as the Mac and the box say its steps. */
const cold = (): LaunchProgress[] => {
  const begun = launchBegun(BOX, 'new', at(0));
  const booting = launchStepped(begun, 'box-booting', at(7));
  const mirror = launchFromBox(booting, { step: 'mirror', detail: null }, at(82));
  const base = launchFromBox(mirror, { step: 'base-image', detail: 'step 14/27' }, at(87));
  const base2 = launchFromBox(base, { step: 'base-image', detail: 'step 15/27' }, at(130));
  const image = launchFromBox(base2, { step: 'image', detail: null }, at(276));
  const clone = launchFromBox(image, { step: 'clone', detail: null }, at(290));
  const claude = launchStepped(clone, 'claude-starting', at(306));

  return [begun, booting, mirror, base, base2, image, clone, claude];
};

/** The cold launch at its `i`th step. */
const coldAt = (i: number): LaunchProgress => {
  const l = cold()[i];

  if (l === undefined) throw new Error(`no step ${i}`);

  return l;
};

describe('a launch moves through its steps, each with its time (#142)', () => {
  test('a new box starts at box-starting; one running already at its workspace', () => {
    expect(launchBegun(BOX, 'new', T0).step).toBe('box-starting');
    expect(launchBegun(BOX, 'wake', T0).step).toBe('box-starting');
    expect(launchBegun(BOX, 'use', T0).step).toBe('workspace');
  });

  test("the box's steps: images their own, the rest the workspace's, said as what they do", () => {
    expect(cold().map((l) => [l.step, l.detail])).toEqual([
      ['box-starting', null],
      ['box-booting', null],
      ['workspace', 'fetching the repo'],
      ['base-image', 'step 14/27'],
      ['base-image', 'step 15/27'],
      ['repo-image', null],
      ['workspace', 'cloning the repo'],
      ['claude-starting', null],
    ]);
  });

  test('the same step again keeps its clock; a step closed keeps how long it took', () => {
    const steps = cold();

    expect(steps[4]?.since).toBe(at(87));
    expect(steps[7]?.done).toEqual([
      { step: 'box-starting', ms: 7000 },
      { step: 'box-booting', ms: 75_000 },
      { step: 'workspace', ms: 5000 },
      { step: 'base-image', ms: 189_000 },
      { step: 'repo-image', ms: 14_000 },
      { step: 'workspace', ms: 16_000 },
    ]);
  });

  test('never back: a late box-booting after the workspace began is kept out', () => {
    const l = launchFromBox(launchBegun(BOX, 'wake', T0), { step: 'clone', detail: null }, at(5));

    expect(launchStepped(l, 'box-booting', at(6))).toBe(l);
    // the Mac's own workspace step, once its probe answered, after the box said its build
    const building = launchFromBox(l, { step: 'base-image', detail: 'step 2/27' }, at(7));

    expect(launchStepped(building, 'workspace', at(8))).toBe(building);
  });

  test("Docker's build lines give its step count; other lines none", () => {
    expect(buildStepOf('#9 [stage-1 14/27] RUN apt-get install -y git')).toBe('step 14/27');
    expect(buildStepOf('#5 [3/9] COPY . .')).toBe('step 3/9');
    expect(buildStepOf('#9 0.312 Reading package lists...')).toBeUndefined();
    expect(buildStepOf('#1 [internal] load build definition from Dockerfile')).toBeUndefined();
    expect(buildStepOf('#9 0.4 echo "[2/3] done"')).toBeUndefined();
  });
});

describe('what a launch says where no client draws it (#142)', () => {
  test('given up: the reason names the step that hung and where its log is', () => {
    const booting = launchStepped(launchBegun(BOX, 'wake', T0), 'box-booting', at(15));

    expect(launchFailText(booting, at(900), 'the box did not answer')).toBe(
      `the box did not answer (hung booting the box for 14:45; abe box attach ${BOX} -- journalctl -u abe-serve -u abe-workspace -n 40 says why)`,
    );
    // no box to attach to yet: no log to read
    expect(
      launchFailText(launchBegun(BOX, 'new', T0), at(900), 'box demo is not running after 900 s'),
    ).toBe('box demo is not running after 900 s (hung starting the box for 15:00)');
  });

  test("abe watch's line and the clock's words", () => {
    expect(launchText(coldAt(3))).toBe(`building the workspace image · step 14/27 on ${BOX}`);
    expect(clockText(7000)).toBe('0:07');
    expect(clockText(318_000)).toBe('5:18');
    expect(clockText(3_723_000)).toBe('1:02:03');
  });
});

describe('whether its box runs, and its workspace is being built there (#339)', () => {
  test('starting: asleep while EC2 starts it and it boots; running once it builds the workspace', () => {
    const rows = cold().map((l) => [
      l.step,
      boxRuns({ state: 'starting', launch: l }),
      building({ state: 'starting', launch: l }),
    ]);

    expect(rows).toEqual([
      ['box-starting', false, false],
      ['box-booting', false, false],
      ['workspace', true, true],
      ['base-image', true, true],
      ['base-image', true, true],
      ['repo-image', true, true],
      ['workspace', true, true],
      ['claude-starting', true, false],
    ]);
  });

  test('working or waiting runs; ended, queued or a launch not said is not known to', () => {
    const at = (state: 'working' | 'waiting' | 'ended' | 'queued' | 'starting') =>
      boxRuns({ state, launch: null });

    expect([at('working'), at('waiting'), at('ended'), at('queued'), at('starting')]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    // a launch's progress kept on an ended one says nothing of its box now
    expect(boxRuns({ state: 'ended', launch: coldAt(3) })).toBe(false);
    expect(building({ state: 'working', launch: coldAt(3) })).toBe(false);
  });
});
