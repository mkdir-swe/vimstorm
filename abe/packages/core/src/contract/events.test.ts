import { describe, expect, test } from 'bun:test';
import { fakeClock, T0 } from '@abe/testing';
import { Event, EVENT_TYPES, EventLine, eventText, journal, RING } from '.';

const ran = { noun: 'status', verb: null, exit: 0 } as const;

describe('the event union', () => {
  test('every type is <noun>.<event>', () => {
    for (const type of EVENT_TYPES) expect(type).toMatch(/^[a-z]+\.[a-z]+$/);
  });

  test.each([
    ['serve.started', { version: '2.0.0', pid: 1, socket: '/s.sock' }],
    ['command.ran', { noun: 'serve', verb: 'stop', exit: 0 }],
    ['watch.gap', { since: 3, first: 9 }],
    ['settings.changed', { keys: ['autoMerge'], repo: null }],
    [
      'session.transcript',
      {
        session: '2-8966',
        from: 4,
        entries: [
          {
            kind: 'assistant-text',
            id: 'u1',
            at: '2026-10-01T09:00:00.000Z',
            agent: null,
            text: 'Done.',
          },
        ],
      },
    ],
  ])('%s is in it', (type, data) => {
    const line = { seq: 1, at: '2026-10-01T09:00:00.000Z', type, data };

    const parsed: unknown = Event.parse(line);

    expect(parsed).toEqual(line);
  });

  test.each([
    ['an unknown type', { type: 'card.moved', data: {} }],
    ['data of another type', { type: 'command.ran', data: { version: '2.0.0' } }],
    ['an exit no command has', { type: 'command.ran', data: { ...ran, exit: 7 } }],
    ['a key no setting has', { type: 'settings.changed', data: { keys: ['colour'], repo: null } }],
  ])('refuses %s', (_, event) => {
    expect(Event.safeParse({ seq: 1, at: '2026-10-01T09:00:00.000Z', ...event }).success).toBe(
      false,
    );
  });

  test('a line of a type this build does not know still reads as a line', () => {
    const line = { seq: 4, at: '2026-10-01T09:00:00.000Z', type: 'card.moved', data: { id: 3 } };

    expect(EventLine.parse(line)).toEqual(line);
    expect(eventText(line)).toBe('4 2026-10-01T09:00:00.000Z card.moved {"id":3}\n');
  });

  test.each([
    [
      { type: 'serve.started', data: { version: '2.0.0', pid: 7, socket: '/s.sock' } },
      'abe serve 2.0.0 listening on /s.sock (pid 7)',
    ],
    [{ type: 'command.ran', data: { noun: 'serve', verb: 'stop', exit: 0 } }, 'abe serve stop: 0'],
    [{ type: 'command.ran', data: ran }, 'abe status: 0'],
    [{ type: 'watch.gap', data: { since: 3, first: 9 } }, 'events 4 to 8 are gone; next is 9'],
    [
      { type: 'settings.changed', data: { keys: ['checks', 'reach'], repo: '/r' } },
      'checks, reach in /r',
    ],
    [
      {
        type: 'factory.checks',
        data: {
          card: 4,
          session: 's1',
          green: false,
          cause: 'checks',
          file: '/w/.scratch/4/checks.md',
          results: [
            { name: 'tests', status: 'red', exit: 1, durationMs: 900 },
            { name: 'no-deleted-tests', status: 'green', exit: null, durationMs: 20 },
          ],
        },
      },
      'AB#4 checks red: tests red, no-deleted-tests green (checks)',
    ],
    [
      {
        type: 'session.transcript',
        data: {
          session: '2-8966',
          from: 7,
          entries: [
            {
              kind: 'assistant-text',
              id: 'u1',
              at: '2026-10-01T09:00:00.000Z',
              agent: null,
              text: 'Done.',
            },
            {
              kind: 'compact',
              id: 'u2',
              at: '2026-10-01T09:00:01.000Z',
              agent: null,
              trigger: 'manual',
              preTokens: null,
            },
          ],
        },
      },
      '2-8966 transcript 2 entries from 7',
    ],
    [
      { type: 'watch.gap', data: { since: 50, first: 1 } },
      'event 50 is not from this serve; next is 1',
    ],
    [{ type: 'launch.started', data: { card: 4, repo: '/r' } }, 'AB#4 from /r'],
    [
      {
        type: 'launch.ended',
        data: {
          card: 4,
          repo: '/r',
          session: null,
          refused: { code: 'aws-auth', message: 'log in to aws' },
        },
      },
      'AB#4 refused: log in to aws (aws-auth)',
    ],
  ])('reads as one line: %o', (event, words) => {
    expect(eventText({ seq: 2, at: '2026-10-01T09:00:00.000Z', ...event })).toBe(
      `2 2026-10-01T09:00:00.000Z ${event.type} ${words}\n`,
    );
  });
});

describe('the journal', () => {
  test('numbers events from 1, one apart, stamped in RFC 3339 by the clock', () => {
    const clock = fakeClock();
    const j = journal(clock);
    const first = j.emit('command.ran', ran);

    clock.tick(1500);
    const second = j.emit('command.ran', { ...ran, exit: 2 });

    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(first.at).toBe(new Date(T0).toISOString());
    expect(second.at).toBe(new Date(T0 + 1500).toISOString());
    expect(j.last()).toBe(2);
  });

  test('cannot emit a type outside the union, by type or at run time', () => {
    const j = journal(fakeClock());

    // @ts-expect-error -- not an event type
    expect(() => j.emit('card.moved', {})).toThrow('card.moved');
    // @ts-expect-error -- not command.ran's data
    expect(() => j.emit('command.ran', { exit: 0 })).toThrow();
    expect(j.last()).toBe(0);
  });

  test('a watcher gets the events after its number, then each new one', () => {
    const j = journal(fakeClock());

    for (let i = 0; i < 3; i += 1) j.emit('command.ran', ran);
    const seen: number[] = [];

    j.watch(1, (e) => seen.push(e.seq));
    j.emit('command.ran', ran);

    expect(seen).toEqual([2, 3, 4]);
  });

  test('without a number a watcher gets only new events', () => {
    const j = journal(fakeClock());

    j.emit('command.ran', ran);
    const seen: number[] = [];

    j.watch(undefined, (e) => seen.push(e.seq));
    j.emit('command.ran', ran);

    expect(seen).toEqual([2]);
  });

  test('the ring holds the last 10,000', () => {
    expect(RING).toBe(10_000);
    const j = journal(fakeClock());

    for (let i = 0; i < RING + 5; i += 1) j.emit('command.ran', ran);
    const seen: Event[] = [];

    j.watch(5, (e) => seen.push(e));
    expect(seen).toHaveLength(RING);
    expect(seen[0]?.seq).toBe(6);
  });

  test.each([
    ['older than the ring', 1, [{ type: 'watch.gap', seq: 5, data: { since: 1, first: 6 } }]],
    ['the last one gone', 5, []],
    ['from another serve, ahead of this one', 50, [{ type: 'watch.gap', seq: 5 }]],
  ])('asked for a number %s', (_, since, gap) => {
    const j = journal(fakeClock(), 5);

    for (let i = 0; i < 10; i += 1) j.emit('command.ran', ran);
    const seen: Event[] = [];

    j.watch(since, (e) => seen.push(e));
    expect(seen.slice(0, gap.length)).toMatchObject(gap);
    expect(seen.slice(gap.length).map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
  });

  test('a gap ahead of this serve says where it starts again', () => {
    const j = journal(fakeClock(), 5);

    j.emit('command.ran', ran);
    const seen: Event[] = [];

    j.watch(50, (e) => seen.push(e));
    expect(seen).toMatchObject([
      { seq: 0, type: 'watch.gap', data: { since: 50, first: 1 } },
      { seq: 1, type: 'command.ran' },
    ]);
  });

  test('stopping one watcher leaves the others; a throwing watcher is dropped', () => {
    const j = journal(fakeClock());
    const a: number[] = [];
    const b: number[] = [];
    const stopA = j.watch(undefined, (e) => a.push(e.seq));

    j.watch(undefined, () => {
      throw new Error('gone');
    });
    j.watch(undefined, (e) => b.push(e.seq));
    j.emit('command.ran', ran);
    stopA();
    j.emit('command.ran', ran);

    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
    expect(j.watchers()).toBe(1);
  });
});
