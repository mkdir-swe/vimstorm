/** The CLI's progress line: what a waiting command is about and the words each event moves it to. */
import { describe, expect, test } from 'bun:test';
import { type Event, progressLine, progressNarrowed, progressOf, progressStep } from '.';

const AT = '2026-10-24T10:00:00.000Z';
const boxState = (box: string, state: 'starting' | 'running' | 'stopping'): Event => ({
  seq: 1,
  at: AT,
  type: 'box.state',
  data: { box, state, cause: 'start' },
});
const boxStep = (box: string, step: 'booting' | 'workspace' | 'claude'): Event => ({
  seq: 2,
  at: AT,
  type: 'box.step',
  data: { box, step },
});
const sessionState = (
  id: string,
  card: number,
  state: 'queued' | 'working' | 'waiting',
  cause = 'launch',
): Event => ({
  seq: 3,
  at: AT,
  type: 'session.state',
  data: { id, card, state, since: AT, cause },
});

describe('what a command waits on', () => {
  test.each([
    [['box', 'start', 'demo-shop-3'], 'demo-shop-3', 'waking'],
    [['box', 'stop', 'demo-shop-3'], 'demo-shop-3', 'stopping'],
    [['box', 'list'], 'your boxes', 'reading EC2 and each running box'],
    [
      ['--on', 'demo-shop-9', 'status'],
      'demo-shop-9',
      'reaching its abe serve (a sleeping box is woken first)',
    ],
    [['session', 'launch', '--card', '102', '--repo', '.'], 'AB#102', 'launching'],
    [['session', 'download', '901-a3b8'], '901-a3b8', 'downloading to this machine'],
    [['box', 'up', 'mkdir-swe/demo-shop', '4'], 'demo-shop', 'placing its box'],
    [['factory', 'run', 'AB#12'], 'AB#12', 'launching'],
  ])('%j: %s %s', (argv, name, words) => {
    expect(progressOf(argv)).toMatchObject({ name, words });
  });

  test('--json, --help and commands that answer at once draw no line', () => {
    expect(progressOf(['box', 'list', '--json'])).toBeUndefined();
    expect(progressOf(['box', 'start', '--help'])).toBeUndefined();
    expect(progressOf(['status'])).toBeUndefined();
    expect(progressOf(['session', 'list'])).toBeUndefined();
  });
});

describe('the words each event moves the line to', () => {
  const start = progressOf(['box', 'start', 'demo-shop-3']);
  const launch = progressOf(['session', 'launch', '--card', '102', '--repo', '.']);

  test("a box's own moves and steps", () => {
    if (start === undefined) throw new Error('no subject');
    expect(progressStep(start, boxState('demo-shop-3', 'starting'))).toBe('starting (EC2 pending)');
    expect(progressStep(start, boxStep('demo-shop-3', 'booting'))).toBe(
      'running, waiting for its abe serve',
    );
    expect(progressStep(start, boxState('demo-shop-4', 'running'))).toBeUndefined();
  });

  test("a launch follows its card's box (named with the line) and its session", () => {
    if (launch === undefined) throw new Error('no subject');
    expect(progressStep(launch, boxStep('demo-shop-102', 'workspace'))).toBe(
      'demo-shop-102 abe serve answers, workspace coming up',
    );
    expect(progressStep(launch, boxStep('demo-shop-1102', 'claude'))).toBeUndefined();
    expect(progressStep(launch, sessionState('102-083b', 102, 'queued'))).toBe(
      '102-083b queued: no room under limits.maxBoxesPerPerson, starts when a box of yours stops',
    );
    expect(progressStep(launch, sessionState('7-aaaa', 7, 'working'))).toBeUndefined();
  });

  test("another session on the card is not the launch's; once named, only its id is", () => {
    if (launch === undefined) throw new Error('no subject');
    // An older session on card 102 waiting on you meanwhile.
    expect(progressStep(launch, sessionState('102-aaaa', 102, 'waiting', 'Stop'))).toBeUndefined();
    const named = progressNarrowed(launch, sessionState('102-bbbb', 102, 'queued', 'queued'));

    expect(named.session).toEqual({ id: '102-bbbb' });
    expect(progressStep(named, sessionState('102-bbbb', 102, 'working', 'UserPromptSubmit'))).toBe(
      '102-bbbb Claude Code working',
    );
    expect(progressStep(named, sessionState('102-cccc', 102, 'working', 'launch'))).toBeUndefined();
  });

  test('the line drawn with its elapsed time', () => {
    if (start === undefined) throw new Error('no subject');
    expect(progressLine(start, 'starting (EC2 pending)', 4_200)).toBe(
      'demo-shop-3: starting (EC2 pending)… 0:04',
    );
  });
});
