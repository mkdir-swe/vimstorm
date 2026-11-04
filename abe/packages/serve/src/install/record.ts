/**
 * Each checkout's install record, one owner per checkout in a serve: a change loads the record,
 * moves it and saves it only after every change asked before it is saved, so two changes never
 * lose one another's update. What a change needs read is read before it, on the record as it
 * was; the change itself is the move. The sign-ins serve runs for the checkout's sources are
 * state of their own here, never on the record: one at a time per source, and how one from
 * Settings ended, kept for its row.
 */
import { Install, type InstallRepo, type InstallStore, type SourceCheck } from '@abe/core';

/** The install's ports: the checkout's local reads and where the records are kept. */
export type InstallPorts = { repo: InstallRepo; store: InstallStore };

/** What a change gives: its answer, the record to save (none: nothing saved) and what is said once it is. */
export type Changed<T> = { out: T; save?: Install; saved?: () => void };

/** A source's sign-in as serve runs it: running, or how one from Settings ended. */
export type SignIn = 'signing-in' | SourceCheck;

/** One checkout's install record. */
export type InstallRecord = {
  /** The record as kept now; none kept, or one that does not parse: undefined. */
  read: () => Promise<Install | undefined>;
  /** `change` on the record as kept once every change asked before it is saved; its record saved. */
  change: <T>(change: (i: Install | undefined) => Promise<Changed<T>>) => Promise<T>;
  /** The record moved aside, in turn with the changes (`InstallStore.aside`). */
  aside: (at: string) => ReturnType<InstallStore['aside']>;
  /** Source `id`'s sign-in: running, how one from Settings ended, or none. */
  signIn: (id: string) => SignIn | undefined;
  /**
   * `run` started as source `id`'s sign-in, unless one runs for it (undefined then): done once
   * its end is kept for the source's row (none given, or a throw: nothing kept).
   */
  startSignIn: (
    id: string,
    run: () => Promise<SourceCheck | undefined>,
  ) => Promise<void> | undefined;
};

/** A serve's install records: the ports, and each checkout's record by its top folder. */
export type InstallRecords = InstallPorts & { at: (top: string) => InstallRecord };

const recordOf = (store: InstallStore, top: string): InstallRecord => {
  let last: Promise<unknown> = Promise.resolve();
  const signIns = new Map<string, SignIn>();
  const inTurn = <T>(f: () => Promise<T>): Promise<T> => {
    const run = last.then(f);

    last = run.catch(() => undefined);

    return run;
  };
  const read = async () => Install.safeParse(await store.read(top)).data;

  return {
    read,
    change: (change) =>
      inTurn(async () => {
        const c = await change(await read());

        if (c.save !== undefined) await store.write(top, c.save);
        c.saved?.();

        return c.out;
      }),
    aside: (at) => inTurn(() => store.aside(top, at)),
    signIn: (id) => signIns.get(id),
    startSignIn: (id, run) => {
      if (signIns.get(id) === 'signing-in') return undefined;
      signIns.set(id, 'signing-in');

      return run().then(
        (ended) => {
          if (ended === undefined) signIns.delete(id);
          else signIns.set(id, ended);
        },
        () => {
          signIns.delete(id);
        },
      );
    },
  };
};

/** A serve's install records over its ports: one owner per checkout for as long as it runs. */
export const installRecords = (ports: InstallPorts): InstallRecords => {
  const records = new Map<string, InstallRecord>();

  return {
    ...ports,
    at: (top) => {
      const had = records.get(top);

      if (had !== undefined) return had;
      const made = recordOf(ports.store, top);

      records.set(top, made);

      return made;
    },
  };
};
