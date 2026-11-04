/**
 * Live facts as a host holds them (the bridge, `abe ui render`, the screen driver): mounted once,
 * fed the watch, the shown folder, the clock and its own reads' answers, its facts handed to every
 * screen open.
 */
import type { Command, Input, Screen } from '../runtime/runtime';
import {
  type Facts,
  answersLive,
  LIVE_EVENTS,
  LIVE_INIT,
  LIVE_READS,
  type LiveInput,
  type LiveRead,
  type LiveState,
  liveStep,
} from './facts';

export type MountedLive = {
  readonly facts: Facts;
  /** One input; the reads it asks for (`run` commands, answered back as `result` inputs). */
  readonly send: (input: LiveInput) => Command[];
  /** Whether one of `reads` is out: a screen opened anew after a break waits for it. */
  readonly reading: (reads: readonly LiveRead[]) => boolean;
};

export const mountLive = (): MountedLive => {
  let state = LIVE_INIT;

  return {
    get facts() {
      return state.facts;
    },
    send: (input) => {
      const next = liveStep(state, input);

      state = next.state;

      return next.commands;
    },
    reading: (reads) => reads.some((r) => state.facts.read[r].reading),
  };
};

/** A screen with live facts of its own: what `withLive` holds. */
export type Livened<S> = {
  screen: S;
  live: LiveState;
  /** The facts' rev the screen was last handed. */
  handed: number;
  /** The reads it followed last, as told to live. */
  followed: string;
};

type Stepped<S> = { state: Livened<S>; commands: Command[] };

/**
 * `screen` with its own live facts inside, as the bridge would feed them: what a host with one
 * screen mounts (`abe ui render`, a test). The watch, the clock and the shown folder reach live
 * first; live's reads' answers go to live alone; the screen's `live` commands and the reads it
 * follows go to live, and it is handed the facts each time they moved.
 */
export const withLive = <S>(screen: Screen<S>): Screen<Livened<S>> => {
  /** Live stepped on `input`, the screen handed what moved, until neither asks live more. */
  const settle = (st: Livened<S>, own: readonly Command[]): Stepped<S> => {
    let next = st;
    const commands: Command[] = [];
    let queue = [...own];

    for (let round = 0; round < 64; round += 1) {
      const toLive: LiveInput[] = [];

      for (const c of queue) {
        if (c.kind === 'live') toLive.push({ kind: 'reread', reads: c.reads, ran: c.ran });
        else commands.push(c);
      }
      const reads = LIVE_READS.filter((r) => (screen.follows?.(next.screen) ?? []).includes(r));
      const said = reads.join(' ');

      if (said !== next.followed) {
        next = { ...next, followed: said };
        toLive.unshift({ kind: 'follow', reads });
      }
      for (const input of toLive) {
        const l = liveStep(next.live, input);

        next = { ...next, live: l.state };
        commands.push(...l.commands);
      }
      if (next.live.facts.rev === next.handed) return { state: next, commands };
      const handed = screen.step(next.screen, { kind: 'live', facts: next.live.facts });

      next = { ...next, screen: handed.state, handed: next.live.facts.rev };
      queue = handed.commands;
    }

    return { state: next, commands };
  };
  const step = (st: Livened<S>, input: Input): Stepped<S> => {
    const liveOnly = input.kind === 'result' && answersLive(st.live, input.id);
    const first =
      liveOnly || input.kind === 'event' || input.kind === 'tick' || input.kind === 'root'
        ? liveStep(st.live, input)
        : { state: st.live, commands: [] };
    // (a screen opened is told the facts after its `open`, as the bridge mounts it)
    const fed =
      input.kind === 'open'
        ? { state: { ...st, live: first.state }, commands: [] }
        : settle({ ...st, live: first.state }, []);

    if (liveOnly) return { state: fed.state, commands: [...first.commands, ...fed.commands] };
    // an event the screen does not follow: live took it, the screen never sees it
    if (input.kind === 'event' && !screen.events.has(input.event.type))
      return { state: fed.state, commands: [...first.commands, ...fed.commands] };
    const own = screen.step(fed.state.screen, input);
    const after = settle({ ...fed.state, screen: own.state }, own.commands);

    return {
      state: after.state,
      commands: [...first.commands, ...fed.commands, ...after.commands],
    };
  };
  const init: Livened<S> = { screen: screen.init, live: LIVE_INIT, handed: -1, followed: '' };
  const keep = screen.keep;

  return {
    name: screen.name,
    init,
    step: (st, input) => {
      // the shown folder first, as the bridge's `hello` says it: where live reads
      const root = input.kind === 'open' ? input.params.root : undefined;
      const rooted =
        root === undefined || root === st.live.root
          ? st
          : { ...st, live: liveStep(st.live, { kind: 'root', root }).state };

      return step(rooted, input);
    },
    view: (st) => screen.view(st.screen),
    // (the watch reaches live whatever the screen takes: `step` hands the screen its own)
    events: new Set([...screen.events, ...LIVE_EVENTS]),
    ...(screen.words === undefined ? {} : { words: screen.words }),
    ...(screen.linked === undefined
      ? {}
      : { linked: (st: Livened<S>) => screen.linked?.(st.screen) }),
    ...(screen.typing === undefined
      ? {}
      : { typing: (st: Livened<S>) => screen.typing?.(st.screen) === true }),
    ...(keep === undefined
      ? {}
      : { keep: (st: Livened<S>) => ({ ...st, screen: keep(st.screen) }) }),
    ...(screen.seconds === undefined
      ? {}
      : { seconds: (st: Livened<S>) => screen.seconds?.(st.screen) === true }),
    ...(screen.opensOnMainCard === undefined ? {} : { opensOnMainCard: screen.opensOnMainCard }),
    ...(screen.here === undefined
      ? {}
      : { here: (st: Livened<S>) => screen.here?.(st.screen) ?? {} }),
  };
};
