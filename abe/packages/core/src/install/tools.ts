/**
 * `abe tools check` (#108): the tools Abe and its sessions run, each checked the way `serve` runs
 * it (on serve's own PATH), with its version or `not found`. The rules here: which tools, the
 * command each check runs, how its version reads, the oldest one that works and the fix's
 * command. Running them is the `ToolProbe` port's.
 */
import { z } from 'zod';
import { type FoundManager, managerOf, NODE_MANAGERS, nodeFix } from './serve-path';
import { shellWord } from '../session/session';

export const TOOLS = ['node', 'tmux', 'docker', 'az', 'gh', 'claude', 'git', 'rg', 'aws'] as const;
export const ToolName = z.enum(TOOLS);
export type ToolName = z.infer<typeof ToolName>;

type ToolSpec = {
  /** How Logins & tools names it. */
  label: string;
  /** The check it runs. */
  argv: readonly string[];
  /** The version in its output, or `undefined` when it says none. */
  version: (stdout: string) => string | undefined;
  /** The oldest version that works, when one is known. */
  min?: string;
  /** The Homebrew formula (or cask) that installs it on a Mac. */
  brew: string;
  /** What a check that ran but failed means (Docker's engine down), and its fix on a Mac. */
  failed?: { message: string; fix: string };
  /** On a Mac only what needs it (Docker: `the fake box and image builds`): not there is no problem. */
  optional?: string;
  /**
   * What alone needs it, when only some setups do (az: `Azure Boards boards`, ADR 0042): where
   * none here needs it, it is optional with no fix (install.sh leaves it out); where one does, a
   * tool Abe needs, its fix said.
   */
  onlyFor?: string;
};

const first = (re: RegExp) => (out: string) => re.exec(out)?.[1];

/**
 * The oldest Claude Code a session's settings work with (#179, #190): an older one (Volta's npm
 * 2.1.39) rejects their hook events with a Settings Error dialog before any hook runs.
 */
export const CLAUDE_MIN = '2.1.300';

export const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>> = {
  // Claude Code needs Node 18 or newer.
  node: {
    label: 'node',
    argv: ['node', '--version'],
    version: first(/v?(\d[\w.]*)/),
    min: '18',
    brew: 'node',
  },
  tmux: { label: 'tmux', argv: ['tmux', '-V'], version: first(/tmux (\S+)/), brew: 'tmux' },
  docker: {
    label: 'Docker',
    argv: ['docker', 'info', '--format', '{{.ServerVersion}}'],
    version: first(/^(\d[\w.]*)/m),
    brew: '--cask docker',
    failed: { message: 'engine not running', fix: 'open -a Docker' },
    // a box's workspace runs in it; a Mac's sessions do not (#164)
    optional: 'the fake box and image builds',
  },
  az: {
    label: 'az',
    argv: ['az', 'version', '--output', 'json'],
    version: first(/"azure-cli":\s*"([^"]+)"/),
    brew: 'azure-cli',
    onlyFor: 'Azure Boards boards',
  },
  gh: { label: 'gh', argv: ['gh', '--version'], version: first(/gh version (\S+)/), brew: 'gh' },
  claude: {
    label: 'claude',
    argv: ['claude', '--version'],
    version: first(/^(\d[\w.]*)/m),
    min: CLAUDE_MIN,
    brew: '--cask claude-code',
  },
  git: {
    label: 'git',
    argv: ['git', '--version'],
    version: first(/git version (\S+)/),
    brew: 'git',
  },
  rg: { label: 'rg', argv: ['rg', '--version'], version: first(/ripgrep (\S+)/), brew: 'ripgrep' },
  aws: {
    label: 'aws',
    argv: ['aws', '--version'],
    version: first(/aws-cli\/(\S+)/),
    brew: 'awscli',
    onlyFor: 'sessions on your boxes (serve.target: cloud)',
  },
};

/**
 * What one check gave: not on PATH, or where it was found (`at`, and `real`, the file a link
 * there resolves to: whose manager it is), its exit and output.
 */
export type ToolRan =
  | { found: false }
  | { found: true; at?: string; real?: string; exit: number; stdout: string; stderr: string };

export const TOOL_STATES = ['ok', 'missing', 'old', 'failed'] as const;

export const ToolCheck = z.object({
  tool: ToolName,
  label: z.string(),
  state: z.enum(TOOL_STATES),
  /** Its version as it says it, or `null` (not found, or none read). */
  version: z.string().nullable(),
  /** The check as it ran: `command -v node, as abe serve runs it` when not found. */
  check: z.string(),
  min: z.string().nullable(),
  /** What is wrong in words (`not found on serve's PATH`), or `null` when ok. */
  message: z.string().nullable(),
  /** The command that fixes it (`brew install node`), or `null`: none on a box, or none needed. */
  fix: z.string().nullable(),
  /** Where serve found it (`/home/ada/.volta/bin/node`), or `null`: not found, or not said. */
  where: z.string().nullable().default(null),
  /** node's version manager (#145) it is under (`Volta`, `Homebrew`), or `null`: none known. */
  manager: z
    .enum([...NODE_MANAGERS, 'Homebrew'])
    .nullable()
    .default(null),
  /**
   * What alone needs it, when this Mac can do without it (Docker: `the fake box and image builds`):
   * its not being there or not answering is then no problem. `null`: a tool Abe needs.
   */
  optional: z.string().nullable().default(null),
});
export type ToolCheck = z.infer<typeof ToolCheck>;

/** `abe tools check`: each tool as this Mac's (or this box's) `serve` sees it. */
export const ToolsCheckData = z.object({
  where: z.enum(['this Mac', 'this box']),
  tools: z.array(ToolCheck),
});
export type ToolsCheckData = z.infer<typeof ToolsCheckData>;

/** How a screen names `where` (the value stays as serve sends it). */
export const TOOLS_WHERE_WORDS: Readonly<Record<ToolsCheckData['where'], string>> = {
  'this Mac': 'this machine',
  'this box': 'this box',
};

const parts = (v: string) => v.split(/[.+-]/).map((p) => Number.parseInt(p, 10));

/** Whether `version` is older than `min`, by numeric parts (`3.5a` reads as 3.5). */
export const olderThan = (version: string, min: string): boolean => {
  const a = parts(version);
  const b = parts(min);

  for (let i = 0; i < b.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;

    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x < y;
  }

  return false;
};

/** A failed check's first line of stderr, else its exit. */
const failure = (ran: { exit: number; stderr: string }) => {
  const line = ran.stderr.trim().split('\n')[0] ?? '';

  return line === '' ? `exit ${ran.exit}` : line;
};

/**
 * One tool's check read: its state, version and way out. On a box the image owns its tools: no
 * fix. node's fix is its version manager's (#145): the one its node is under, else the first
 * found on this Mac (`managers`), else Homebrew's. A tool only some setups need (`onlyFor`) and
 * this one does not (`needed` leaves it out) is optional, with no fix.
 */
export const toolCheck = (
  tool: ToolName,
  ran: ToolRan,
  onBox: boolean,
  managers: readonly FoundManager[] = [],
  needed: readonly ToolName[] = [],
): ToolCheck => {
  const spec = TOOL_SPECS[tool];
  const unneeded = !onBox && spec.onlyFor !== undefined && !needed.includes(tool);
  const brew = (verb: 'install' | 'upgrade') =>
    onBox || unneeded ? null : `brew ${verb} ${spec.brew}`;
  const optional = unneeded ? spec.onlyFor : spec.optional;
  const at = ran.found ? (ran.at ?? null) : null;
  const real = ran.found ? (ran.real ?? at) : null;
  const manager =
    tool === 'node' && at !== null && real !== null
      ? (managerOf(at, managers) ?? managerOf(real, managers))
      : null;
  // A node under a manager (its shim with no version set, too old) is fixed with that manager.
  const under = managers.filter((m) => m.manager === manager);
  const base = {
    tool,
    label: spec.label,
    min: spec.min ?? null,
    where: at,
    manager,
    optional: onBox ? null : (optional ?? null),
  };
  const ranAs = spec.argv.join(' ');

  if (!ran.found) {
    const installed = tool === 'node' ? managers[0] : undefined;

    return {
      ...base,
      state: 'missing',
      version: null,
      check: `command -v ${spec.argv[0] ?? tool}, as abe serve runs it`,
      message: `not found on serve's PATH${installed === undefined ? '' : `; ${installed.manager} is installed but has no node`}`,
      fix: installed === undefined || onBox ? brew('install') : nodeFix([installed]),
    };
  }
  if (ran.exit !== 0)
    return {
      ...base,
      state: 'failed',
      version: null,
      check: ranAs,
      message: spec.failed?.message ?? failure(ran),
      fix: onBox ? null : (spec.failed?.fix ?? (under.length === 0 ? null : nodeFix(under))),
    };
  const version = spec.version(ran.stdout) ?? null;

  // An old claude is updated by its own `update` (Homebrew's, the native installer's, npm's);
  // an old node with the manager it is under.
  const own = tool === 'claude' && at !== null ? `${shellWord(at)} update` : null;
  const upgrade = own ?? (under.length === 0 ? brew('upgrade') : nodeFix(under));

  if (version !== null && spec.min !== undefined && olderThan(version, spec.min))
    return {
      ...base,
      state: 'old',
      version,
      check: ranAs,
      // claude: which one of them.
      message: `${version}${own === null ? '' : ` at ${at ?? ''}`} is too old: ${spec.min} or newer`,
      fix: onBox ? null : upgrade,
    };

  return { ...base, state: 'ok', version, check: ranAs, message: null, fix: null };
};

/**
 * claude's check over every `claude` on serve's PATH, in order (#179): the first one's, and when
 * it is too old (or does not run) but a later one is new enough, said so, naming the one a
 * session runs (`claudeForSession`).
 */
export const claudeCheck = (rans: readonly ToolRan[], onBox: boolean): ToolCheck => {
  const checks = rans.map((r) => toolCheck('claude', r, onBox));
  const head = checks[0];

  if (head === undefined) return toolCheck('claude', { found: false }, onBox);
  const used = checks.find((c) => c.state === 'ok');

  if (head.state === 'ok' || used === undefined) return head;

  return {
    ...head,
    message: `${head.version ?? head.message ?? '?'} at ${head.where ?? '?'} comes first on PATH and is too old (${CLAUDE_MIN} or newer); sessions use ${used.version ?? '?'} at ${used.where ?? '?'}`,
  };
};

/**
 * The `claude` a local session runs (#179, #190): the first on its PATH (`rans`, in order) that
 * is new enough, never an older one first; none: refused before anything starts, saying which
 * one, its version and the fix.
 */
export const claudeForSession = (
  rans: readonly ToolRan[],
  path: string,
):
  { ok: true; path: string } | { ok: false; code: 'no-claude' | 'old-claude'; message: string } => {
  const checks = rans.map((r) => toolCheck('claude', r, false));
  const used = checks.find((c) => c.state === 'ok' && c.where !== null);

  if (used?.where !== undefined && used.where !== null) return { ok: true, path: used.where };
  const head = checks[0];

  if (head === undefined)
    return {
      ok: false,
      code: 'no-claude',
      message: `claude is not on the session's PATH: ${path}`,
    };
  const what =
    head.state === 'old'
      ? `claude ${head.version ?? '?'} at ${head.where ?? '?'} is older than ${CLAUDE_MIN}, which a session's settings need (its hooks)`
      : `claude at ${head.where ?? '?'} does not run (${head.message ?? head.state})`;
  const fix = head.where === null ? '' : `${shellWord(head.where)} update, or `;

  return {
    ok: false,
    code: 'old-claude',
    message: `${what}: ${fix}put a newer claude first on PATH (abe tools check)`,
  };
};

const pad = (text: string, n: number) => text.padEnd(n);

/** Whether a check is a problem: not ok, and a tool this Mac needs. */
export const toolProblem = (t: ToolCheck): boolean => t.state !== 'ok' && t.optional === null;

/** `✓ 3.5a`, `⚠ not found on serve's PATH`, `○ not found · optional: only the fake box …`. */
export const toolWords = (t: ToolCheck): string => {
  if (t.state === 'ok') return `✓ ${t.version ?? 'ok'}`;
  const what = t.message ?? t.state;

  return t.optional === null ? `⚠ ${what}` : `○ ${what} · optional: only ${t.optional} need it`;
};

export const toolsCheckText = (d: ToolsCheckData): string =>
  `${[
    `tools on ${TOOLS_WHERE_WORDS[d.where]}, as abe serve runs them:`,
    ...d.tools.map(
      (t) =>
        `  ${pad(t.label, 7)}${toolWords(t)}${t.manager === null ? '' : ` · ${t.manager} ${t.where ?? ''}`}${t.fix === null ? '' : `  (${t.fix})`}`,
    ),
  ].join('\n')}\n`;
