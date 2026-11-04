/**
 * Problems first (#108): what the Settings dialog lists on top while there are any, worst first.
 * Each problem is one line of what is wrong, a dim line of where, and its way out: a fix (the
 * exact command, typed into the fix strip, never run unasked) or the row to open.
 *
 * From worst: a login missing or expired (`abe login status`), a tool not found, too old or not
 * answering (`abe tools check`), the setup a new user gets wrong (no board, or AWS to reach boxes
 * on, #158), the checkout's repo with no check that has a command (no repo
 * pack, #159: a Factory run's checks run nothing), a 2.0 Layer Override with no reason, a Layer
 * file that does not read, a setting the merge dropped (personal-only, not-in-repo, write-below-repo,
 * unknown-node…) or a theme no one has (its fix lists the themes). Last, never counted as a
 * problem: an info row for each of your own Overrides in force (#168), its way out the proposal
 * that would make it the repo's (suggested, never required).
 */
import { z } from 'zod';
import { plainText } from '../../factory/ansi';
import {
  checkedLogins,
  entraBlockText,
  loginFix,
  LOGINS,
  type LoginStatusData,
} from '../../logins/logins';
import { type BrowserListData } from '../../browser/browser-profiles';
import { toolProblem, type ToolCheck } from '../../install/tools';
import { checksConfigured, unconfiguredChecks } from '../../factory/checks';
import { type CheckEntry } from './checks';
import { ProblemCode, type SettingProblem } from './contract';
import { proposeCommand } from './override';
import { type PersonalOverride } from './personal';
import { isSettingKey, type Layer, SETTINGS } from './keys';
import { homeRowOf, PAGE_IDS, pageOf, type PageId } from './pages';
import { placeOfFile } from './places';
import { SETUP_PROBLEM_CODES, setupProblems, type SetupFacts } from './setup-problems';
import { type WorkflowProblem } from '../../skills/workflow/load';

export const PROBLEM_KINDS = [
  'login',
  'tool',
  'setup',
  'checks',
  'override-reason',
  'layer-file',
  'dropped',
  /** A browser profile (#127, #345): `browser.default` naming none, sign-ins never stored. */
  'browser',
  /** Info, not a problem (#168): one of your Overrides in force. */
  'override',
] as const;

const PageName = z.enum(PAGE_IDS);

export const ProblemWay = z.discriminatedUnion('kind', [
  /** Typed into the fix strip under the page; ⏎ there runs it. */
  z.object({ kind: z.literal('fix'), command: z.string() }),
  /** Goes to the row (or the page, `row` null), focused. */
  z.object({ kind: z.literal('open'), page: PageName, row: z.string().nullable() }),
  /** A Layer file that does not read (#126, #345): opened in the editor, where it is fixed. */
  z.object({ kind: z.literal('file'), path: z.string() }),
]);
export type ProblemWay = z.infer<typeof ProblemWay>;

/** A login's, a tool's or the repo's checks' problem; a setting's is the merge's `ProblemCode`. */
export const CHECK_PROBLEM_CODES = [
  'login-expired',
  'login-missing',
  'login-blocked',
  'login-unchecked',
  'tool-missing',
  'tool-old',
  'tool-failed',
  'no-checks',
  'personal-override',
  'browser-default-missing',
  'browser-not-stored',
  ...SETUP_PROBLEM_CODES,
  'docker-needed',
  'database-url-ignored',
  /** A workflow file failing its load check (#15): not offered on a card, not run. */
  'workflow-problem',
] as const;

const LOGIN_CODE = { expired: 'login-expired', missing: 'login-missing' } as const;
const TOOL_CODE = { missing: 'tool-missing', old: 'tool-old', failed: 'tool-failed' } as const;

export const SettingsProblem = z.object({
  kind: z.enum(PROBLEM_KINDS),
  /** `login-expired` · `login-missing` · `login-blocked` · `login-unchecked` · `tool-missing` · `tool-old` · `tool-failed` · a setup's (`SETUP_PROBLEM_CODES`) · `no-checks` · `personal-override` (info), or the merge's `ProblemCode`. */
  code: z.union([z.enum(CHECK_PROBLEM_CODES), ProblemCode]),
  /** What is wrong, one line. */
  text: z.string(),
  /** Where, dim: `Logins & tools › GitHub · gh auth status`. */
  where: z.string(),
  /** The page whose tree row counts it. */
  page: PageName,
  way: ProblemWay,
});
export type SettingsProblem = z.infer<typeof SettingsProblem>;

/** `abe settings problems`: every problem, worst first, and which checks ran. */
export const SettingsProblemsData = z.object({
  problems: z.array(SettingsProblem),
  checked: z.object({ logins: z.boolean(), tools: z.boolean() }),
});
export type SettingsProblemsData = z.infer<typeof SettingsProblemsData>;

export type ProblemsInput = {
  /** The merge's problems (`Merged.problems`): every file's and every refused entry. */
  settings: readonly SettingProblem[];
  /** `abe login status`'s answer; `undefined` when it was not checked. */
  logins?: LoginStatusData;
  /**
   * The AWS SSO session's login (its `sso-session` name); `undefined` when not checked. Serve
   * does not check it yet: Logins & tools' AWS SSO row (#108 S6) will.
   */
  awsSso?: { session: string; state: 'ok' | 'expired' | 'missing' };
  /** `abe tools check`'s tools; `undefined` when not checked. */
  tools?: readonly ToolCheck[];
  /** The checks in force in the checkout's repo (its folder's name); `undefined` outside a repo. */
  checks?: { repo: string; entries: readonly CheckEntry[] };
  /** Your own Overrides in force (`personalOverrides`): an info row each (#168). */
  overrides?: readonly PersonalOverride[];
  /** The board and cloud as set up (#158); `undefined` when not checked. */
  setup?: SetupFacts;
  /**
   * `abe browser list`'s answer on the Mac (#345); `stored`: your stored sign-ins were read (else
   * nothing is said of them). `undefined` when not checked (a box).
   */
  browser?: { list: BrowserListData; stored: boolean };
  /**
   * The Mac database (#349): whether the checkout's repo needs one, whether Docker answers, and
   * whether serve's environment has a `DATABASE_URL` (ignored); `undefined` when not checked.
   */
  database?: DatabaseFacts;
  /** The workflow files' load-check problems (#15, `abe workflow list`); `undefined`: not read. */
  workflows?: readonly WorkflowProblem[];
  /** The checkout's repo name, for the where-lines; `home` shortens your files to `~`. */
  scope: { repo: string | null; home?: string };
};

export type DatabaseFacts = {
  repo: string | null;
  needs: boolean;
  docker: 'up' | 'down' | 'missing';
  served: boolean;
};

const DATABASE_WAY: ProblemWay = { kind: 'open', page: 'logins-tools', row: 'tools' };

/** Docker not there for a repo that needs a database; serve's own `DATABASE_URL` ignored (#349). */
const databaseProblems = (d: DatabaseFacts): SettingsProblem[] => [
  ...(d.needs && d.docker !== 'up'
    ? [
        {
          kind: 'tool' as const,
          code: 'docker-needed' as const,
          text: `Docker isn't ${d.docker === 'missing' ? 'installed' : 'running'}: prototypes and local sessions of ${d.repo ?? 'this repo'} need it for their database`,
          where: 'Logins & tools › Docker · docker ps',
          page: 'logins-tools' as const,
          way: DATABASE_WAY,
        },
      ]
    : []),
  ...(d.served
    ? [
        {
          kind: 'setup' as const,
          code: 'database-url-ignored' as const,
          text: "DATABASE_URL is set in serve's environment and is ignored (each session and prototype gets its own)",
          where: "Logins & tools › Database · serve's environment",
          page: 'logins-tools' as const,
          way: DATABASE_WAY,
        },
      ]
    : []),
];

const loginProblems = (d: LoginStatusData): SettingsProblem[] =>
  checkedLogins(d).flatMap((tool): SettingsProblem[] => {
    const state = d.logins[tool] ?? 'unchecked';
    const l = LOGINS[tool];

    if (state === 'ok') return [];
    // #160: the tool's check could not run; its tool row says why and how to get it.
    if (state === 'unchecked')
      return [
        {
          kind: 'login',
          code: 'login-unchecked',
          text: `${l.label} login can't be checked: ${plainText(d.unchecked?.[tool] ?? `${l.check} did not run`)}`,
          where: `Logins & tools › ${l.label} · ${l.check}`,
          page: 'logins-tools',
          way: { kind: 'open', page: 'logins-tools', row: 'tools' },
        },
      ];

    const blocked = d.blocked?.[tool];

    // #237: Entra refused it, as its Logins row says: no sign-in gets past that, its words say what does.
    if (blocked !== undefined)
      return [
        {
          kind: 'login',
          code: 'login-blocked',
          text: `${l.label} login blocked by Entra: ${entraBlockText(blocked)}`,
          where: `Logins & tools › ${l.label} · ${l.check}`,
          page: 'logins-tools',
          way: { kind: 'open', page: 'logins-tools', row: null },
        },
      ];

    return [
      {
        kind: 'login',
        code: LOGIN_CODE[state],
        text: `${l.label} login ${state} — sign in${state === 'expired' ? ' again' : ''}`,
        where: `Logins & tools › ${l.label} · ${l.check}`,
        page: 'logins-tools',
        way: { kind: 'fix', command: loginFix(tool, d.secret, d.awsProfile, d.azureConfigDir) },
      },
    ];
  });

const awsProblems = (a: NonNullable<ProblemsInput['awsSso']>): SettingsProblem[] =>
  a.state === 'ok'
    ? []
    : [
        {
          kind: 'login',
          code: LOGIN_CODE[a.state],
          text: `AWS SSO session ${a.state} — sign in${a.state === 'expired' ? ' again' : ''}`,
          where: `Logins & tools › AWS SSO · sso-session ${a.session}`,
          page: 'logins-tools',
          way: { kind: 'fix', command: `aws sso login --sso-session ${a.session}` },
        },
      ];

/** A Browser profiles row's place and way (its home row, else the page). */
const profilesRow = (key: 'browser.default' | 'browser.profiles') => {
  const row = homeRowOf(key);
  const page = row?.page ?? 'browser-profiles';

  return {
    where: `${pageOf(page).label} › ${row?.label ?? key}`,
    page,
    row: row?.id ?? null,
  };
};

const browserProblems = (b: NonNullable<ProblemsInput['browser']>): SettingsProblem[] => {
  const missing = b.list.missingDefault;
  const def = profilesRow('browser.default');
  const profiles = profilesRow('browser.profiles');

  return [
    ...(missing === null
      ? []
      : [
          {
            kind: 'browser' as const,
            code: 'browser-default-missing' as const,
            text: `browser.default names ${missing}, which no Layer has: a launch with no --profile starts the empty default — pick one in Default profile`,
            where: def.where,
            page: def.page,
            way: { kind: 'open' as const, page: def.page, row: def.row },
          },
        ]),
    // one opened on this Mac (its Chrome folder is here) and never stored; the built-in default
    // is empty by design, a profile never opened here is not yours to sign in yet
    ...(b.stored
      ? b.list.profiles
          .filter((p) => p.layer !== 'built-in' && p.folder === true && p.storedAt === null)
          .map((p) => ({
            kind: 'browser' as const,
            code: 'browser-not-stored' as const,
            text: `${p.name} has no sign-ins stored: a box starts it signed out — abe browser open ${p.name}, sign in, then abe browser store ${p.name}`,
            where: `${profiles.where} · ${p.name}`,
            page: profiles.page,
            way: { kind: 'fix' as const, command: `abe browser open ${p.name}` },
          }))
      : []),
  ];
};

const toolProblems = (tools: readonly ToolCheck[]): SettingsProblem[] =>
  tools.flatMap((t) =>
    t.state === 'ok' || !toolProblem(t) // (the first narrows `t.state` for TOOL_CODE)
      ? []
      : [
          {
            kind: 'tool',
            code: TOOL_CODE[t.state],
            // `node not found on serve's PATH`, `node 16.2 is too old: …`, `Docker: engine not running`.
            text: `${t.label}${t.state === 'failed' ? ':' : ''} ${plainText(t.message ?? t.state)}`,
            where: `Logins & tools › ${t.label} · ${t.check}`,
            page: 'logins-tools',
            way:
              t.fix === null
                ? { kind: 'open', page: 'logins-tools', row: 'tools' }
                : { kind: 'fix', command: t.fix },
          },
        ],
  );

/** Factory › Checks, where the checks are shown. */
const checksRow = (): { page: PageId; way: ProblemWay } => {
  const row = homeRowOf('checks');

  return row === undefined
    ? { page: 'factory-policy', way: { kind: 'open', page: 'factory-policy', row: null } }
    : { page: row.page, way: { kind: 'open', page: row.page, row: row.id } };
};

/**
 * The repo's checks as a Problem (#159): none with a command (a repo with no pack), so a Factory
 * run's checks run nothing. A check named with no command beside one that has is not listed: its
 * result says `not configured`, and silencing it here would take an Override.
 */
const checksProblems = (c: NonNullable<ProblemsInput['checks']>): SettingsProblem[] => {
  if (checksConfigured(c.entries)) return [];
  const unset = unconfiguredChecks(c.entries);
  const { page, way } = checksRow();

  return [
    {
      kind: 'checks',
      code: 'no-checks',
      text: `repo ${c.repo} has no checks: ${unset.length === 0 ? 'none is named with a command' : `${unset.join(', ')} ${unset.length === 1 ? 'has' : 'have'} no command`}, so a Factory run checks nothing before review — give each a run: command under checks: in abe.yaml (abe settings check . prints one from its scripts)`,
      where: `${pageOf(page).label} › Checks · abe.yaml in ${c.repo}`,
      page,
      way,
    },
  ];
};

const layerWords = (layer: Layer, file: string, scope: ProblemsInput['scope']): string => {
  switch (layer) {
    case 'repo':
      return `repo ${scope.repo ?? 'this checkout'}`;
    case 'individual':
      return placeOfFile(file) === 'local' ? `yours for ${scope.repo ?? 'this checkout'}` : 'yours';
    case 'core':
    case 'feel':
      return 'built-in';
  }
};

const fileWords = (layer: Layer, file: string, scope: ProblemsInput['scope']): string => {
  const repo = scope.repo ?? 'this checkout';

  if (layer === 'repo') return `abe.yaml in ${repo}`;
  if (layer === 'individual' && placeOfFile(file) === 'local')
    return `.abe/settings.local.yaml in ${repo}`;
  const home = scope.home;

  // yours on this Mac, by its path
  return home !== undefined && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
};

const FILE_CODES: ReadonlySet<ProblemCode> = new Set(['bad-layer-file', 'invalid-override']);

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** A Layer file's own problem: the file opened, not the Layers page that lists it (#126). */
const openFile = (file: string): ProblemWay => ({ kind: 'file', path: file });

const settingProblem = (p: SettingProblem, scope: ProblemsInput['scope']): SettingsProblem => {
  const row = p.key !== null && isSettingKey(p.key) ? homeRowOf(p.key) : undefined;
  const file = fileWords(p.layer, p.file, scope);
  const at = (page: PageId, label: string) => `${pageOf(page).label} › ${label} · ${file}`;
  // A refused entry's message starts with its file: the where-line says it.
  const message = p.message.startsWith(`${p.file}: `)
    ? p.message.slice(p.file.length + 2)
    : p.message;

  if (p.code === 'reason-required' && row !== undefined)
    return {
      kind: 'override-reason',
      code: p.code,
      text: `Override without a reason: ${lowerFirst(row.label)} overridden by ${layerWords(p.layer, p.file, scope)} — add the reason or remove the override`,
      where: at(row.page, row.label),
      page: row.page,
      way: { kind: 'open', page: row.page, row: row.id },
    };
  // Not dropped but read another way: a theme no one has, a target read as local (#172, #166).
  const named = p.code === 'unknown-theme' || p.code === 'unknown-scheme';
  const readAs =
    named ||
    (p.code === 'invalid-setting' &&
      p.key !== null &&
      isSettingKey(p.key) &&
      SETTINGS[p.key].safe !== undefined);

  if (readAs && row !== undefined)
    return {
      kind: 'dropped',
      code: p.code,
      text: `${row.label} in ${layerWords(p.layer, p.file, scope)} names ${message}`,
      where: at(row.page, row.label),
      page: row.page,
      way: named
        ? { kind: 'fix', command: 'abe theme list' }
        : { kind: 'open', page: row.page, row: row.id },
    };
  if (FILE_CODES.has(p.code) || p.key === null)
    return {
      kind: 'layer-file',
      code: p.code,
      text: `${file} does not read${p.key === null ? '' : ` at ${p.key}`}: ${message}`,
      where: `Layers › ${file}`,
      page: 'layers',
      way: openFile(p.file),
    };

  return {
    kind: 'dropped',
    code: p.code,
    text: `${row?.label ?? p.key} in ${layerWords(p.layer, p.file, scope)} is dropped: ${message}`,
    where: row === undefined ? `Layers › ${file}` : at(row.page, row.label),
    page: row?.page ?? 'layers',
    way: row === undefined ? openFile(p.file) : { kind: 'open', page: row.page, row: row.id },
  };
};

/**
 * One of your Overrides as an info row (#168): what it sets, why, since when; its way out the
 * proposal that would make it the repo's, typed into the fix strip, never run unasked.
 */
const overrideRow = (o: PersonalOverride): SettingsProblem => {
  const row = homeRowOf(o.key);
  const page = row?.page ?? 'layers';
  const since = o.since === null ? '' : ` (since ${o.since.slice(0, 10)})`;

  return {
    kind: 'override',
    code: 'personal-override',
    text: `Your Override: ${lowerFirst(row?.label ?? o.key)} ${o.shown} — ${o.reason}${since}; it holds for your runs only`,
    where: `${row === undefined ? o.key : `${pageOf(page).label} › ${row.label}`} · your Layer`,
    page,
    way: { kind: 'fix', command: proposeCommand(o.key, o.value, o.reason) },
  };
};

/** A workflow file's problem (#15), as in code: the file opened at its line. */
const workflowProblem = (p: WorkflowProblem): SettingsProblem => {
  const name = p.file.split('/').at(-1) ?? p.file;

  return {
    kind: 'layer-file',
    code: 'workflow-problem',
    text:
      p.code === 'not-yaml'
        ? p.text
        : `Can't run ${name}${p.line === null ? '' : `: line ${p.line}`}, ${lowerFirst(p.text)}`,
    where: `Layers › workflows/${name} · ${p.layer}`,
    page: 'layers',
    way: openFile(p.file),
  };
};

/** An info row (#168: your Override), not a problem: never counted, never landed on. */
export const isInfoRow = (p: SettingsProblem): boolean => p.kind === 'override';

/** The rows that are problems (`isInfoRow` left out): what counts and lands. */
export const problemsOnly = (ps: readonly SettingsProblem[]): SettingsProblem[] =>
  ps.filter((p) => !isInfoRow(p));

const RANK: Readonly<Record<SettingsProblem['kind'], number>> = {
  login: 0,
  tool: 1,
  setup: 2,
  checks: 3,
  'override-reason': 4,
  'layer-file': 5,
  dropped: 6,
  browser: 7,
  override: 8,
};

/** Every problem, worst first (a stable order within a kind). */
export const settingsProblems = (o: ProblemsInput): SettingsProblem[] =>
  [
    ...(o.logins === undefined ? [] : loginProblems(o.logins)),
    ...(o.awsSso === undefined ? [] : awsProblems(o.awsSso)),
    ...(o.tools === undefined ? [] : toolProblems(o.tools)),
    ...(o.database === undefined ? [] : databaseProblems(o.database)),
    ...(o.setup === undefined ? [] : setupProblems(o.setup)),
    ...(o.checks === undefined ? [] : checksProblems(o.checks)),
    ...(o.browser === undefined ? [] : browserProblems(o.browser)),
    ...o.settings.map((p) => settingProblem(p, o.scope)),
    ...(o.workflows ?? []).map(workflowProblem),
    ...(o.overrides ?? []).map(overrideRow),
  ].sort((a, b) => RANK[a.kind] - RANK[b.kind]);

const wayText = (way: ProblemWay) => {
  switch (way.kind) {
    case 'fix':
      return `fix: ${way.command}`;
    case 'file':
      return `open: ${way.path}`;
    case 'open':
      return `open: ${pageOf(way.page).crumb}${way.row === null ? '' : ` › ${way.row}`}`;
  }
};

/** An info row's way: the proposal for the repo, suggested. */
const suggestText = (way: ProblemWay) =>
  way.kind === 'fix' ? `suggest: ${way.command}` : wayText(way);

export const settingsProblemsText = (d: SettingsProblemsData): string => {
  const unchecked = [d.checked.logins ? '' : 'logins', d.checked.tools ? '' : 'tools'].filter(
    (w) => w !== '',
  );
  const note = unchecked.length === 0 ? '' : ` (${unchecked.join(', ')} not checked)`;
  const lines = d.problems.flatMap((p) =>
    isInfoRow(p)
      ? [`i ${p.text}`, `    ${p.where}`, `    ${suggestText(p.way)}`]
      : [`! ${p.text}`, `    ${p.where}`, `    ${wayText(p.way)}`],
  );
  const none = problemsOnly(d.problems).length === 0;

  return `${[...lines, `${none ? 'No problems' : 'No other problems'}${note}`].join('\n')}\n`;
};
