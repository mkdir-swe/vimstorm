import { describe, expect, test } from 'bun:test';
import {
  BOX_SIZES,
  bootState,
  boxSettling,
  boxName,
  boxRoleName,
  boxSpec,
  DEFAULT_BOX_SIZE,
  doneByItsPr,
  isCloudTarget,
  resizeRefusal,
} from './cloud';
import { type BoxState } from '../ports';

describe("boxName: the repo's box (ADR 0022), a host name of at most 32", () => {
  test.each([
    ['mkdir-swe/demo-shop', 'demo-shop'],
    ['o/Demo_Shop.web', 'demo-shop-web'],
    ['o/a-very-long-repository-name-that-goes-on-and-on', 'a-very-long-repository-name-that'],
    ['o/---', 'repo'],
  ])('%s → %s', (repo, name) => {
    expect(boxName(repo)).toBe(name);
    expect(boxName(repo, true)).toMatch(
      new RegExp(`^${name.slice(0, 27).replace(/-+$/, '')}-[0-9a-f]{4}$`),
    );
    expect(boxName(repo, true).length).toBeLessThanOrEqual(32);
  });
});

describe('isCloudTarget: your environment only when serve.target says cloud (#166)', () => {
  test.each([
    ['cloud', true],
    ['local', false],
    ['locall', false],
    ['local-sandbox', false],
  ])('%s → %p', (target, cloud) => {
    expect(isCloudTarget(target)).toBe(cloud);
  });
});

describe('what a box is made with', () => {
  test("the repo's box: the name its placement chose, its repo, no card", () => {
    expect(boxSpec({ name: 'demo-shop', repo: 'mkdir-swe/demo-shop' })).toEqual({
      name: 'demo-shop',
      repo: 'mkdir-swe/demo-shop',
    });
  });

  test('its start size is box.size, never past limits.maxBoxSize', () => {
    const spec = (size: string, maxSize: string) =>
      boxSpec({ name: 'x', repo: 'o/x', size, maxSize }).size;

    expect(spec('m8g.xlarge', 'm8g.2xlarge')).toBe('m8g.xlarge');
    expect(spec('m8g.4xlarge', 'm8g.2xlarge')).toBe('m8g.2xlarge');
  });

  test("the owner's box role, as the org Terraform's terraform/box makes it per person", () => {
    expect(boxRoleName('octocat')).toBe('abe-box-octocat-boxes');
  });

  test.each<[BoxState, ReturnType<typeof bootState>]>([
    ['pending', 'coming'],
    ['running', 'running'],
    ['stopping', 'down'],
    ['stopped', 'down'],
    ['shutting-down', 'down'],
    ['terminated', 'down'],
  ])('bootState(%s) → %s', (state, want) => {
    expect(bootState(state)).toBe(want);
  });
});

describe('boxSettling: one look at a box waited for until EC2 says it is up or down', () => {
  test.each<
    [string, 'running' | 'stopped', BoxState | null, boolean, ReturnType<typeof boxSettling>]
  >([
    ['up: there', 'running', 'running', false, { kind: 'there' }],
    ['up: pending is on its way', 'running', 'pending', false, { kind: 'wait' }],
    ['up: just asked, may still read stopped', 'running', 'stopped', false, { kind: 'wait' }],
    ['up: a stop in progress ends first', 'running', 'stopping', false, { kind: 'wait' }],
    [
      'up: going away never comes up',
      'running',
      'shutting-down',
      false,
      { kind: 'failed', why: 'is shutting-down' },
    ],
    ['up: terminated', 'running', 'terminated', false, { kind: 'failed', why: 'is terminated' }],
    ['up: not listed is gone', 'running', null, false, { kind: 'failed', why: 'is gone' }],
    ['up: just made, not listed yet', 'running', null, true, { kind: 'wait' }],
    ['down: there', 'stopped', 'stopped', false, { kind: 'there' }],
    ['down: stopping', 'stopped', 'stopping', false, { kind: 'wait' }],
    ['down: just asked, may still read running', 'stopped', 'running', false, { kind: 'wait' }],
    ['down: a stop asked while it came up', 'stopped', 'pending', false, { kind: 'wait' }],
    ['down: terminated', 'stopped', 'terminated', false, { kind: 'failed', why: 'is terminated' }],
    ['down: not listed is gone', 'stopped', null, true, { kind: 'failed', why: 'is gone' }],
  ])('%s', (_, want, state, fresh, settling) => {
    expect(boxSettling(want, state, fresh)).toEqual(settling);
  });
});

describe('resizeRefusal: a box within its team maximum, asked first while sessions run', () => {
  test.each<[string, string, string, number, boolean, string | undefined]>([
    ['up to the maximum', 'm8g.xlarge', 'm8g.xlarge', 0, false, undefined],
    ['down, sessions asked for', 'm8g.large', 'm8g.2xlarge', 2, true, undefined],
    ['over the maximum', 'm8g.2xlarge', 'm8g.xlarge', 0, false, 'size-over-team-max'],
    [
      'over the maximum even with --yes',
      'm8g.4xlarge',
      'm8g.2xlarge',
      1,
      true,
      'size-over-team-max',
    ],
    ['a size Abe does not know', 'm8g.huge', 'm8g.2xlarge', 0, false, 'size-unknown'],
    ['another family', 't4g.large', 'm8g.2xlarge', 0, false, 'size-unknown'],
    ['a maximum that is no box size', 'm8g.large', 'big', 0, false, 'size-over-team-max'],
    ['sessions run, not asked', 'm8g.xlarge', 'm8g.2xlarge', 1, false, 'sessions-running'],
  ])('%s', (_, size, max, running, yes, code) => {
    expect(resizeRefusal({ size, max, running, yes })?.code).toBe(code);
  });

  test('the refusal says the size, the maximum and what to do', () => {
    expect(
      resizeRefusal({ size: 'm8g.4xlarge', max: 'm8g.xlarge', running: 0, yes: false })?.message,
    ).toBe(
      'm8g.4xlarge is bigger than the repo allows: its largest box size is m8g.xlarge · pick m8g.xlarge or smaller, or raise it in abe.yaml',
    );
    // a largest size that is no box size: the setting named, so it can be fixed
    expect(resizeRefusal({ size: 'm8g.large', max: 'big', running: 0, yes: false })?.message).toBe(
      "the repo's largest box size (limits.maxBoxSize) is big, not a box size: set one of m8g.large, m8g.xlarge, m8g.2xlarge, m8g.4xlarge, m8g.8xlarge, m8g.12xlarge, m8g.16xlarge",
    );
    expect(
      resizeRefusal({ size: 'm8g.xlarge', max: 'm8g.2xlarge', running: 2, yes: false })?.message,
    ).toBe('2 sessions run on the box; resizing stops it: --yes to resize anyway');
  });

  test('the sizes run smallest first, from the default', () => {
    expect(BOX_SIZES[0]).toBe(DEFAULT_BOX_SIZE);
    // the org Terraform's terraform/modules/teams lists the same, in this order.
    expect([...BOX_SIZES]).toEqual([
      'm8g.large',
      'm8g.xlarge',
      'm8g.2xlarge',
      'm8g.4xlarge',
      'm8g.8xlarge',
      'm8g.12xlarge',
      'm8g.16xlarge',
    ]);
  });
});

describe('doneByItsPr: a run carried to Done past its session stops it (#304)', () => {
  const end = { as: 'done', reason: 'by hand', at: '2026-10-25T00:00:00Z', from: 'pr' };

  test.each([
    ['merged and deployed', { pr: {}, outcome: 'done', ended: null }, true],
    ['its pull request still open', { pr: {}, outcome: null, ended: null }, false],
    [
      'ended done by a person (factory end stops it)',
      { pr: {}, outcome: 'done', ended: end },
      false,
    ],
    [
      'done with no pull request (a question answered)',
      { pr: null, outcome: 'done', ended: null },
      false,
    ],
    ['abandoned', { pr: {}, outcome: 'abandoned', ended: null }, false],
  ] as const)('%s', (_, run, done) => {
    expect(doneByItsPr(run)).toBe(done);
  });
});
