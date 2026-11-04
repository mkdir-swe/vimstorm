/**
 * Factory install's fakes: the checkout's real files and git (a test's disposable repo), the
 * records in the test's state, and a URL answers only when the test said so (`answering`). AWS and
 * Claude Code's MCP servers are never asked: a profile is the account `accounts` names,
 * this Mac's aws profiles are `profiles`, an MCP server is as `mcp` says (none by default) and
 * signed in as `sourceAccounts` says (none told); a server added (`claude mcp add`) is kept in
 * `added` and needs auth.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CheckoutFiles,
  type FoundServer,
  type Install,
  INSTALL_PARTS,
  type InstallRepo,
  type InstallStore,
  type McpState,
  newInstall,
  parseEnvFile,
  type SignInResult,
  type SourceAccount,
  type SourceProbeRead,
} from '@abe/core';
import { fileInstallStore, localInstallRepo } from '@abe/ports';
import { type Held, held } from '../held';

/** How a check serve ran ended. */
type CheckEnd = { exit: number | null; output: string; timedOut?: boolean };

export type InstallFakes = {
  repo: InstallRepo;
  store: InstallStore;
  answering: Set<string>;
  /** Each abe-* profile's account id, as `aws sts get-caller-identity` would say it. */
  accounts: Map<string, string>;
  /** This Mac's aws profiles, as `aws configure list-profiles` names them (none by default). */
  profiles: string[];
  /** Each MCP server's state for the person. */
  mcp: Map<string, McpState>;
  /** The servers the person's Claude Code has for the checkout (`abe install sources`): none by default. */
  found: FoundServer[];
  /** What each MCP server tells of its account. */
  sourceAccounts: Map<string, SourceAccount>;
  /** Each server asked who it is signed in as, in order, with the model asked. */
  accountAsks: { name: string; model: string }[];
  /** Each source's probe read: `ok` unless said (the account can't read: `tool-error`). */
  probes: Map<string, SourceProbeRead>;
  /** Each sign-in's end: signed in unless said; signed in, its server is connected. */
  signIns: Map<string, SignInResult>;
  /** Each server a sign-in was started for, in order. */
  signInAsks: string[];
  /**
   * The servers whose sign-in stays open (the person still in their browser) until the test
   * answers it on `signInHeld`; signed in, its server is connected.
   */
  holdSignIns: Set<string>;
  signInHeld: Held<string, SignInResult>;
  /** An aws profile whose login expired → what aws said; any other gives fake short-lived keys. */
  expired: Map<string, string>;
  /** Read's checks that fail on a clean main: a fragment of the command → what it said. */
  failingChecks: Map<string, string>;
  /**
   * Each check serve ran in a checkout (`abe install try`, a part's check), in order: its command, its folder,
   * and the environment it got (the values too: a test's fakes only).
   */
  checkRuns: { top: string; run: string; env: Record<string, string> }[];
  /** A check's end by a fragment of its command (exit 0 and no output unless said). */
  checkEnds: Map<string, CheckEnd>;
  /**
   * The fragments of commands whose check stays running until the test answers it on
   * `checkHeld` (by its whole command).
   */
  holdChecks: Set<string>;
  checkHeld: Held<string, CheckEnd>;
  /** Each server the install added to a checkout's local scope, in order. */
  added: { top: string; name: string; transport: 'http' | 'sse'; url: string }[];
  /** A server whose `claude mcp add` fails → what it said. */
  addFails: Map<string, string>;
};

export const installFakes = (o: {
  env: Readonly<Record<string, string | undefined>>;
  dir: string;
  answering?: readonly string[];
}): InstallFakes => {
  const answering = new Set(o.answering ?? []);
  const accounts = new Map<string, string>();
  const profiles: string[] = [];
  const mcp = new Map<string, McpState>();
  const found: FoundServer[] = [];
  const sourceAccounts = new Map<string, SourceAccount>();
  const accountAsks: InstallFakes['accountAsks'] = [];
  const probes = new Map<string, SourceProbeRead>();
  const signIns = new Map<string, SignInResult>();
  const signInAsks: string[] = [];
  const holdSignIns = new Set<string>();
  const signInHeld = held<string, SignInResult>('signInMcp');
  const expired = new Map<string, string>();
  const failingChecks = new Map<string, string>();
  const checkRuns: InstallFakes['checkRuns'] = [];
  const checkEnds: InstallFakes['checkEnds'] = new Map();
  const holdChecks = new Set<string>();
  const checkHeld = held<string, CheckEnd>('runCheck');
  const added: InstallFakes['added'] = [];
  const addFails = new Map<string, string>();
  const real = localInstallRepo({ env: o.env });

  return {
    repo: {
      ...real,
      answers: (url) => Promise.resolve(answering.has(url)),
      awsAccount: (profile) => {
        const account = accounts.get(profile);

        return Promise.resolve(
          account === undefined
            ? { cannot: `aws could not say who ${profile} is: abe login aws --profile ${profile}` }
            : { account },
        );
      },
      awsProfiles: () => Promise.resolve([...profiles]),
      runChecks: (_, commands) =>
        Promise.resolve(
          commands.map((command) => {
            const says = [...failingChecks].find(([fragment]) => command.includes(fragment))?.[1];

            return { ok: says === undefined, says: says ?? '' };
          }),
        ),
      runCheck: async (top, c) => {
        checkRuns.push({ top, run: c.run, env: { ...c.env } });
        const end = [...holdChecks].some((fragment) => c.run.includes(fragment))
          ? await checkHeld.call(c.run)
          : [...checkEnds].find(([fragment]) => c.run.includes(fragment))?.[1];

        return {
          exit: end?.exit ?? 0,
          output: end?.output ?? '',
          timedOut: end?.timedOut ?? false,
        };
      },
      mcp: (_, name) => Promise.resolve(mcp.get(name) ?? 'none'),
      // the person's own servers: each one the fake answers for, but none
      ownMcpServers: () =>
        Promise.resolve([...mcp].filter(([, state]) => state !== 'none').map(([name]) => name)),
      mcpFound: () => Promise.resolve([...found]),
      // a server added: kept, and needing the person's sign-in (or failing, as `addFails` says)
      addMcp: (top, server) => {
        const why = addFails.get(server.name);

        if (why !== undefined) return Promise.resolve({ ok: false as const, why });
        added.push({ top, ...server });
        mcp.set(server.name, 'needs-auth');

        return Promise.resolve({ ok: true as const });
      },
      sourceAccount: (_, name, model) => {
        accountAsks.push({ name, model });

        return Promise.resolve({
          read: probes.get(name) ?? 'ok',
          account: sourceAccounts.get(name) ?? {},
        });
      },
      awsCredentials: (profile) => {
        const why = expired.get(profile);

        return Promise.resolve(
          why === undefined
            ? {
                ok: true as const,
                env: {
                  AWS_ACCESS_KEY_ID: `fake-id-${profile}`,
                  AWS_SECRET_ACCESS_KEY: `fake-secret-${profile}`,
                  AWS_SESSION_TOKEN: `fake-token-${profile}`,
                },
              }
            : { ok: false as const, why },
        );
      },
      signInMcp: async (_, name) => {
        signInAsks.push(name);
        const r = holdSignIns.has(name)
          ? await signInHeld.call(name)
          : (signIns.get(name) ?? { signedIn: true as const });

        if (r.signedIn) mcp.set(name, 'connected');

        return r;
      },
    },
    store: fileInstallStore(join(o.dir, 'installs')),
    answering,
    accounts,
    profiles,
    mcp,
    found,
    sourceAccounts,
    accountAsks,
    probes,
    signIns,
    signInAsks,
    holdSignIns,
    signInHeld,
    expired,
    failingChecks,
    checkRuns,
    checkEnds,
    holdChecks,
    checkHeld,
    added,
    addFails,
  };
};

/**
 * A checkout's files in memory (path from its top → text), as Read reads them: `list` gives a
 * folder's names (files and folders), `.` the top's; `grep` searches every one, as git's would
 * those it tracks; `envKeys` an env file's key names, as serve reads them.
 */
export const checkoutFiles = (files: Readonly<Record<string, string>>): CheckoutFiles => ({
  read: (path) => Promise.resolve(files[path]),
  envKeys: (path) => {
    const text = files[path];

    return Promise.resolve(text === undefined ? undefined : [...parseEnvFile(text).keys()]);
  },
  grep: (pattern, max) => {
    const re = new RegExp(pattern, 'i');

    return Promise.resolve(
      Object.entries(files)
        .flatMap(([path, text]) =>
          text.split('\n').flatMap((t, n) => (re.test(t) ? [{ path, line: n + 1, text: t }] : [])),
        )
        .slice(0, max),
    );
  },
  list: (dir) => {
    const prefix = dir === '.' || dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
    const names = Object.keys(files)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length).split('/')[0] ?? '');

    return Promise.resolve([...new Set(names)].filter((n) => n !== ''));
  },
});

/**
 * The checkout's install done (Local only, every part passing), in the records of Abe's state at
 * `stateDir`: a Mac's serve then starts cards there.
 */
const AT = '2026-10-27T09:00:00.000Z';

export const installDone = async (
  stateDir: string,
  repo: string,
  more: Partial<Install> = {},
): Promise<void> => {
  const top = realpathSync(repo);

  await fileInstallStore(join(stateDir, 'installs')).write(top, {
    ...newInstall(top, AT),
    parts: Object.fromEntries(
      INSTALL_PARTS.map((p) => [p, { state: 'pass', line: 'passed', checkedAt: AT }]),
    ),
    finishedAt: AT,
    ...more,
  });
};
