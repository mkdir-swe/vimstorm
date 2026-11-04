import { describe, expect, test } from 'bun:test';
import * as core from '@abe/core';
import type { LaunchProgress } from '@abe/core';
import { clockText, GIVE_UP_MS, LATE_WORDS, launchLook, launchSteps } from './index';

const { launchBegun, launchFromBox, launchStepped } = core;

const T0 = '2026-10-24T10:55:46.000Z';
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const BOX = 'demo-shop-901';

/** QA F's cold launch on a new box, as the Mac and the box say its steps. */
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

describe('what a launch says, second by second', () => {
  test('each step named, with the time since the launch began', () => {
    const [begun, booting, , base, , image, clone, claude] = cold();

    expect(begun && launchLook(begun, at(0))).toEqual({
      word: 'Box starting',
      line: `Making box ${BOX} · new box, first start takes about 5 min`,
      elapsed: '0:00',
      tone: 'on-time',
    });
    expect(booting && launchLook(booting, at(45)).line).toBe(
      'Box booting, installing its tools (first boot only)',
    );
    expect(base && launchLook(base, at(130))).toMatchObject({
      word: 'Building image',
      line: 'Building the workspace image (first time on this box, ~3 min) · step 14/27',
      elapsed: '2:10',
      tone: 'on-time',
    });
    expect(image && launchLook(image, at(280)).line).toBe("Building the repo's image");
    expect(clone && launchLook(clone, at(300)).line).toBe('Workspace · cloning the repo');
    expect(claude && launchLook(claude, at(308))).toMatchObject({
      word: 'Starting Claude',
      line: 'Starting Claude Code',
      elapsed: '5:08',
    });
  });

  test('a woken box: Waking, then booting; a box running already: the workspace', () => {
    const wake = launchBegun('demo-shop-102', 'wake', T0);

    expect(launchLook(wake, at(5)).line).toBe('Waking demo-shop-102');
    expect(launchLook(launchStepped(wake, 'box-booting', at(15)), at(17)).line).toBe('Box booting');
    expect(launchLook(launchBegun(BOX, 'use', T0), at(1)).line).toBe('Starting the workspace');
  });

  test('past its budget a step is amber: what is late, by how much, the box log', () => {
    const base = cold()[3];
    const late = base && launchLook(base, at(87 + 370));

    expect(late?.tone).toBe('slow');
    expect(late?.note).toBe(
      'Slower than usual · building the workspace image 6:10 (usually 3 min)',
    );
    expect(late?.fix?.[0]).toEqual({
      label: 'Box log',
      argv: `abe box attach ${BOX} -- journalctl -u abe-serve -u abe-workspace -n 40`,
    });
  });

  test('a box up whose serve never answers says so, with Restart serve', () => {
    const booting = launchStepped(launchBegun(BOX, 'wake', T0), 'box-booting', at(15));
    const late = launchLook(booting, at(15 + 180));

    expect(late.tone).toBe('slow');
    expect(late.note).toBe("Box up but abe serve doesn't answer · 3:00");
    expect(late.fix?.map((f) => f.label)).toEqual(['Box log', 'Restart serve']);
    expect(late.fix?.[1]?.argv).toBe(`abe box attach ${BOX} -- sudo systemctl restart abe-serve`);
  });

  test('an older abe on a new box says no steps: its workspace has the image in its budget', () => {
    const silent = launchStepped(
      launchStepped(launchBegun(BOX, 'new', T0), 'box-booting', at(7)),
      'workspace',
      at(82),
    );

    expect(launchLook(silent, at(82 + 200))).toMatchObject({
      line: 'Workspace · building its image, cloning, starting the database',
      tone: 'on-time',
    });
    expect(launchLook(silent, at(82 + 430)).tone).toBe('slow');
  });

  test('near the give-up it is red, the step that hung named', () => {
    const base = cold()[3];
    const stuck = base && launchLook(base, at(13 * 60));

    expect(stuck?.tone).toBe('stuck');
    expect(stuck?.note).toMatch(/^Stuck · building the workspace image \d+:\d\d \(usually 3 min\)/);
  });

  test('Chat lists the steps gone through with their times, then the one now', () => {
    const claude = coldAt(7);

    expect(launchSteps(claude, at(308)).map((r) => `${r.text} ${r.time}`)).toEqual([
      '✓ Box starting 0:07',
      '✓ Box booting 1:15',
      '✓ Workspace 0:05',
      '✓ Building image 3:09',
      '✓ Repo image 0:14',
      '✓ Workspace 0:16',
      '● Starting Claude Code 0:02',
    ]);
  });

  test("ui's clock, step words and give-up are core's", () => {
    for (const ms of [0, 7000, 59_999, 318_000, 3_723_000])
      expect(clockText(ms)).toBe(core.clockText(ms));
    expect(LATE_WORDS).toEqual(core.LAUNCH_STEP_WORDS);
    expect(GIVE_UP_MS).toBe(core.LAUNCH_GIVE_UP_MS);
  });
});
