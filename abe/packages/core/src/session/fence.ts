/**
 * A local session's own tools, held to its boundary whatever the permission mode (#181). The
 * jail holds its shell (`sessionBoundary`: environment access only, ADR 0029); Claude's
 * file tools and WebFetch run outside it, and in auto mode the classifier would answer their asks.
 * No deny rule can say "everything but the worktree", so serve answers their `PreToolUse` (a hook's
 * deny holds in every mode): a write outside the places the shell writes is refused, and so is a
 * WebFetch to a host the shell does not reach (none while `hosts` is `OPEN_NETWORK`).
 *
 * Pure: serve gives the real paths' resolver (links are followed where a tool writes); the hook
 * prints the answer.
 *
 * Not closed here: a link swapped in by a shell running beside the tool, between this check and
 * the write (the file tools run outside the sandbox, so nothing holds the write itself). The
 * jail still keeps the state and what decides its reach from the shell.
 */
import { z } from 'zod';
import { absolutePath, type PreToolAnswer, realPathOf } from './permission';
import { SANDBOX_CACHES } from './session';

/** Every host: a local session's network is open (ADR 0029). */
export const OPEN_NETWORK = ['*'] as const;

/**
 * The variable a local session's `claude` runs with, `1`: the hook refuses a fenced tool when
 * serve cannot check it (late, gone), never letting it through unchecked. No `ABE_` name: those
 * are a session's secrets, redacted from its logs (`isSessionSecret`).
 */
export const FENCE_ENV = 'FENCED_BY_ABE';

/** The tools whose PreToolUse serve answers for a local session; the hook waits for those. */
export const FENCED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'Skill',
] as const;

/** Where a local session's file tools write, and the hosts WebFetch reaches. Real paths. */
export type SessionFence = {
  /** The session's worktree (an Improve or prototype chat's folder), named in a refusal. */
  worktree: string;
  /**
   * The worktree, its Before worktree, its writers' worktrees, the package caches and Claude
   * Code's plan files.
   */
  writable: readonly string[];
  /** An exact host, `*.<domain>` for any host under it, or `*` for any (`OPEN_NETWORK`). */
  hosts: readonly string[];
};

/**
 * Claude Code's sandbox's `TMPDIR` (`/tmp/claude`, its shell writes there), as written and as its
 * real path on macOS.
 */
const SANDBOX_TMP = ['/tmp/claude', '/private/tmp/claude'] as const;

/**
 * The fence of a session working in `worktree` of `checkout`: the places its sandbox writes, and
 * Claude Code's own plan files (`~/.claude/plans`, plan mode's), nothing else of `~/.claude`.
 * Nowhere a `.git` (`gitRefusal`).
 */
export const sessionFence = (o: {
  worktree: string;
  checkout: string;
  home: string;
  /** A card's Before worktree (`baseWorktreePath`, #182), where Run runs too. */
  base?: string;
}): SessionFence => ({
  worktree: o.worktree,
  writable: [
    // Not known yet (it starts): no root of its own, never `''` (under which every path is).
    ...(o.worktree === '' ? [] : [o.worktree]),
    ...(o.base === undefined || o.base === '' ? [] : [o.base]),
    `${o.checkout}/.claude/worktrees`,
    ...SANDBOX_CACHES.map((cache) => `${o.home}/${cache}`),
    `${o.home}/.claude/plans`,
    ...SANDBOX_TMP,
  ],
  // the network is open (ADR 0029): its jail is about secrets and files, not the internet
  hosts: OPEN_NETWORK,
});

const Pre = z.looseObject({
  tool_name: z.enum(FENCED_TOOLS),
  tool_input: z.unknown().optional(),
  cwd: z.string().optional(),
});
const FilePath = z.looseObject({ file_path: z.string() });
const NotebookPath = z.looseObject({ notebook_path: z.string() });
const Url = z.looseObject({ url: z.string() });
const SkillName = z.looseObject({ skill: z.string() });

const deny = (reason: string): PreToolAnswer => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * A write refused, why first (a step row keeps a line's start): `what` the path, or how it ends up
 * outside (`<path> is a link to <real>`).
 */
const writeRefusal = (tool: string, fence: SessionFence, what: string) =>
  deny(
    `${tool} refused: outside this session's worktree (${fence.worktree}), the only place its tools write: ${what}. Write inside the worktree, or tell the person what to change there.`,
  );

/**
 * The path up to its first `.git` (any case: macOS's file system ignores it), when it has one: a
 * worktree's `.git` file names the repository git runs in, its config and hooks (serve's own git
 * too, outside the sandbox), so no file tool writes one, nor anything in one.
 */
const gitPart = (path: string): string | undefined => {
  const parts = path.split('/');
  const at = parts.findIndex((part) => part.toLowerCase() === '.git');

  return at === -1 ? undefined : parts.slice(0, at + 1).join('/');
};

const gitRefusal = (tool: string, git: string) =>
  deny(
    `${tool} refused: ${git} is git's own (where the repository and its hooks are), which this session's tools never write.`,
  );

/**
 * Whether `path`, below the fence root it is under, is Claude Code's own config for the project:
 * any `.claude` folder (its settings, hooks scripts, and skills, agents and commands, whose
 * frontmatter hooks run outside the sandbox), or a `.mcp.json` (any case, as macOS's file system
 * reads them). The roots' own `.claude` (`~/.claude/plans`, `.claude/worktrees`) do not count.
 */
const claudeConfig = (path: string, fence: SessionFence): boolean => {
  const root = fence.writable.find((r) => under(path, r));

  if (root === undefined) return false;
  const parts = path.slice(root.length).toLowerCase().split('/');

  return parts.includes('.claude') || parts.at(-1) === '.mcp.json';
};

const claudeRefusal = (tool: string, path: string) =>
  deny(
    `${tool} refused: ${path} is Claude Code's own config for this project (its settings, hooks, skills, agents, commands, MCP servers), which this session's tools never write. Tell the person what to change there.`,
  );

/**
 * How the fence reads links: `realpath` resolves a path that exists, `readlink` (when given) a
 * link to one not there yet, `hardLinks` (when given) a file's number of names (undefined: no
 * file there).
 */
export type Links = {
  realpath: (path: string) => string;
  readlink?: (path: string) => string;
  hardLinks?: (path: string) => number | undefined;
  /**
   * A folder's subfolders by name, links to folders too (`link`: looked into, not walked below;
   * a bare skill name's search, #213).
   */
  dirs?: (path: string) => readonly { name: string; link: boolean }[];
  /** A bare name's search stopped at its depth or folder cap (serve logs it: the walk let it by). */
  cut?: (worktree: string, name: string) => void;
};

const hardLinksOf = (path: string, links: Links): number | undefined => {
  try {
    return links.hardLinks?.(path);
  } catch {
    return undefined;
  }
};

const writeAnswer = (
  tool: string,
  input: unknown,
  cwd: string | undefined,
  fence: SessionFence,
  links: Links,
): PreToolAnswer | undefined => {
  // The path the tool named writes: NotebookEdit's notebook, never a `file_path` beside it.
  const written =
    tool === 'NotebookEdit'
      ? NotebookPath.safeParse(input).data?.notebook_path
      : FilePath.safeParse(input).data?.file_path;
  if (written === undefined)
    return deny(`${tool} refused: its path could not be read, so where it writes is unknown.`);
  const at = absolutePath(written, cwd);

  if (at === undefined) return writeRefusal(tool, fence, `${written} names no absolute path`);
  const real = realPathOf(at, links.realpath, links.readlink);

  if (real === undefined) return writeRefusal(tool, fence, `${at} could not be resolved`);
  const git = gitPart(at) ?? gitPart(real);

  if (git !== undefined) return gitRefusal(tool, git);
  if (!fence.writable.some((root) => under(real, root)))
    return writeRefusal(tool, fence, real === at ? at : `${at} is a link to ${real}`);
  if (claudeConfig(at, fence) || claudeConfig(real, fence)) return claudeRefusal(tool, at);
  // A hard link's other name may be anywhere: the write lands there too.
  const names = hardLinksOf(real, links);

  return names !== undefined && names > 1
    ? deny(
        `${tool} refused: ${at} is a hard link (${names} names), so the write would land outside this session's worktree too. Write a new file instead.`,
      )
    : undefined;
};

const reaches = (host: string, pattern: string) =>
  pattern === '*' ||
  (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern);

/**
 * A URL's host as WebFetch reaches it, lower case, no port or userinfo; undefined when it does not
 * read plainly (not http(s), an odd authority): refused then. A backslash ends the authority, as
 * it does in a browser's URL parser (`https://evil.example\@github.com` reaches evil.example).
 */
const hostOf = (url: string): string | undefined => {
  const authority = /^https?:\/\/([^/?#\\]*)/i.exec(url.trim())?.[1];

  if (authority === undefined) return undefined;
  const host = authority
    .slice(authority.lastIndexOf('@') + 1)
    .replace(/:\d*$/, '')
    .replace(/\.$/, '')
    .toLowerCase();

  return /^[a-z0-9.-]+$/.test(host) ? host : undefined;
};

const fetchAnswer = (input: unknown, fence: SessionFence): PreToolAnswer | undefined => {
  const url = Url.safeParse(input);
  const host = url.success ? hostOf(url.data.url) : undefined;

  if (host === undefined || host === '')
    return deny('WebFetch refused: its URL could not be read, so the host it reaches is unknown.');
  if (fence.hosts.some((pattern) => reaches(host, pattern))) return undefined;

  return deny(`WebFetch refused: ${host} is outside this session's network.`);
};

/**
 * A skill Claude Code found in a folder of the session's worktree (`<dir>:<name>`, a nested
 * `.claude/skills`): refused, as its frontmatter hooks run outside the sandbox. The sandbox holds
 * every `.claude` there, but a folder moved or linked in from `/tmp/claude` or a package cache
 * brings one along (seatbelt checks a rename's ends only). Any other skill is not the fence's.
 */
const skillAnswer = (
  input: unknown,
  cwd: string | undefined,
  fence: SessionFence,
  links: Links,
): PreToolAnswer | undefined => {
  const name = SkillName.safeParse(input).data?.skill;
  const cut = name?.lastIndexOf(':') ?? -1;

  if (name === undefined || cut === 0) return undefined;
  const roots = [...new Set([fence.worktree, cwd ?? ''])].filter((root) => root !== '');
  const refused = (dir: string) =>
    deny(
      `Skill refused: ${name} is a skill in ${dir}, inside this session's worktree, where its hooks would run outside the sandbox. Tell the person about it instead.`,
    );

  if (cut < 0) {
    const nested = bareNested(name, fence, links);

    return nested === undefined ? undefined : refused(nested);
  }
  for (const root of roots) {
    const dir = absolutePath(`${name.slice(0, cut)}/.claude/skills/${name.slice(cut + 1)}`, root);

    if (dir === undefined || !under(dir, root)) continue;
    if (!exists(dir, links)) continue;

    return refused(dir);
  }

  return undefined;
};

const exists = (path: string, links: Links): boolean => {
  try {
    links.realpath(path);

    return true;
  } catch {
    return false;
  }
};

/** How deep a bare skill name is looked for below the worktree, and how many folders at most. */
const NESTED_DEPTH = 6;
const NESTED_FOLDERS = 20_000;
/**
 * Folders a bare name is not looked for in: git's own, package installs and build output (too big
 * to walk; under the folder cap they would leave the rest unwalked).
 */
const NOT_WALKED = new Set([
  '.git',
  'node_modules',
  '.claude',
  'target',
  'dist',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
]);

/**
 * A bare skill name Claude Code offered (#213): the project's own (`<worktree>/.claude/skills`)
 * when there is one, else a nested `<dir>/.claude/skills/<name>`
 * below the worktree (a folder moved or linked in from `/tmp/claude` brings one), found by a walk;
 * undefined when none is there (a built-in or a plugin's skill: not the fence's).
 */
const bareNested = (name: string, fence: SessionFence, links: Links): string | undefined => {
  if (links.dirs === undefined || name.includes('/') || name.startsWith('.')) return undefined;
  // the project's own: Claude Code names a nested one of the same name `<dir>:<name>`
  if (exists(`${fence.worktree}/.claude/skills/${name}`, links)) return undefined;
  const list = links.dirs;
  let seen = 0;
  const walked = { cut: false };
  const walk = (dir: string, depth: number, link: boolean): string | undefined => {
    const skill = `${dir}/.claude/skills/${name}`;

    if (depth > 0 && exists(skill, links)) return skill;
    if (link) return undefined;
    if (depth >= NESTED_DEPTH || seen >= NESTED_FOLDERS) {
      walked.cut = true;

      return undefined;
    }
    let subs: readonly { name: string; link: boolean }[];

    try {
      subs = list(dir);
    } catch {
      return undefined;
    }
    for (const sub of subs) {
      if (NOT_WALKED.has(sub.name)) continue;
      seen += 1;
      const found = walk(`${dir}/${sub.name}`, depth + 1, sub.link);

      if (found !== undefined) return found;
    }

    return undefined;
  };
  const found = walk(fence.worktree, 0, false);

  if (found === undefined && walked.cut) links.cut?.(fence.worktree, name);

  return found;
};

/**
 * A local session's PreToolUse answered: a deny for a fenced tool reaching past the fence, else
 * undefined (nothing printed: Claude Code's own rules and mode decide).
 */
export const fenceAnswer = (
  payload: unknown,
  fence: SessionFence,
  o: Links,
): PreToolAnswer | undefined => {
  const p = Pre.safeParse(payload);

  if (!p.success) return undefined;
  const { tool_name: tool, tool_input: input, cwd } = p.data;

  if (tool === 'WebFetch') return fetchAnswer(input, fence);
  if (tool === 'Skill') return skillAnswer(input, cwd, fence, o);

  return writeAnswer(tool, input, cwd, fence, o);
};
