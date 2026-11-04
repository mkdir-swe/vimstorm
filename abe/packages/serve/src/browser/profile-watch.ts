/**
 * A browser profile's Chrome on this Mac, watched while it is open, so its sign-ins reach your
 * store without `abe browser store` (the boxes restore them from there). Chrome keeps them in its
 * own folder across quits; the store is the copy. Chrome cannot be read once it has quit, so the
 * watch reads it while it runs: every `every` ms its cookies alone, never a tab opened (local
 * storage takes a setup tab per origin, and a page those load sets new cookies: read on every
 * sign-in it opened tabs without end). Local storage reaches the store only by `abe browser
 * store`. A sign-in (a cookie name new since the last store, the same for two readings) is
 * stored at once; the cookies as last read are stored when it closes, unless they are what was
 * stored. Nothing here deletes or writes the Chrome folder,
 * so a store that fails leaves it whole. No store reached: no reading, nothing stored, quietly.
 */
import {
  type Answered,
  type Chrome,
  type Clock,
  type EventData,
  type ProfileStore,
  type SignIns,
  type StorageState,
  stateText,
  storageState,
} from '@abe/core';

/** How often an open profile's Chrome is read. */
export const PROFILE_WATCH_MS = 5_000;

/** A failure of the store that means no store is set up for you: skipped, never said. */
const NOT_SET_UP = new Set(['no-person', 'no-profile-store']);

/** `signIns` written as profile `name`'s stored copy, dated now. */
export const storeSignIns = async (
  store: ProfileStore,
  name: string,
  signIns: SignIns,
  now: number,
): Promise<Answered<{ secret: string; state: StorageState; bytes: number }>> => {
  const state = storageState(signIns, new Date(now).toISOString());
  const text = stateText(state);

  if (!text.ok) return { ok: false, error: { code: 'profile-too-large', message: text.message } };
  const written = await store.write(name, text.text);

  if (!written.ok) return written;

  return {
    ok: true,
    data: {
      secret: written.data.secret,
      state,
      bytes: new TextEncoder().encode(text.text).length,
    },
  };
};

export type ProfileWatch = {
  /** Watches the Chrome on `dir` as profile `name` until it closes; one watched already stays. */
  watch: (name: string, dir: string) => void;
  /** Why the last store of `name` on its own failed; `null`: none did, or it stored since. */
  failed: (name: string) => string | null;
  /** One reading of every watched Chrome now (tests; the timer does the same). */
  tick: () => Promise<void>;
  close: () => void;
};

type Watched = {
  dir: string;
  /** The cookie names the last store wrote, or the first reading's ('' before it). */
  storedNames: string | undefined;
  /** The previous reading's cookie names: a sign-in is stored once they hold still. */
  seenNames: string | undefined;
  /** What a store writes now: the cookies as last read (no local storage). */
  latest: SignIns | undefined;
  /** What the last store wrote (its sign-ins as JSON), so the same is never written twice. */
  stored: string | undefined;
};

const namesOf = (s: SignIns) =>
  [...new Set(s.cookies.map((c) => `${c.domain} ${c.name}`))].sort().join('\n');

export const startProfileWatch = (o: {
  chrome: Chrome;
  store: ProfileStore | undefined;
  clock: Clock;
  every: number;
  emit: (data: EventData<'browser.profile'>) => void;
}): ProfileWatch => {
  const watched = new Map<string, Watched>();
  const failures = new Map<string, string>();
  let ticking: Promise<void> | undefined;

  const save = async (name: string, w: Watched) => {
    const latest = w.latest;

    if (latest === undefined || o.store === undefined) return;
    const key = JSON.stringify(latest);

    if (key === w.stored) return;
    const done = await storeSignIns(o.store, name, latest, o.clock.now());

    if (done.ok) {
      w.stored = key;
      failures.delete(name);
      o.emit({ name, state: 'stored' });

      return;
    }
    // no store set up for you: the folder keeps them, nothing to say
    if (NOT_SET_UP.has(done.error.code)) return;
    failures.set(name, done.error.message);
    o.emit({ name, state: 'store-failed', message: done.error.message });
  };

  const step = async (name: string, w: Watched) => {
    const endpoint = await o.chrome.running(w.dir);

    if (endpoint === undefined) {
      watched.delete(name);
      await save(name, w);
      o.emit({ name, state: 'closed' });

      return;
    }
    if (o.store === undefined) return;
    const read = await o.chrome.read(endpoint, { cookiesOnly: true });

    // not read this once (Chrome busy, quitting): the next reading tries again
    if (!read.ok) return;
    const names = namesOf(read.data);
    const still = names === w.seenNames;

    w.seenNames = names;
    w.latest = { cookies: read.data.cookies, origins: [] };
    // first seen: what it holds already is no sign-in
    if (w.storedNames === undefined) {
      w.storedNames = names;

      return;
    }
    if (names !== w.storedNames && still) {
      w.storedNames = names;
      await save(name, w);
    }
  };

  const readAll = async () => {
    for (const [name, w] of [...watched]) await step(name, w).catch(() => undefined);
  };
  const tick = (): Promise<void> => {
    // one reading at a time: a tick while one runs waits for it
    if (ticking !== undefined) return ticking;
    const run = readAll().finally(() => {
      ticking = undefined;
    });

    ticking = run;

    return run;
  };
  const timer = setInterval(() => void tick(), o.every);

  return {
    watch: (name, dir) => {
      if (watched.get(name)?.dir === dir) return;
      watched.set(name, {
        dir,
        storedNames: undefined,
        seenNames: undefined,
        latest: undefined,
        stored: undefined,
      });
      o.emit({ name, state: 'open' });
    },
    failed: (name) => failures.get(name) ?? null,
    tick,
    close: () => {
      clearInterval(timer);
    },
  };
};
