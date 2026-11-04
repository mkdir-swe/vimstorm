/**
 * A repo's hook points (ADR 0035): the scripts, skills and headings Abe calls by role, declared in
 * `abe.yaml`'s `hooks:` (the team's). Abe never names a path: each caller asks this module for a
 * role's path, the install's checks for a skill's name or a heading, a box for what `abe run` may
 * run. A role left out is today's place, so a repo that declares nothing runs as before.
 *
 * Where the map comes from: what serve runs itself reads the main checkout's `abe.yaml` as the
 * settings do; what an agent may run (`runScriptIn`, a Mac session's and a box's alike) reads the
 * main checkout's committed one (`HEAD:abe.yaml`), resolved on the Mac and handed to a box with
 * its sync, never the clone's, which the agent writes. Pure.
 */
import { z } from 'zod';

/**
 * Where a repo's own skills are, from the checkout's top (ADR 0031): Claude Code's project skills
 * folder, the team's, in `git diff` like abe.yaml. Abe never commits it nor keeps it out of git.
 */
export const REPO_SKILLS_DIR = '.claude/skills';

/** The roles that are scripts: each a path from the checkout's top. */
export const SCRIPT_ROLES = [
  'start',
  'stop',
  'seed',
  'db',
  'query',
  'prototype-start',
  'prototype-stop',
  'worktree-setup',
] as const;
export type ScriptRole = (typeof SCRIPT_ROLES)[number];

/** The script roles `abe run` takes: all but the worktree's, which serve alone runs. */
export const RUN_ROLES = [
  'start',
  'stop',
  'seed',
  'db',
  'query',
  'prototype-start',
  'prototype-stop',
] as const satisfies readonly ScriptRole[];
export type RunRole = (typeof RUN_ROLES)[number];

/** The roles that are skills, by their folder's name under `REPO_SKILLS_DIR`. */
export const SKILL_ROLES = ['run-app', 'testing', 'verify'] as const;
export type SkillRole = (typeof SKILL_ROLES)[number];

/** The roles that are headings the install checks: `CLAUDE.md`'s, the run-app skill's. */
export const HEADING_ROLES = ['find-out', 'read-data'] as const;
export type HeadingRole = (typeof HEADING_ROLES)[number];

export const HOOK_ROLES = [...SCRIPT_ROLES, ...SKILL_ROLES, ...HEADING_ROLES] as const;
export type HookRole = (typeof HOOK_ROLES)[number];

/** One segment of a hook's path or a skill's name: no `.`, `..`, space or shell character. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A script's path from the checkout's top: relative, inside it, plain segments only. */
const HookPath = z
  .string()
  .trim()
  .refine((p) => !p.includes('..') && p.split('/').every((s) => SEGMENT.test(s)), {
    error: 'a path in the checkout, from its top (letters, digits, . _ -, no ..)',
  });

/** A skill's folder name under `.claude/skills`. */
const SkillName = z.string().trim().regex(SEGMENT, { error: 'a skill folder name' });

/** A Markdown heading line, as the file has it (`## Read data`). */
const Heading = z
  .string()
  .trim()
  .regex(/^#{1,6} \S/, { error: 'a Markdown heading line (## …)' });

/** `hooks:` as `abe.yaml` writes it: each role may be left out (today's place). */
export const DeclaredHooks = z.strictObject({
  start: HookPath.optional(),
  stop: HookPath.optional(),
  seed: HookPath.optional(),
  db: HookPath.optional(),
  query: HookPath.optional(),
  'prototype-start': HookPath.optional(),
  'prototype-stop': HookPath.optional(),
  'worktree-setup': HookPath.optional(),
  'run-app': SkillName.optional(),
  testing: SkillName.optional(),
  verify: SkillName.optional(),
  'find-out': Heading.optional(),
  'read-data': Heading.optional(),
});
export type DeclaredHooks = z.infer<typeof DeclaredHooks>;

/**
 * The map in force, every role filled: what a box is handed. `worktree-setup` null: no script.
 * `testing` and `verify` null: not declared, so any `<name>-testing` skill is the testing one and
 * the Verification pack is `verify-<app>` (`verifySkill`), any `verify-*` one's scripts runnable.
 */
export const RepoHooks = z.object({
  start: z.string(),
  stop: z.string(),
  seed: z.string(),
  db: z.string(),
  query: z.string(),
  'prototype-start': z.string(),
  'prototype-stop': z.string(),
  'worktree-setup': z.string().nullable(),
  'run-app': z.string(),
  testing: z.string().nullable(),
  verify: z.string().nullable(),
  'find-out': z.string(),
  'read-data': z.string(),
});
export type RepoHooks = z.infer<typeof RepoHooks>;

/**
 * The map in force from what `abe.yaml` declares: each role left out today's place. The app's
 * scripts sit in the run-app skill's `scripts/` (`.claude/skills/run-app/scripts/<role>`), a
 * prototype's in `abe/scripts/`; no worktree script unless `worktree-setup` is declared.
 */
export const repoHooks = (declared?: DeclaredHooks): RepoHooks => {
  const d = declared ?? {};
  const runApp = d['run-app'] ?? 'run-app';
  const app = (name: string) => `${REPO_SKILLS_DIR}/${runApp}/scripts/${name}`;

  return {
    start: d.start ?? app('start'),
    stop: d.stop ?? app('stop'),
    seed: d.seed ?? app('seed'),
    db: d.db ?? app('db'),
    query: d.query ?? app('query'),
    'prototype-start': d['prototype-start'] ?? 'abe/scripts/prototype-start',
    'prototype-stop': d['prototype-stop'] ?? 'abe/scripts/prototype-stop',
    'worktree-setup': d['worktree-setup'] ?? null,
    'run-app': runApp,
    testing: d.testing ?? null,
    verify: d.verify ?? null,
    'find-out': d['find-out'] ?? '## Find out before you ask',
    'read-data': d['read-data'] ?? '## Read data',
  };
};

/** The map in force from a checkout's settings values (`hooks`). */
export const repoHooksIn = (values: { hooks?: DeclaredHooks | undefined }): RepoHooks =>
  repoHooks(values.hooks);

/** The map of a repo that declares nothing. */
export const DEFAULT_HOOKS: RepoHooks = repoHooks();

/**
 * The map in force from a parsed `abe.yaml` (its document; none: none): its `hooks:`. A `hooks:`
 * that does not parse is today's places, never a guess.
 */
export const repoHooksOfDoc = (doc: unknown): RepoHooks => {
  const top = z.looseObject({ hooks: z.unknown().optional() }).safeParse(doc).data;

  return repoHooks(DeclaredHooks.safeParse(top?.hooks ?? {}).data);
};

/** The run-app skill's folder, its `SKILL.md`, and its `scripts/` (where `abe run <name>` looks). */
export const runAppSkill = (h: RepoHooks) => {
  const dir = `${REPO_SKILLS_DIR}/${h['run-app']}`;

  return { dir, skill: `${dir}/SKILL.md`, scripts: `${dir}/scripts` };
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

/** The pack's skill name Abe derives for a checkout (`/x/demo-shop` → `verify-demo-shop`). */
export const verifySkillName = (repo: string): string =>
  `verify-${slug(repo.replace(/\/+$/, '').split('/').at(-1) ?? '')}`;

/** The Verification pack's skill of a checkout: the declared one, else `verify-<app>`. */
export const verifySkill = (h: RepoHooks, repo: string): string =>
  h.verify ?? verifySkillName(repo);

/** The repo's testing skills of the skill folders `names`: the declared one, else any `*-testing`. */
export const testingSkills = (h: RepoHooks, names: readonly string[]): string[] =>
  names.filter((n) => (h.testing === null ? n.endsWith('-testing') : n === h.testing));

/** The testing skill the install asks for when there is none (`<app>-testing`, or the declared). */
export const testingSkillWanted = (h: RepoHooks, app: string): string =>
  h.testing ?? `${app}-testing`;

/** Whether a Markdown text has the role's heading as a line of its own. */
export const hasHeading = (h: RepoHooks, role: HeadingRole, text: string): boolean =>
  text.split('\n').some((line) => line.trimEnd() === h[role]);

/** Each script role's path, the worktree's when there is one. */
export const hookScripts = (h: RepoHooks): string[] =>
  SCRIPT_ROLES.flatMap((r) => {
    const p = h[r];

    return p === null ? [] : [p];
  });

/**
 * Where the scripts sit: each script's folder (a script at the top: the file alone), so a helper
 * beside a script travels with it. In first-seen order, a folder inside another one left out.
 */
export const hookScriptDirs = (h: RepoHooks): string[] => {
  const dirs = hookScripts(h).map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : p));
  const unique = [...new Set(dirs)];

  return unique.filter((d) => !unique.some((o) => o !== d && d.startsWith(`${o}/`)));
};

/** The trees an agent's `abe run` works in: its worktree (a box's clone) and Before's beside it. */
export type RunTrees = { workdir: string; base: string };

/** What `abe run` runs: the script from its tree's top, the tree, and its role when it has one. */
export type RunScript = { cwd: string; script: string; role?: RunRole };

const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What an agent's `abe run <path>` runs, and in which tree (Mac and box alike, by `trees`):
 * - a role's script by its role (`start`, `prototype-start`) or its path;
 * - a script of the run-app skill's `scripts/` (or its bare name);
 * - a script of the Verification pack's `scripts/` (the declared skill's, else any `verify-*`'s);
 * in `workdir`, or by its absolute path in `workdir` or `base`. Nothing else: no other folder, no
 * `..`, no subfolder, never the worktree's own script.
 */
export const runScriptIn = (h: RepoHooks, trees: RunTrees, path: string): RunScript | undefined => {
  const tree = [trees.workdir, trees.base].find((t) => path.startsWith(`${t}/`));

  if (tree === undefined && path.startsWith('/')) return undefined;
  const raw = tree === undefined ? path : path.slice(tree.length + 1);
  const rest = raw.replace(/^\.\//, '');
  const roleOf = (script: string) => RUN_ROLES.find((r) => h[r] === script);
  const app = runAppSkill(h).scripts;
  const verify = h.verify === null ? 'verify-[a-z0-9][a-z0-9_-]*' : escape(h.verify);
  const inFolders = new RegExp(
    `^(?:${escape(app)}|${escape(REPO_SKILLS_DIR)}/${verify}/scripts)/${NAME}$`,
  );
  const bare = tree === undefined && BARE_NAME.test(raw) ? raw : undefined;
  const named = RUN_ROLES.find((r) => r === bare);
  const byPath = roleOf(rest) !== undefined || inFolders.test(rest) ? rest : undefined;
  // a bare name: its role's script, else the run-app skill's of that name
  const byName = bare === undefined ? undefined : `${app}/${bare}`;
  const script = named === undefined ? (byName ?? byPath) : h[named];

  if (script === undefined || script.includes('..')) return undefined;
  const role = roleOf(script);

  return { cwd: tree ?? trees.workdir, script, ...(role === undefined ? {} : { role }) };
};

/** What `abe run` says it takes, in its refusal: the roles, the run-app skill's and the pack's scripts. */
export const runScriptsWords = (h: RepoHooks): string =>
  `a role (${RUN_ROLES.join(', ')}), <name> or ${runAppSkill(h).scripts}/<name>, or ${REPO_SKILLS_DIR}/${h.verify ?? 'verify-<app>'}/scripts/<name>`;
