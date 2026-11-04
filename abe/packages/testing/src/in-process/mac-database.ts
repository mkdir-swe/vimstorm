/**
 * An in-memory Mac database for a `serve`'s prototypes and local sessions. It makes each name
 * once and says `made` the first time. `drop` drops it, except while Docker is down. `docker` says
 * up, down or missing as set. `broken` makes `ensure` fail as the container's own failure.
 */
import { type MacDatabase } from '@abe/core';

export type FakeMacDatabase = MacDatabase & {
  /** Docker as the next call finds it. */
  at: 'up' | 'down' | 'missing';
  /** What the container says when it fails after Docker answered, a `mac` failure. */
  broken: string | undefined;
  /** The databases there now. */
  dbs: Set<string>;
  /** Every `ensure` and `drop`, oldest first. */
  calls: string[];
};

/** The URL a fake database is reached on. */
export const fakeDbUrl = (name: string): string =>
  `postgresql://${name}:pw@127.0.0.1:55432/${name}`;

export const fakeMacDatabase = (at: FakeMacDatabase['at'] = 'up'): FakeMacDatabase => {
  const fake: FakeMacDatabase = {
    at,
    broken: undefined,
    dbs: new Set(),
    calls: [],
    ensure: (name, repo) => {
      fake.calls.push(`ensure ${name}`);
      if (fake.at !== 'up')
        return Promise.resolve({
          ok: false,
          failure: { kind: fake.at === 'down' ? 'docker-down' : 'no-docker', repo },
        });
      if (fake.broken !== undefined)
        return Promise.resolve({ ok: false, failure: { kind: 'mac', said: fake.broken } });
      const made = !fake.dbs.has(name);

      fake.dbs.add(name);

      return Promise.resolve({ ok: true, url: fakeDbUrl(name), made });
    },
    drop: (name) => {
      fake.calls.push(`drop ${name}`);
      if (fake.at === 'down') return Promise.resolve({ ok: false, said: "Docker isn't running" });
      fake.dbs.delete(name);

      return Promise.resolve({ ok: true });
    },
    docker: () => Promise.resolve(fake.at),
  };

  return fake;
};
