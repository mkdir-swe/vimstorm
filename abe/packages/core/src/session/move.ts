/**
 * Download locally and Move to cloud (#88): recovery only. A session's work is copied from where
 * it runs to the other side (a cloud session's Workspace on its box to this Mac, or the other way)
 * and the same session goes on there. What is copied: the branch's commits to its head, the staged
 * and the unstaged diff, the untracked files, `.scratch/` and Claude Code's transcript (as a log
 * in `.scratch/` and as Claude Code's own session file, so `claude --resume` continues). What is
 * left behind: the paths of `LEFT_BEHIND` and the repo pack's `move.leave` globs (packages,
 * builds, write credentials), and whatever runs (servers, terminals, the Reach a box's session had).
 */
import { z } from 'zod';
import { testFileRegex } from '../factory/checks';
import { MOVE_SIDES, type MoveSide, SESSION_STATES } from './session';

export const LEAVE_REASONS = ['packages', 'build', 'credentials', 'repo'] as const;
export type LeaveReason = (typeof LEAVE_REASONS)[number];

/**
 * Core's defaults, each a `.gitignore`-like pattern (`testFiles`' rules: `x/` a folder anywhere,
 * a name with no `/` at any depth, else a path from the root) and why it stays.
 */
export const LEFT_BEHIND: readonly { glob: string; why: Exclude<LeaveReason, 'repo'> }[] = [
  { glob: 'node_modules/', why: 'packages' },
  { glob: '.pnpm-store/', why: 'packages' },
  { glob: '.venv/', why: 'packages' },
  { glob: '.yarn/cache/', why: 'packages' },
  { glob: 'dist/', why: 'build' },
  { glob: 'build/', why: 'build' },
  { glob: 'out/', why: 'build' },
  { glob: '.next/', why: 'build' },
  { glob: '.turbo/', why: 'build' },
  { glob: 'coverage/', why: 'build' },
  { glob: 'target/', why: 'build' },
  { glob: '*.tsbuildinfo', why: 'build' },
  { glob: '.env', why: 'credentials' },
  { glob: '.env.*', why: 'credentials' },
  { glob: '.aws/', why: 'credentials' },
  { glob: '.npmrc', why: 'credentials' },
  { glob: '.netrc', why: 'credentials' },
  { glob: '*.pem', why: 'credentials' },
  { glob: '*.key', why: 'credentials' },
];

/** What never crosses, whatever the files: it runs, or it is the box's alone. */
const NOT_CARRIED = [
  'running servers and terminals',
  'Reach write credentials (a session on this machine reads only)',
] as const;

/** Why `path` (relative to the worktree) stays behind, or undefined: it is copied. */
export const leftBehind = (path: string, repoGlobs: readonly string[]): LeaveReason | undefined => {
  const hit = LEFT_BEHIND.find((l) => testFileRegex(l.glob).test(path));

  if (hit !== undefined) return hit.why;

  return repoGlobs.some((g) => testFileRegex(g).test(path)) ? 'repo' : undefined;
};

export type MovePlan = {
  copied: string[];
  left: { path: string; why: LeaveReason }[];
  /** Listed paths no worktree of ours lists (`unsafeMovePath`): the whole move is refused. */
  unsafe: string[];
};

/**
 * A path a move never writes: out of the worktree (absolute, a `..` step) or into a `.git`
 * folder (its hooks run). Neither `git ls-files --others` nor `find .scratch` lists one, so one
 * listed means the other side is not what it says.
 */
export const unsafeMovePath = (path: string): boolean => {
  // `.GIT` is `.git` on a case-insensitive disk (a Mac's)
  const steps = path.split('/').map((s) => s.toLowerCase());

  return path.startsWith('/') || steps.includes('..') || steps.includes('.git');
};

/**
 * The listed files (the untracked ones and `.scratch/`'s, relative to the worktree) split into
 * what is copied and what stays; an unsafe path is neither.
 */
export const movePlan = (listed: readonly string[], repoGlobs: readonly string[]): MovePlan => {
  const plan: MovePlan = { copied: [], left: [], unsafe: [] };

  for (const path of [...new Set(listed)].sort()) {
    if (path === '') continue;
    if (unsafeMovePath(path)) {
      plan.unsafe.push(path);
      continue;
    }
    const why = leftBehind(path, repoGlobs);

    if (why === undefined) plan.copied.push(path);
    else plan.left.push({ path, why });
  }

  return plan;
};

/** The transcript's log as a move names it to a box: relative, inside `.scratch/`, no `..`. */
export const transcriptInScratch = (path: string): boolean =>
  path.startsWith('.scratch/') && !unsafeMovePath(path);

/** Where the transcript is kept as a log in the worktree: beside the card's other Evidence. */
export const movedTranscriptLog = (card: number, session: string): string =>
  `.scratch/${card}/sessions/${session}.jsonl`;

/** Claude Code's folder for a working folder under `~/.claude/projects/`: each non-alphanumeric a `-`. */
const claudeProjectFolder = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** Claude Code's own session file for a session started in `cwd` (a real path). */
export const claudeSessionFile = (home: string, cwd: string, claudeSession: string): string =>
  `${home.replace(/\/+$/, '')}/.claude/projects/${claudeProjectFolder(cwd)}/${claudeSession}.jsonl`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Claude Code session id, as its session file is named: a lower-case UUID. */
export const ClaudeSession = z.string().regex(UUID, 'not a Claude session id');

/**
 * The Claude session a hook's `transcript_path` names (`…/.claude/projects/<folder>/<uuid>.jsonl`),
 * or undefined for any other path.
 */
export const claudeSessionOf = (transcriptPath: string | null): string | undefined => {
  if (transcriptPath === null) return undefined;
  const parts = transcriptPath.split('/');
  const file = parts.at(-1) ?? '';
  const folder = parts.at(-2) ?? '';
  const id = file.replace(/\.jsonl$/, '');

  return parts.at(-3) === 'projects' &&
    parts.at(-4) === '.claude' &&
    folder !== '' &&
    folder !== '.' &&
    folder !== '..' &&
    file.endsWith('.jsonl') &&
    UUID.test(id)
    ? id
    : undefined;
};

/**
 * The transcript as Claude Code's session file in its new place: each line's `cwd` (the folder it
 * ran in) is the new folder; every other line byte for byte, one that is not JSON too.
 */
export const resumedTranscript = (text: string, from: string, to: string): string =>
  text
    .split('\n')
    .map((line) => {
      if (!line.includes('"cwd"')) return line;
      let doc: unknown;

      try {
        doc = JSON.parse(line);
      } catch {
        return line;
      }
      const read = z.looseObject({ cwd: z.string() }).safeParse(doc);

      if (!read.success || read.data.cwd !== from) return line;

      return JSON.stringify({ ...read.data, cwd: to });
    })
    .join('\n');

/** The prompt the moved session's `claude --resume` goes on with. */
export const movedPrompt = (to: MoveSide): string =>
  to === 'local'
    ? 'This session was moved from your cloud environment to this machine (Download locally): the same branch, changes and files, without node_modules or builds (the setup ran again). Reach here is read-only. Carry on where you left off.'
    : 'This session was moved from this machine to your cloud environment (Move to cloud): the same branch, changes and files, without node_modules or builds (the setup ran again). Carry on where you left off.';

/** `abe session download` / `move-to-cloud`. */
export const SessionMoveData = z.object({
  id: z.string(),
  card: z.number().int().positive(),
  from: z.enum(MOVE_SIDES),
  to: z.enum(MOVE_SIDES),
  /** The Workspace's box: the one left (download) or the one it goes to. */
  box: z.string(),
  /** The worktree it goes on in: this Mac's, or the box's clone. */
  worktree: z.string(),
  branch: z.string(),
  /** The head commit carried over. */
  head: z.string(),
  /** The session where it goes on, as it stands now (queued past the team's box limit). */
  state: z.enum(SESSION_STATES),
  copied: z.object({
    staged: z.boolean(),
    unstaged: z.boolean(),
    files: z.array(z.string()),
    transcript: z.boolean(),
  }),
  left: z.array(z.object({ path: z.string(), why: z.enum(LEAVE_REASONS) })),
  /** Download: the box was stopped, its disk kept (false: the stop failed, said in `note`). */
  boxStopped: z.boolean().nullable(),
  note: z.string().nullable(),
});
export type SessionMoveData = z.infer<typeof SessionMoveData>;

const LEAVE_WORDS: Readonly<Record<LeaveReason, string>> = {
  packages: 'packages',
  build: 'builds',
  credentials: 'credentials',
  repo: "the repo's move.leave",
};

/** The left-behind paths by why, each with its count. */
const leftWords = (left: SessionMoveData['left']): string => {
  if (left.length === 0) return 'nothing listed';
  const counts = new Map<LeaveReason, number>();

  for (const l of left) counts.set(l.why, (counts.get(l.why) ?? 0) + 1);

  return [...counts].map(([why, n]) => `${LEAVE_WORDS[why]} (${n})`).join(', ');
};

export const sessionMoveText = (d: SessionMoveData): string => {
  const where = d.to === 'local' ? 'this machine' : `box ${d.box}`;
  const copied = [
    `the commits to ${d.head.slice(0, 7)}`,
    ...(d.copied.staged ? ['the staged diff'] : []),
    ...(d.copied.unstaged ? ['the unstaged diff'] : []),
    `${d.copied.files.length} files (untracked, .scratch)`,
    ...(d.copied.transcript ? ['the transcript'] : []),
  ];
  const box =
    d.boxStopped === null
      ? []
      : [`  box      ${d.box} ${d.boxStopped ? 'stopped, its disk kept' : 'not stopped'}`];

  return `${[
    `${d.id}  AB#${d.card} moved to ${where}${d.state === 'queued' ? ' (queued: past your box limit)' : ''}`,
    `  worktree ${d.worktree}  ${d.branch}`,
    `  copied   ${copied.join(', ')}`,
    `  left     ${leftWords(d.left)}; ${NOT_CARRIED.join(', ')}`,
    ...box,
    ...(d.note === null ? [] : [`  note     ${d.note}`]),
  ].join('\n')}\n`;
};

/** The way out when the Workspace's box does not answer a download (`box-unreachable`). */
export const boxUnreachableMessage = (
  box: string,
  repo: string,
  card: number,
  why: string,
): string =>
  `${box} did not answer (${why}): abe box status ${box} says whether it runs; asleep, wake it with abe box up ${repo} ${card}, then download again`;
