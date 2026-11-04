/**
 * Factory install (#22, #71, ADR 0011): one unjailed Chat session per repo that sets the repo up
 * for the Factory, while the person is there. No stage machine: a set of parts a set-up repo has
 * (`INSTALL_PARTS`), each checked by serve on request (`abe install check <part>`) from the files,
 * the settings and live reads, its last check recorded (`parts`). The agent chooses the order and
 * comes back to any part; the install is Done once every required part passes (or warns). Pure:
 * `moveInstall(install, move, at)` records what serve read or was told, never gating it; serve
 * keeps the record and runs the IO.
 *
 * - The team's parts write `abe.yaml`, `abe/` (Abe's workflows and skills, copied in once, ADR 0033)
 *   and `.claude/skills/`, ordinary files the person commits;
 *   `.abe/` is the person's alone, kept out of git.
 * - A join (`join`): the repo had an `abe.yaml` when the install began, a teammate's. Only the
 *   personal parts are the person's to do then; a team part that fails warns.
 * - Sources (ADR 0027), optional: each source Read found is added or skipped; an added one reads
 *   once signed in.
 * - Prototype, optional (a repo with no web app leaves it): the prototype-start hook starts
 *   the app for a prototype, proven step by step (`install-prototype.ts`).
 */
import { z } from 'zod';
import { Connection, type ConnectionFact, MCP_STATES, type McpState } from './install-connection';
import { CheckProof, checkKey } from './install-check';
import { GateResult, NotUsed } from './install-gate';
import { BoardWhere, ReadFindings } from './install-read';
import { SourceProbeRead } from './source-sign-in';
import { signInRefusalWords } from './source-tools';
import { type FoundSource, SOURCE_NAME, sourceOffer, sourceUrlOk } from './install-sources';
import { RepoKindSaid } from './install-kind';
import { PrototypeTry } from './install-prototype';
import { refused, type Outcome } from '../command';
import { AbeEnv, ABE_ENVS, AwsProfileName, DEFAULT_CHECKS_ENV, isAbeEnvFile } from './credentials';
import { ciKeysOk, type EnvFileMapped, envFileSpec, EnvMapping, isOldEnvCopy } from './env-prefill';
import { type EnvPlace, envPlacement, type WorktreeRecipe } from '../session/worktree-recipe';

/** The parts a set-up repo has, in the order the install hints at; all required but Sources and Prototype. */
export const INSTALL_PARTS = [
  'logins',
  'board',
  'sources',
  'env-files',
  'worktree',
  'checks',
  'workflows',
  'skills',
  'verify',
  'prototype',
  'done',
] as const;
export const InstallPart = z.enum(INSTALL_PARTS);
export type InstallPart = z.infer<typeof InstallPart>;

/** The install session's one skill (`core/skills/install/SKILL.md`). */
export const INSTALL_SKILL = 'install';

/** A part's reference, which the install skill loads for it: `references/<part>.md` beside it. */
export const partReference = (part: InstallPart): string =>
  `skills/${INSTALL_SKILL}/references/${part}.md`;

/**
 * One row per part: its title, when it passes, whether Done waits on it, and whether it is the
 * team's (`abe.yaml`, `.claude/skills/`: a join warns on it) or the person's own.
 */
export const INSTALL_PART_TABLE: Readonly<
  Record<
    InstallPart,
    {
      title: string;
      /** When it passes, as the person reads it. */
      passes: string;
      required: boolean;
      team: boolean;
    }
  >
> = {
  logins: {
    title: 'Logins',
    passes:
      'every tool the repo needs answers (az only for an Azure board), GitHub and the cloud read live',
    required: true,
    team: false,
  },
  board: {
    title: 'Board',
    passes: 'abe.yaml names a board that reads live, with who merges and where specs go',
    required: true,
    team: true,
  },
  sources: {
    title: 'Sources',
    passes: 'every source found is added or skipped, and each added one reads live',
    required: false,
    team: true,
  },
  'env-files': {
    title: 'Env files',
    passes:
      "abe.yaml places each of the repo's env files (worktree groups, env.notUsed), the three Abe env files exist, and each environment has an aws profile or none",
    required: true,
    team: true,
  },
  worktree: {
    title: 'Worktree',
    passes:
      "abe.yaml's worktree: recipe gives a new worktree what the checks and the app need from the main checkout (its files there, its script passing)",
    required: true,
    team: true,
  },
  checks: {
    title: 'Checks',
    passes: 'every check in checks: passes as serve runs it',
    required: true,
    team: true,
  },
  workflows: {
    title: 'Workflows',
    passes: "abe/ holds the repo's workflows and Abe's skills, copied in from Abe once",
    required: true,
    team: true,
  },
  skills: {
    title: 'Skills',
    passes: "the repo's testing skill and its CLAUDE.md are written",
    required: true,
    team: true,
  },
  verify: {
    title: 'Verify',
    passes:
      "the app ran and the gate passed (or nothing runs here, or it can't run here), the Verification pack is written and proven, and the checks pass again",
    required: true,
    team: true,
  },
  prototype: {
    title: 'Prototype',
    passes:
      "the repo's prototype-start script (abe/scripts/prototype-start unless abe.yaml's hooks say) starts the app on its port base, its page loads (signed in when it says so) and a screenshot is kept, or nothing runs here",
    required: false,
    team: true,
  },
  done: {
    title: 'Done',
    passes: 'every required part passes; its line names the files to commit',
    required: true,
    team: false,
  },
};

/**
 * A part's last check: passes; fails; warns (a team part failing on a join, a live read's
 * warning): Done goes on; todo, never checked.
 */
export const PART_STATES = ['pass', 'fail', 'todo', 'warn'] as const;
export const PartState = z.enum(PART_STATES);
export type PartState = z.infer<typeof PartState>;

/**
 * A part's last check: its state with its line (one sentence: what passed, or what is missing and
 * the fix) and when; todo, never checked. `why`: a fail's or warning's code.
 */
export const PartCheck = z.object({
  state: PartState,
  line: z.string().nullable(),
  checkedAt: z.string().nullable(),
  why: z.string().optional(),
});
export type PartCheck = z.infer<typeof PartCheck>;

/** A part never checked. */
const TODO: PartCheck = { state: 'todo', line: null, checkedAt: null };

export const LoginSeen = z.object({
  tool: z.string(),
  state: z.string(),
  fix: z.string(),
  /** What else to know: az's folder that was checked, what the check said; az ok, who too. */
  note: z.string().optional(),
});
export type LoginSeen = z.infer<typeof LoginSeen>;

/**
 * The repo's logins as the logins module reports them against what it needs (#23's
 * `repoLogins(repo, needs, status)`): the tools needed, those missing (or expired), those it could
 * not check, and whether all are ready.
 */
export type RepoLoginsSeen = {
  needs: readonly string[];
  missing: readonly string[];
  unchecked: readonly string[];
  ready: boolean;
  /** Each tool's sign-in as the logins service words it (`null`: none helps); absent: `abe login <tool>`. */
  fixes?: Readonly<Record<string, string | null>>;
  /** What else to know of a tool, as the logins service words it (az's folder, who on az ok). */
  notes?: Readonly<Record<string, string | undefined>>;
};

const loginState = (r: RepoLoginsSeen, tool: string): string => {
  if (r.missing.includes(tool)) return 'missing';

  return r.unchecked.includes(tool) ? 'unchecked' : 'ok';
};

/**
 * Each needed tool's state and its way in: `abe login <tool>` in Terminal.
 * `skip`: tools the install does not need now (`skipped`).
 */
export const loginsSeen = (r: RepoLoginsSeen, skip: readonly string[] = []): LoginSeen[] =>
  r.needs.map((tool) => {
    const state = skip.includes(tool) ? 'skipped' : loginState(r, tool);
    // ok too: az's says who it signed in as and where
    const note = state === 'skipped' ? undefined : r.notes?.[tool];

    return {
      tool,
      state,
      fix: r.fixes?.[tool] ?? `abe login ${tool}`,
      ...(note === undefined ? {} : { note }),
    };
  });

/** A found source's answer: added (its server for the main checkout) or skipped. */
export const SourceAnswer = z.enum(['add', 'skip']);
export type SourceAnswer = z.infer<typeof SourceAnswer>;

/**
 * An added source's server (ADR 0027): the definition the install added (a known system's, the
 * repo's config's, one typed), or `yours`: one the checkout or your user scope had already, by
 * name, added as it is.
 */
export const SourceServer = z.discriminatedUnion('from', [
  z.object({
    from: z.enum(['known', 'repo', 'typed']),
    transport: z.enum(['http', 'sse']),
    url: z.string(),
  }),
  z.object({ from: z.literal('yours') }),
]);
export type SourceServer = z.infer<typeof SourceServer>;

/** Env files' record (ADR 0028), as the install keeps it (`envFiles`). */
const InstallEnvFiles = z.object({
  /** Each environment's aws profile for the app and the checks, any of this Mac's; null: none. */
  profiles: z.partialRecord(AbeEnv, z.string().nullable()).default({}),
  /**
   * Which repo env file feeds which environment, the session's judgement with its evidence
   * (`abe install env-map`), kept as a decision; null: not judged yet.
   */
  mapping: EnvMapping.nullable().default(null),
});

/**
 * Each added source's check: its server's state, the probe's read, why a sign-in did not end,
 * and whether it has a sign-in (it once needed one, serve signed it in, or its server told an
 * account): only then does a failed read name one.
 */
export const SourceChecks = z.record(
  z.string(),
  z.object({
    mcp: z.enum(MCP_STATES),
    probe: SourceProbeRead.nullable(),
    why: z.string().nullable(),
    at: z.string(),
    signIn: z.boolean().default(false),
  }),
);

/**
 * A record from before 3.5.29 names the repo kind its shape (ADR 0040): `shapeSaid` is read as
 * `kindSaid`, Read's `shape` as its `kind`, and so its own `shape` and each part's.
 */
const unset = (v: unknown) => v === undefined || v === null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const shapeAsKind = (v: unknown): unknown => {
  if (!isRecord(v)) return v;
  const r: Record<string, unknown> = { ...v };

  if (unset(r.kind) && !unset(r.shape)) r.kind = r.shape;
  delete r.shape;

  return r;
};

const kindNamed = (v: unknown): unknown => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
  const r: Record<string, unknown> = { ...v };

  if (unset(r.kindSaid) && !unset(r.shapeSaid)) r.kindSaid = r.shapeSaid;
  delete r.shapeSaid;
  const read = r.read;

  if (typeof read === 'object' && read !== null && !Array.isArray(read)) {
    const found: Record<string, unknown> = { ...read };

    if (unset(found.kind) && !unset(found.shape)) found.kind = found.shape;
    delete found.shape;
    const kind = shapeAsKind(found.kind);

    if (isRecord(kind) && Array.isArray(kind.parts)) kind.parts = kind.parts.map(shapeAsKind);
    found.kind = kind;
    r.read = found;
  }

  return r;
};

/** The install's record, kept by serve per checkout (`<state>/installs/<id>/install.json`). */
const InstallRecord = z.object({
  v: z.literal(2),
  /** The main checkout's top folder. */
  repo: z.string(),
  startedAt: z.string(),
  /** The repo had an `abe.yaml` when the install began (a teammate's): its personal parts alone. */
  join: z.boolean().default(false),
  /** Each part's last check; one not there is todo. */
  parts: z.partialRecord(InstallPart, PartCheck).default({}),
  /** When the install was first Done: cards start in the checkout from then on. Null: never. */
  finishedAt: z.string().nullable().default(null),
  /** Each found source's answer. */
  sources: z.record(z.string(), SourceAnswer).default({}),
  /**
   * Env files (ADR 0028): each environment's aws profile and the mapping the prefill is written
   * from. Null: neither said yet.
   */
  envFiles: InstallEnvFiles.nullable().default(null),
  /**
   * Each added source's check (ADR 0027): its MCP server's state where a session in the checkout
   * loads it, the probe's read once connected, and why a sign-in did not end signed in.
   */
  sourceChecks: SourceChecks.default({}),
  /**
   * The sources whose sign-in was started: serve runs each, in the person's browser, outside any
   * sandbox, and records its end (`signed-in`).
   */
  signingIn: z.array(z.string()).catch([]),
  /** Each added source's server (`SourceServer`), a typed one's too. */
  sourceServers: z.record(z.string(), SourceServer).default({}),
  /**
   * The MCP servers a session in the checkout loads by name (the main checkout's local scope, then
   * your user scope), as serve last looked; names only. Null: not looked yet.
   */
  sourcesHave: z.array(z.string()).nullable().default(null),
  /** What the connection read, live: the board, GitHub, the cloud, each source and environment. */
  connection: Connection.nullable().default(null),
  /**
   * The kind the person said the repo is, when Read read it wrong (`abe install kind`), kept as
   * well as `abe.yaml`'s `kind:` that the install writes (ADR 0040): Read takes `abe.yaml`'s,
   * else this, over the files'. Null: the files' (ADR 0026).
   */
  kindSaid: RepoKindSaid.nullable().default(null),
  /**
   * The board the repo's settings name that the board login can't read (401, 403), read by the
   * Board check. Null: none.
   */
  unreadable: z
    .object({ board: BoardWhere, organization: z.string(), why: z.string() })
    .nullable()
    .default(null),
  read: ReadFindings.nullable(),
  board: BoardWhere.nullable(),
  logins: z.array(LoginSeen).nullable(),
  gate: GateResult.nullable(),
  /**
   * The app can't start here, as the person chose (`abe install gate --cannot-run`): why, and
   * when. Verify passes on it without the app, saying so. Null: it ran, or nobody said it could not.
   */
  notRun: z.object({ why: z.string(), at: z.string() }).nullable().default(null),
  /**
   * Hosts the person said are test backends, as an install before 3.5.28 kept them: read beside
   * `abe.yaml`'s `gate.testHosts`, where the install writes them now (ADR 0040).
   */
  testHosts: z.array(z.string()).default([]),
  /** Prod hosts the app only reads from, as an older install kept them (`gate.readOnlyHosts` now). */
  readOnlyHosts: z.array(z.string()).default([]),
  /** Keys and env files the app never uses, as an older install kept them (`env.notUsed` now). */
  notUsed: z.array(NotUsed).default([]),
  /** The install's session (its Chat): launched by `abe install`, reopened when it ended. */
  session: z.string().nullable().default(null),
  /**
   * The environment the checks run with (ADR 0028): judged from the repo's evidence (scripts, CI,
   * README) and recorded by the session, or picked by the person; `why` its evidence. Serve writes
   * it into `abe.yaml`'s `checksEnv` too, which is read first (ADR 0040). Null: none said.
   */
  checksEnv: z
    .object({ env: AbeEnv, why: z.string().nullable(), by: z.enum(['person', 'session']) })
    .nullable()
    .default(null),
  /** Each check serve ran (`abe install try`, the Checks and Verify checks), by its command. */
  checkRuns: z.record(z.string(), CheckProof).default({}),
  /**
   * The files the install wrote, as serve last looked (`abe install check`): paths from the top,
   * the team's changed or new as git has them, then the person's `.abe/` ones. Never a value.
   */
  files: z.array(z.string()).default([]),
  /** The last `abe install check prototype`, step by step; null: never tried. */
  prototypeTry: PrototypeTry.nullable().default(null),
});
export const Install = z.preprocess(kindNamed, InstallRecord);
export type Install = z.infer<typeof InstallRecord>;

export const newInstall = (repo: string, at: string, join = false): Install => ({
  v: 2,
  repo,
  startedAt: at,
  join,
  parts: {},
  finishedAt: null,
  read: null,
  board: null,
  logins: null,
  gate: null,
  notRun: null,
  testHosts: [],
  readOnlyHosts: [],
  notUsed: [],
  sources: {},
  sourceServers: {},
  sourcesHave: null,
  sourceChecks: {},
  signingIn: [],
  envFiles: null,
  connection: null,
  kindSaid: null,
  unreadable: null,
  session: null,
  checksEnv: null,
  checkRuns: {},
  files: [],
  prototypeTry: null,
});

/** Each part's last check, in order; one a record lacks is todo. */
export const partsOf = (i: Pick<Install, 'parts'>): (PartCheck & { id: InstallPart })[] =>
  INSTALL_PARTS.map((id) => ({ id, ...(i.parts[id] ?? TODO) }));

/** Whether a part passes for Done: it passes, or it warns. */
export const partGoesOn = (p: Pick<PartCheck, 'state'>): boolean =>
  p.state === 'pass' || p.state === 'warn';

/** The required parts besides Done that do not pass (nor warn), in order. */
export const partsLeft = (i: Pick<Install, 'parts'>): InstallPart[] =>
  partsOf(i)
    .filter((p) => p.id !== 'done' && INSTALL_PART_TABLE[p.id].required && !partGoesOn(p))
    .map((p) => p.id);

/** Whether the install is Done: every required part passes (or warns). */
export const installDone = (i: Pick<Install, 'parts'>): boolean =>
  partsOf(i).every((p) => !INSTALL_PART_TABLE[p.id].required || partGoesOn(p));

/**
 * What a part's check says: pass, fail or warn, its line, and a fail's or warning's code.
 * `personal`: a team part's fail that is the person's own (their Abe env files, their aws
 * profiles): it fails on a join too.
 */
export type PartVerdict = {
  state: 'pass' | 'fail' | 'warn';
  line: string;
  why?: string;
  personal?: true;
};

export const partPassed = (line: string): PartVerdict => ({ state: 'pass', line });

export const partFailed = (why: string, line: string): PartVerdict => ({
  state: 'fail',
  line,
  why,
});

export const partWarned = (why: string, line: string): PartVerdict => ({
  state: 'warn',
  line,
  why,
});

/** A refusal read as a failed check: its code and its message. */
export const failedOf = (o: { error: { code: string; message: string } }): PartVerdict =>
  partFailed(o.error.code, o.error.message);

/**
 * The part's check recorded: on a join, a team part that fails warns (the teammate's to fix),
 * unless the fail is the person's own (`personal`); the install finished once Done.
 */
export const partChecked = (i: Install, part: InstallPart, v: PartVerdict, at: string): Install => {
  const warns =
    v.state === 'fail' && i.join && INSTALL_PART_TABLE[part].team && v.personal !== true;
  const now: Install = {
    ...i,
    parts: {
      ...i.parts,
      [part]: {
        state: warns ? 'warn' : v.state,
        line: v.line,
        checkedAt: at,
        ...(v.why === undefined ? {} : { why: v.why }),
      },
    },
  };

  return now.finishedAt === null && installDone(now) ? { ...now, finishedAt: at } : now;
};

/**
 * `abe install reset`, a clean start: the install's session stopped, `.abe/`'s untracked and
 * ignored files deleted (the Abe env files, yours for the repo, Abe's records there) and the record
 * moved aside. `abe.yaml`, `.claude/skills/` and what git tracks in `.abe/` are the team's: never
 * touched.
 */
export const InstallResetData = z.object({
  repo: z.string(),
  /** The session stopped; null: none ran. */
  stopped: z.string().nullable(),
  /** `.abe/` deleted; false: there was none. */
  removed: z.boolean(),
  /** Where the record went (`aside.<when>/install.json`). */
  aside: z.string(),
});
export type InstallResetData = z.infer<typeof InstallResetData>;

export const installResetText = (d: InstallResetData): string =>
  [
    d.stopped === null ? 'no install session ran' : `install session ${d.stopped} stopped`,
    d.removed ? ".abe/'s untracked files deleted (tracked ones kept)" : 'no .abe/',
    `record of ${d.repo} moved aside to ${d.aside}: abe install starts it again`,
  ]
    .map((l) => `${l}\n`)
    .join('')
    .concat('abe.yaml and .claude/skills/ as they were\n');

/**
 * Who moved: the person (the page, a Terminal) and the install's own session, which runs for them
 * while they are there (#71), or another session.
 */
export type InstallBy = 'person' | 'session';

export type InstallMove =
  | { kind: 'read'; findings: ReadFindings }
  | { kind: 'logins'; logins: RepoLoginsSeen; skip: readonly string[] }
  /** The board the repo's settings name now, as the Board check read it. */
  | { kind: 'board'; board: BoardWhere | null }
  /**
   * Sources' look (ADR 0027): the MCP servers a session in the checkout loads by name (the main
   * checkout's local scope, then your user scope); a found source one of them names is added as
   * it is.
   */
  | { kind: 'sources'; have: readonly string[] }
  /** A source's check: its MCP server's state, and the probe's read once connected. */
  | {
      kind: 'source-check';
      id: string;
      mcp: McpState;
      probe: SourceProbeRead | null;
      why?: string;
      /** Its server told an account: it has a sign-in. */
      signIn?: boolean;
    }
  /** A source's sign-in started (`abe source sign-in`): serve runs it. */
  | { kind: 'sign-in'; id: string; by: InstallBy }
  /** Serve's sign-in of a source ended: its server's state, its one read once connected, why not. */
  | {
      kind: 'signed-in';
      id: string;
      mcp: McpState;
      probe: SourceProbeRead | null;
      why?: string;
      signIn?: boolean;
    }
  /** An environment's aws profile (`abe install env-profile`); null none. */
  | { kind: 'env-profile'; env: string; profile: string | null; by: InstallBy }
  /**
   * Which repo env file feeds which environment, judged from evidence (`abe install env-map`):
   * each `--file` in load order, and CI's keys when environments live in CI.
   */
  | {
      kind: 'env-map';
      files: readonly string[];
      ciKeys: readonly string[];
      ciEvidence?: string;
      by: InstallBy;
    }
  /** The checks' environment (`abe install checks-env`): the session's judgement, or the person's. */
  | { kind: 'checks-env'; env: string; why?: string; by: InstallBy }
  /**
   * A found source added on the server known for it, or the repo's config's (`abe install source
   * <name>`), or skipped (`--skip`).
   */
  | { kind: 'source-add'; id: string; by: InstallBy }
  | { kind: 'source-skip'; id: string }
  /**
   * The person says the repo's kind (Read read it wrong), one or per part; `findings`: Read again
   * with it. Serve writes it into `abe.yaml`'s `kind:` too (ADR 0040).
   */
  | { kind: 'repo-kind'; said: RepoKindSaid; findings: ReadFindings; by: InstallBy }
  /** A source's server typed (`abe install source <name> --url`). */
  | { kind: 'source-url'; name: string; url: string; transport?: 'http' | 'sse'; by: InstallBy }
  /** The board a Layer names refused the board login: `organization` its org. */
  | { kind: 'board-unreadable'; organization: string; why: string }
  | { kind: 'connection'; facts: readonly ConnectionFact[] }
  /**
   * The gate's result. The hosts and keys the person answered it with go into `abe.yaml`
   * (`gate.testHosts`, `gate.readOnlyHosts`, `env.notUsed`, ADR 0040), never the record.
   */
  | { kind: 'gate'; result: GateResult }
  /** What `abe run start` asks before it starts the app: the gate on what start loads, no URL yet. */
  | { kind: 'before-run'; result: GateResult }
  /** The app can't start here, and why, as the person chose. */
  | { kind: 'cannot-run'; why: string }
  /** Serve ran checks for the install: each one's command and its end. */
  | { kind: 'check-ran'; runs: readonly { run: string; ok: boolean; exit: number | null }[] };

/**
 * Whether the install asks each environment's aws profile: the repo uses aws. The profile is what
 * its app and checks get keys from.
 */
export const asksEnvProfiles = (i: Install): boolean => (i.read?.aws.length ?? 0) > 0;

/**
 * The environment the checks of the install `i` run with: `abe.yaml`'s `checksEnv` (`said`, the
 * team's, ADR 0040), else the one an older install recorded, else dev.
 */
export const checksEnvOf = (i: Install | undefined, said?: AbeEnv | null): AbeEnv =>
  said ?? i?.checksEnv?.env ?? DEFAULT_CHECKS_ENV;

/** The env files' record as it is, or an empty one. */
const envFilesOf = (i: Install) => i.envFiles ?? { profiles: {}, mapping: null };

/**
 * The checks' environment recorded (ADR 0028): the session's from the repo's evidence, the
 * person's over it (another session never changes theirs); prod like any (ADR 0029).
 */
const checksEnvMove = (
  i: Install,
  m: Extract<InstallMove, { kind: 'checks-env' }>,
): Outcome<Install> => {
  const env = AbeEnv.safeParse(m.env);

  if (!env.success) return refused('no-environment', `${m.env} is none of ${ABE_ENVS.join(', ')}`);
  // prod recorded like any: the checks are refused while it is off for agents (ADR 0029)
  const evidence = m.why?.trim() ?? '';

  if (i.checksEnv?.by === 'person' && m.by !== 'person')
    return refused(
      'only-you',
      `the person picked ${i.checksEnv.env} for the checks: only they or the install's session change it`,
    );

  return {
    ok: true,
    data: { ...i, checksEnv: { env: env.data, why: evidence === '' ? null : evidence, by: m.by } },
  };
};

/** An environment's aws profile: the person's or the install session's (another may set none). */
const envProfileMove = (
  i: Install,
  m: Extract<InstallMove, { kind: 'env-profile' }>,
): Outcome<Install> => {
  const env = AbeEnv.safeParse(m.env);

  if (!env.success) return refused('no-environment', `${m.env} is none of ${ABE_ENVS.join(', ')}`);
  if (m.profile !== null && m.by !== 'person')
    return refused(
      'only-you',
      "an environment's aws profile is the person's or the install session's: another session may set none",
    );
  if (m.profile !== null && !AwsProfileName.safeParse(m.profile).success)
    return refused('usage', `${m.profile}: an aws profile name`, 2);
  const e = envFilesOf(i);

  return {
    ok: true,
    data: { ...i, envFiles: { ...e, profiles: { ...e.profiles, [env.data]: m.profile } } },
  };
};

/** Why an env file Read found is Not sure when neither `abe.yaml` nor the env map places it. */
export const ENV_NOT_MAPPED =
  "Read found it, neither abe.yaml's worktree groups nor the env map place it";

/** A repo env file placed, as the prefill and the Worktree check read it: where it goes and why. */
export type EnvFilePlaced = {
  path: string;
  to: EnvPlace;
  /** The evidence: the env map's, else the `abe.yaml` groups that place it. */
  why: string;
  from: 'recipe' | 'record';
  always?: true;
};

/**
 * The repo env files placed (ADR 0040): `abe.yaml` first (`recipe`'s groups, `notUsed`: its
 * `env.notUsed`), then the install's env map on this Mac for the files neither names; then each
 * one Read found that none places (keys in it, no example, no old copy) as Not sure. None while
 * nothing places any.
 */
export const envFilesPlaced = (
  i: Install,
  recipe?: WorktreeRecipe,
  notUsed: readonly { key: string; why?: string }[] = [],
): EnvFilePlaced[] => {
  const m = i.envFiles?.mapping ?? null;
  const placed = envPlacement(recipe, m?.files ?? [], notUsed);

  if (placed.length === 0) return [];
  const why = (p: (typeof placed)[number]): string => {
    const judged = m?.files.find((f) => f.path === p.path)?.why;

    if (p.from === 'record') return judged ?? '';
    if (p.to === 'not-used')
      return notUsed.find((n) => n.key === p.path)?.why ?? 'abe.yaml env.notUsed';

    return [`abe.yaml ${(p.groups ?? []).join(', ')}`, judged]
      .filter((w) => w !== undefined)
      .join(' · ');
  };
  const left = (i.read?.envFiles ?? []).filter(
    (f) =>
      !f.example &&
      f.keys.length > 0 &&
      !isOldEnvCopy(f.path) &&
      !isAbeEnvFile(f.path) &&
      !placed.some((x) => x.path === f.path),
  );

  return [
    ...placed.map((p): EnvFilePlaced => ({
      path: p.path,
      to: p.to,
      why: why(p),
      from: p.from,
      ...(p.always === true ? { always: true as const } : {}),
    })),
    ...left.map((f): EnvFilePlaced => ({
      path: f.path,
      to: 'not-sure',
      why: ENV_NOT_MAPPED,
      from: 'record',
    })),
  ];
};

/**
 * The session's judgement of which repo env file feeds which environment, kept as a decision with
 * its evidence; serve then writes the prefill. Each file once.
 */
const envMapMove = (
  i: Install,
  m: Extract<InstallMove, { kind: 'env-map' }>,
  at: string,
): Outcome<Install> => {
  const files: EnvFileMapped[] = [];

  for (const spec of m.files) {
    const f = envFileSpec(spec);

    if (!f.ok) return f;
    if (files.some((x) => x.path === f.data.path))
      return refused('usage', `${f.data.path}: given twice; each file once, in load order`, 2);
    files.push({ ...f.data, by: m.by, notSure: f.data.to === 'not-sure' ? f.data.why : null });
  }
  const keys = ciKeysOk(m.ciKeys);

  if (!keys.ok) return keys;
  const evidence = m.ciEvidence?.trim() ?? '';

  if (keys.data.length > 0 && evidence === '')
    return refused('usage', '--ci-key needs --ci: where CI names them (its file and line)', 2);
  if (files.length === 0 && evidence === '')
    return refused(
      'usage',
      'no --file and no --ci: map each env file, or say where CI keeps the environments',
      2,
    );

  return {
    ok: true,
    data: {
      ...i,
      envFiles: {
        ...envFilesOf(i),
        mapping: {
          files,
          ci: evidence === '' ? null : { keys: keys.data, evidence },
          by: m.by,
          at,
        },
      },
    },
  };
};

/** The sources Read found that are not answered yet. */
export const unansweredSources = (i: Install): FoundSource[] =>
  (i.read?.sources ?? []).filter((s) => i.sources[s.id] === undefined);

/** A found source a server the checkout loads already names (`sourcesHave`), by id or server. */
const had = (i: Install, s: FoundSource): string | undefined =>
  (i.sourcesHave ?? []).find((h) => h === s.id || (s.mcp !== null && h === s.mcp));

/** Each found source a server the checkout loads names, added as it is (`yours`). */
const withTheirs = (i: Install): Install => {
  const theirs = (i.read?.sources ?? []).filter(
    (s) => had(i, s) !== undefined && i.sources[s.id] === undefined,
  );

  return {
    ...i,
    sources: { ...i.sources, ...Object.fromEntries(theirs.map((s) => [s.id, 'add' as const])) },
    sourceServers: {
      ...i.sourceServers,
      ...Object.fromEntries(theirs.map((s) => [s.id, { from: 'yours' as const }])),
    },
  };
};

/** Each added source, by id, the found ones first: its name as said, and its server's. */
export const addedSources = (i: Install): { id: string; name: string; server: string }[] => [
  ...(i.read?.sources ?? [])
    .filter((s) => i.sources[s.id] === 'add')
    .map((s) => ({ id: s.id, name: s.name, server: s.mcp ?? s.id })),
  ...Object.keys(i.sourceServers)
    .filter((id) => i.sources[id] === 'add' && !(i.read?.sources ?? []).some((s) => s.id === id))
    .map((id) => ({ id, name: id, server: id })),
];

/**
 * The sources the install checks (ADR 0031): each added one, then each the repo's `sources:`
 * names (`team`) that none of those is, by its own name.
 */
export const sourcesToCheck = (
  i: Install,
  team: readonly string[] = [],
): { id: string; name: string; server: string }[] => {
  const added = addedSources(i);

  return [
    ...added,
    ...[...new Set(team)]
      .filter((n) => i.sources[n] !== 'skip' && !added.some((a) => a.id === n || a.server === n))
      .map((n) => ({ id: n, name: n, server: n })),
  ];
};

/**
 * The MCP servers a session in the checkout may load (ADR 0027, 0031): each source whose check
 * at the install passed (its server connected, its one read ok), by its server's name (an added
 * one's, else the check's own name, a `sources:` entry's), the install's session's too once a
 * sign-in passed. Never a server no check passed.
 */
export const checkedSourceServers = (i: Install | undefined): string[] => {
  if (i === undefined) return [];
  const added = addedSources(i);

  return [
    ...new Set(
      Object.entries(i.sourceChecks)
        .filter(([, c]) => c.mcp === 'connected' && c.probe === 'ok')
        .map(([id]) => added.find((s) => s.id === id)?.server ?? id),
    ),
  ];
};

/** What stops an added source's check from reading, and the fix; null: it reads. */
export const sourceStops = (name: string, c: Install['sourceChecks'][string]): string | null => {
  const after = c.why === null ? '' : ` (${c.why})`;

  if (c.mcp === 'needs-auth')
    return `${name} needs a sign-in${after}: abe source sign-in runs it in the person's browser`;
  if (c.mcp === 'none') return `${name} has no MCP server a session here loads: add it again`;
  if (c.mcp === 'failed') return `${name} does not answer: its server is down, or its URL wrong`;
  if (c.probe === 'tool-error')
    return c.signIn
      ? `${name} is signed in, but its one read gave an error${after}: abe source sign-in again as an account that reads it`
      : `${name} answers, but its one read gave an error${after}: check its server, then run the check again`;
  if (c.probe === 'timeout') return `${name} gave no answer to its one read in time`;

  return null;
};

/** A source's sign-in started: serve runs it; its check goes until the sign-in ends. */
const signIn = (i: Install, m: Extract<InstallMove, { kind: 'sign-in' }>): Outcome<Install> => {
  if (m.by !== 'person') return refused('only-you', signInRefusalWords(m.id));
  if (!addedSources(i).some((s) => s.id === m.id))
    return refused(
      'not-a-source',
      `${m.id} is no added source: ${
        addedSources(i)
          .map((s) => s.id)
          .join(', ') || 'none added yet'
      }`,
    );

  return {
    ok: true,
    data: {
      ...i,
      sourceChecks: Object.fromEntries(
        Object.entries(i.sourceChecks).filter(([id]) => id !== m.id),
      ),
      signingIn: [...i.signingIn.filter((id) => id !== m.id), m.id],
    },
  };
};

/** A source's server typed: for a found one not answered, or a new one by its name. */
const sourceUrl = (
  i: Install,
  m: Extract<InstallMove, { kind: 'source-url' }>,
): Outcome<Install> => {
  if (m.by !== 'person')
    return refused(
      'only-you',
      "adding a source's server is the person's or the install session's: never another session",
    );
  const name = m.name.trim().toLowerCase();

  if (!SOURCE_NAME.test(name))
    return refused('usage', `${m.name}: a source's name, like sentry (letters, digits, - . _)`, 2);
  if (!sourceUrlOk(m.url.trim()))
    return refused('usage', `${m.url}: an MCP server's URL, https (or http on localhost)`, 2);
  if ((i.sourcesHave ?? []).includes(name))
    return refused(
      'source-there',
      `this checkout loads an MCP server named ${name} already: it is added as it is, never a second definition of one name`,
    );

  return {
    ok: true,
    data: {
      ...i,
      sources: { ...i.sources, [name]: 'add' },
      sourceServers: {
        ...i.sourceServers,
        [name]: { from: 'typed', transport: m.transport ?? 'http', url: m.url.trim() },
      },
    },
  };
};

/** A found source added on the server known for it, or the one the repo's config names. */
const sourceAdd = (
  i: Install,
  m: Extract<InstallMove, { kind: 'source-add' }>,
): Outcome<Install> => {
  if (m.by !== 'person')
    return refused(
      'only-you',
      "adding a source's server is the person's or the install session's: never another session",
    );
  const found = i.read?.sources.find((s) => s.id === m.id);
  const offer = found === undefined ? null : sourceOffer(found);

  if (found === undefined)
    return refused(
      'not-a-source',
      `${m.id} is no source Read found (${(i.read?.sources ?? []).map((s) => s.id).join(', ') || 'none'}): add it by its URL, --url <its MCP server's URL>`,
    );
  if (offer === null)
    return refused(
      'no-server',
      `no MCP server is known for ${m.id}: add it by its URL, --url <its MCP server's URL>, or --skip`,
    );

  return {
    ok: true,
    data: {
      ...i,
      sources: { ...i.sources, [m.id]: 'add' },
      sourceServers: {
        ...i.sourceServers,
        [m.id]: { from: offer.from, transport: offer.transport, url: offer.url },
      },
    },
  };
};

/**
 * The servers `now` added that `was` had not: each definition the install puts for the main
 * checkout, by name. None for one that is yours.
 */
export const sourceServersAdded = (
  was: Install,
  now: Install,
): { name: string; transport: 'http' | 'sse'; url: string }[] =>
  Object.entries(now.sourceServers).flatMap(([name, def]) =>
    def.from === 'yours' || was.sourceServers[name] !== undefined
      ? []
      : [{ name, transport: def.transport, url: def.url }],
  );

/**
 * What `abe run <script>` says before the app it starts (`gate` without a URL): the backends the
 * person never said are local or test and the cloud credentials it loads, the credential warning
 * first, with the ways on. Null: nothing to warn of. Never a refusal: the run goes on.
 */
export const beforeRunWarning = (result: GateResult): string | null => {
  // a warning a reason says already (the credential warning, first) is said once
  const said = [
    ...result.warnings.filter((w) => !result.reasons.some((r) => r.startsWith(w))),
    ...result.reasons,
  ];

  if (said.length === 0) return null;
  const ways =
    result.passed || result.options.length === 0 ? '' : `. Ways on: ${result.options.join('; ')}`;

  return `warning, started all the same: ${said.join('; ')}${ways}`;
};

/**
 * Why a card may not start in a checkout (a Factory run, a card's session): its install never
 * finished, naming the first part that does not pass, or it has none. Null: finished once (a part
 * failing since is the install's to fix, not the cards' to wait on).
 */
export const cardInstallRefusal = (
  i: Install | undefined,
): { code: 'no-install' | 'install-not-done'; message: string } | null => {
  if (i === undefined)
    return {
      code: 'no-install',
      message: 'finish the install first: this checkout has none (abe install starts it)',
    };
  if (i.finishedAt !== null || installDone(i)) return null;
  const first = partsOf(i).find((p) => p.state !== 'pass');

  return {
    code: 'install-not-done',
    message: `finish the install first: ${INSTALL_PART_TABLE[first?.id ?? 'done'].title} (abe install opens it)`,
  };
};

/**
 * The install's one rule: each move records what serve read or was told, at any time and in any
 * order; nothing is gated on another part. A non-install session's moves that are the person's
 * are refused (`only-you`).
 */
export const moveInstall = (i: Install, move: InstallMove, at: string): Outcome<Install> => {
  switch (move.kind) {
    case 'read':
      return {
        ok: true,
        data: withTheirs({ ...i, read: move.findings, board: move.findings.board ?? i.board }),
      };
    case 'logins':
      return { ok: true, data: { ...i, logins: loginsSeen(move.logins, move.skip) } };
    case 'board':
      return {
        ok: true,
        data: {
          ...i,
          board: move.board,
          // a board the login reads now, or another one
          unreadable: move.board === null ? i.unreadable : null,
        },
      };
    case 'board-unreadable':
      if (i.board === null || i.board.from === 'you')
        return refused('not-a-layer-board', "only a board the repo's settings name is taken out");

      return {
        ok: true,
        data: {
          ...i,
          board: null,
          unreadable: { board: i.board, organization: move.organization, why: move.why },
        },
      };
    case 'sources':
      return { ok: true, data: withTheirs({ ...i, sourcesHave: [...move.have] }) };
    case 'source-url':
      return sourceUrl(i, move);
    case 'source-add':
      return sourceAdd(i, move);
    case 'source-skip':
      return {
        ok: true,
        data: {
          ...i,
          sources: { ...i.sources, [move.id]: 'skip' },
          sourceChecks: Object.fromEntries(
            Object.entries(i.sourceChecks).filter(([id]) => id !== move.id),
          ),
          signingIn: i.signingIn.filter((id) => id !== move.id),
        },
      };
    case 'repo-kind':
      if (move.by !== 'person')
        return refused(
          'only-you',
          "the repo's kind is the person's to say, or the install session's for them",
        );

      return { ok: true, data: { ...i, read: move.findings, kindSaid: move.said } };
    case 'env-profile':
      return envProfileMove(i, move);
    case 'env-map':
      return envMapMove(i, move, at);
    case 'sign-in':
      return signIn(i, move);
    case 'signed-in':
    case 'source-check':
      return {
        ok: true,
        data: {
          ...i,
          signingIn: i.signingIn.filter((id) => id !== move.id),
          sourceChecks: {
            ...i.sourceChecks,
            [move.id]: {
              mcp: move.mcp,
              probe: move.probe,
              why: move.why ?? null,
              at,
              signIn:
                move.kind === 'signed-in' ||
                move.mcp === 'needs-auth' ||
                move.signIn === true ||
                i.sourceChecks[move.id]?.signIn === true,
            },
          },
        },
      };
    case 'check-ran':
      return {
        ok: true,
        data: {
          ...i,
          checkRuns: {
            ...i.checkRuns,
            ...Object.fromEntries(
              move.runs.map((r) => [checkKey(r.run), { ok: r.ok, exit: r.exit, at }]),
            ),
          },
        },
      };
    case 'checks-env':
      return checksEnvMove(i, move);
    case 'connection':
      return { ok: true, data: { ...i, connection: { at, facts: [...move.facts] } } };
    case 'gate':
      return {
        ok: true,
        data: {
          ...i,
          gate: move.result,
          // it ran: the app can start here after all
          notRun: move.result.passed ? null : i.notRun,
        },
      };
    case 'before-run':
      return { ok: true, data: i };
    case 'cannot-run': {
      const why = move.why.trim().replace(/[.\s]+$/, '');

      if (why === '')
        return refused('usage', 'say why the app cannot start here: --cannot-run <why>', 2);

      return { ok: true, data: { ...i, notRun: { why, at } } };
    }
  }
};

/** The checkout's folder name: what Chat calls the repo. */
export const installRepoName = (repo: string): string =>
  repo.replace(/\/+$/, '').split('/').pop() ?? repo;

/**
 * What the install's session is told when the person started a source's sign-in: serve runs it in
 * their browser, and the session goes on meanwhile.
 */
export const installSignInPrompt = (name: string): string =>
  `I started ${name}'s sign-in: serve runs it in my browser, outside any sandbox. Don't wait for it and never start one yourself; abe install check sources says when it ends. Read abe install status --json and go on from there.`;

/**
 * The first message of the install's session resumed (`--resume`) once serve's sign-in of a source
 * ended signed in and its one read was ok: it loads that source's server now.
 */
export const installSignedInPrompt = (name: string): string =>
  `${name} is signed in and its one read was ok: this session started again on the new sign-in, its conversation resumed, with ${name}'s tools. Read abe install status --json and go on from there.`;
