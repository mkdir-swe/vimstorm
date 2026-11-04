/**
 * A Factory run's checks (ticket #46): `serve` runs them itself in the run's worktree once build
 * says it is done, before any review, and again on `abe factory checks`. The settings in force in
 * the run's checkout say which (never its worktree's, which the agent writes): each `checks`
 * command in order, then the built-ins on the diff against the merge base (`testFiles` says what
 * a test is); they run in the worktree. Every result is written to
 * `.scratch/<card>/checks.md` (`.scratch/` is git-excluded where Abe makes worktrees) and sent as
 * `factory.checks`. A check no Layer gives a command is not configured; none with one ran (a
 * repo with no pack) is `none`, never green (#159). What the result does to the run is the
 * factory's (`factory.ts`).
 */
import { join } from 'node:path';
import {
  type BaseDiff,
  builtInCheck,
  CHECK_TIMEOUT_MS,
  checkEntries,
  type CheckResult,
  checksEvent,
  checksFile,
  checksMarkdown,
  checksPlan,
  checksVerdict,
  type ChecksCause,
  type Clock,
  coreDefaults,
  type EventData,
  type FactoryChecksData,
  notConfiguredOutput,
  type Outcome,
  refused,
  type Run,
  WORKSPACE_DATABASE,
  type RunTree,
  type ByCard,
  withoutAnsi,
  injectedSecrets,
  type KnownSecret,
  redactText,
  type ChecksEnv,
} from '@abe/core';
import { checkoutOf, type SettingsService } from '../layer/settings';

/**
 * A run of checks, and what its commands ran with by name only (never a value): the Abe env
 * file's environment put over them, and the variables they got; null when no command ran.
 */
export type ChecksRan = FactoryChecksData & { env: ChecksEnv | null };

/** A run's checks, run now in its worktree. */
export type Checks = (run: Run, cause: ChecksCause) => Promise<Outcome<ChecksRan>>;

export type ChecksOptions = {
  settings: Pick<SettingsService, 'at'> | undefined;
  /**
   * Where the worktree is and a command runs, by the run's card: on this machine with `serve`'s
   * `HOME`, `PATH` and locale only (`checksEnv`), or in its box workspace's container with the
   * workspace's own.
   */
  tree: ByCard<RunTree>;
  clock: Clock;
  emit: (data: EventData<'factory.checks'>) => void;
  /** How long one command may run (default `CHECK_TIMEOUT_MS`). */
  timeoutMs?: number;
  /**
   * A local run's session database: its `DATABASE_URL` for the commands, as the session has it,
   * over the checks' Abe env file's (in dev only); undefined for none (then that file's, if any,
   * never serve's own).
   */
  database?: (run: Run) => Promise<string | undefined>;
  /**
   * The `NODE_OPTIONS` the repo's CI gives its jobs (`ciNodeOptions`, read in the run's checkout,
   * never its worktree), so a test runner has the memory it has there; null: none.
   */
  nodeOptions?: (run: Run) => string | null;
  /**
   * The run's checks environment (ADR 0028, `checksEnvOf`): its Abe env file's values and its aws
   * profile's keys; why not (an expired aws login). Their values are redacted from what the
   * checks say. None: nothing.
   */
  injected?: (run: Run) => Promise<Outcome<Record<string, string>>>;
  /** The Abe environment whose env file `injected` gives (`dev`); none: null. Its name only. */
  envName?: (run: Run) => Promise<string | null>;
  /**
   * The values to redact from what the checks say besides those they got: every Abe env file's
   * in the run's checkout. None: only their own.
   */
  redacted?: (run: Run) => Promise<readonly KnownSecret[]>;
};

/**
 * The settings keys checks read. Their problems (an entry refused for want of an Override) and
 * any Override in force are shown. They are read in the run's checkout, as `autoMerge` is: the
 * worktree's repo Layer is the agent's to edit, so it could lower its own checks.
 */
const KEYS = ['checks', 'testFiles'] as const;

export const repoChecks =
  (o: ChecksOptions): Checks =>
  async (run, cause) => {
    if (!(await o.tree(run.card).exists(run.worktree)))
      return refused('no-worktree', `AB#${run.card}'s worktree is gone: ${run.worktree}`);
    const merged = o.settings?.at(checkoutOf(run));
    const values = merged?.values ?? coreDefaults();
    let diff: Promise<BaseDiff> | undefined;
    const results: CheckResult[] = [];
    const database = await o.database?.(run);
    const nodeOptions = o.nodeOptions?.(run) ?? null;
    const injected = (await o.injected?.(run)) ?? { ok: true as const, data: {} };

    if (!injected.ok) return injected;
    const secrets = [...injectedSecrets(injected.data), ...((await o.redacted?.(run)) ?? [])];
    const env = {
      ...injected.data,
      ...(database === undefined ? {} : { [WORKSPACE_DATABASE]: database }),
      ...(nodeOptions === null ? {} : { NODE_OPTIONS: nodeOptions }),
    };

    /** The names the commands got, as the tree said; else the ones serve put over its env. */
    let keys: readonly string[] | undefined;
    let ranCommand = false;

    for (const step of checksPlan(checkEntries(values.checks))) {
      const started = o.clock.now();
      const took = () => Math.max(0, Math.round(o.clock.now() - started));

      if (step.kind === 'no-run')
        results.push({
          name: step.name,
          kind: 'command',
          run: null,
          status: 'not-configured',
          exit: null,
          durationMs: 0,
          output: notConfiguredOutput(step.name),
        });
      else if (step.kind === 'command') {
        const ran = await o.tree(run.card).shell({
          run: step.run,
          cwd: run.worktree,
          timeoutMs: o.timeoutMs ?? CHECK_TIMEOUT_MS,
          ...(Object.keys(env).length === 0 ? {} : { env }),
        });

        ranCommand = true;
        keys ??= ran.keys;
        results.push({
          name: step.name,
          kind: 'command',
          run: step.run,
          status: ran.exit === 0 ? 'green' : 'red',
          exit: ran.exit,
          durationMs: took(),
          // a tool's colours (vitest's, CI=true or not) are no markdown to read (#187)
          output: redactText(withoutAnsi(ran.output), secrets),
        });
      } else {
        diff ??= o.tree(run.card).diff(run.worktree);
        const found = builtInCheck(step.name, await diff, values.testFiles);

        results.push({
          name: step.name,
          kind: 'built-in',
          run: null,
          exit: null,
          durationMs: took(),
          ...found,
        });
      }
    }
    const verdict = checksVerdict(results);
    const data: FactoryChecksData = {
      card: run.card,
      session: run.session,
      worktree: run.worktree,
      green: verdict === 'green',
      none: verdict === 'none',
      cause,
      file: join(run.worktree, checksFile(run.card)),
      settings: [
        ...(merged?.problems ?? [])
          .filter((p) => KEYS.some((k) => k === p.key))
          .map((p) => p.message),
        ...KEYS.flatMap((k) => {
          const lowered = merged?.explain(k).lowered ?? null;

          return lowered === null ? [] : [`${k} ${lowered}`];
        }),
      ],
      results,
    };

    const wrote = await o
      .tree(run.card)
      .write(run.worktree, data.file, checksMarkdown(data, new Date(o.clock.now()).toISOString()));

    if (!wrote.ok) return refused(wrote.error.code, wrote.error.message);
    o.emit(checksEvent(data));
    if (!ranCommand) return { ok: true, data: { ...data, env: null } };
    // an Abe env file put over the checks' own: its environment, by name
    const name =
      Object.keys(injected.data).length === 0 ? null : ((await o.envName?.(run)) ?? null);
    const given = keys ?? [...new Set(['CI', ...Object.keys(env)])].sort();

    return { ok: true, data: { ...data, env: { name, keys: [...given] } } };
  };
