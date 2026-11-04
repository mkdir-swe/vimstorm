/**
 * A repo's worktree recipe (`worktree:` in `abe.yaml`, the team's): what a new worktree of the repo
 * (a card's, its Before worktree, a prototype's) gets from the main checkout beyond what git puts
 * there, so its checks and app run as they do in the main checkout. `link`: untracked files and
 * folders linked to the checkout's (an env file: one edit reaches every card); `copy`: copied, the
 * worktree's own to change. Its script is the repo's `worktree-setup` hook (`hooks:`), run by serve
 * outside the sandbox last, in the new worktree. The team's files Abe reads (`abe.yaml`,
 * `.claude/skills`, `CLAUDE.md`, `AGENTS.md`) come without being listed.
 *
 * Each list is flat or grouped per environment (ADR 0040): `all` every run, `dev`, `test` and
 * `prod` only while that environment is on for agents (ADR 0029; a `prod:` group never turns prod
 * on). The group is the file's env placement: it replaces the install's env map for that file.
 * A flat list's env file is placed by the install's env map (the record), as before. An env file
 * placed only in environments off for agents, or not placed yet, is left out with why, the group
 * named. The recipe is the repo's to change: its Abe chat fixes a run that stalled on a missing
 * file there, with no change to Abe. Pure.
 */
import { z } from 'zod';
import { ABE_ENVS, type AbeEnv } from '../install/credentials';
import { offRepoEnvFiles } from '../install/agent-envs';
import { type WorktreeCopy } from './setup';

/** How long the recipe's script may run. */
export const WORKTREE_SCRIPT_TIMEOUT_MS = 10 * 60_000;

/**
 * The agent notes a worktree gets as the main checkout has them, like `abe.yaml` and
 * `.claude/skills`, uncommitted ones held out of the card's commits (`WorktreeCopy.over`).
 */
export const AGENT_NOTE_FILES: readonly string[] = ['CLAUDE.md', 'AGENTS.md'];

/** Where a file missing in a worktree is fixed: the repo's recipe, never Abe. */
export const WORKTREE_FIX =
  "add it to abe.yaml's worktree.link (or copy, or the hooks.worktree-setup script), or ask the Abe chat";

/** A path in the checkout, from its top: never absolute, never out of it. */
const RecipePath = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
    error: 'a path in the checkout, from its top',
  });

/** A list's groups (ADR 0040): `all`, every run; an environment's, only while it is on for agents. */
export const RECIPE_GROUPS = ['all', ...ABE_ENVS] as const;
export type RecipeGroup = (typeof RECIPE_GROUPS)[number];

const RecipeList = z.array(RecipePath);

/** A list grouped per environment: each group's paths, each group may be left out. */
export const RecipeGroups = z.strictObject({
  all: RecipeList.optional(),
  dev: RecipeList.optional(),
  test: RecipeList.optional(),
  prod: RecipeList.optional(),
});
export type RecipeGroups = z.infer<typeof RecipeGroups>;

/** A recipe's list: flat (env files placed by the install's env map) or grouped per environment. */
export const RecipeEntries = z.union([RecipeList, RecipeGroups]);
export type RecipeEntries = z.infer<typeof RecipeEntries>;

/**
 * The recipe as `abe.yaml` writes it; each part may be left out. Its script is the
 * `worktree-setup` hook (`hooks:`).
 */
export const WorktreeRecipe = z.strictObject({
  link: RecipeEntries.optional(),
  copy: RecipeEntries.optional(),
});
export type WorktreeRecipe = z.infer<typeof WorktreeRecipe>;

/** Where a repo env file goes: the environments it feeds, not used, or not sure. */
export type EnvPlace = readonly AbeEnv[] | 'not-used' | 'not-sure';

/**
 * One repo env file's placement, as every reader takes it: from `abe.yaml` (`from: 'recipe'`, a
 * group's, with the groups that name it: `worktree.link.dev`; `always`: in an `all` group, every
 * run whatever is on) or the install's env map on this Mac (`from: 'record'`).
 */
export type EnvPlaced = {
  path: string;
  to: EnvPlace;
  from: 'recipe' | 'record';
  groups?: readonly string[];
  always?: true;
};

/** Every path a list names, each once, in its order (a grouped one's: all, dev, test, prod). */
export const recipePaths = (list: RecipeEntries | undefined): string[] => {
  if (list === undefined) return [];
  if (Array.isArray(list)) return [...new Set(list)];

  return [...new Set(RECIPE_GROUPS.flatMap((g) => list[g] ?? []))];
};

/** Whether a recipe groups a list per environment: its groups then place its env files. */
export const recipeGrouped = (recipe: WorktreeRecipe | undefined): boolean =>
  [recipe?.link, recipe?.copy].some((l) => l !== undefined && !Array.isArray(l));

/**
 * Each path the recipe's grouped lists name, with the groups naming it and those groups by their
 * place in `abe.yaml` (`worktree.link.dev`).
 */
const groupedPaths = (
  recipe: WorktreeRecipe | undefined,
): Map<string, { groups: RecipeGroup[]; named: string[] }> => {
  const out = new Map<string, { groups: RecipeGroup[]; named: string[] }>();

  for (const part of ['link', 'copy'] as const) {
    const list = recipe?.[part];

    if (list === undefined || Array.isArray(list)) continue;
    for (const g of RECIPE_GROUPS)
      for (const path of list[g] ?? []) {
        const was = out.get(path) ?? { groups: [], named: [] };

        out.set(path, {
          groups: [...new Set([...was.groups, g])],
          named: [...new Set([...was.named, `worktree.${part}.${g}`])],
        });
      }
  }

  return out;
};

/**
 * Each repo env file's placement, `abe.yaml` first (ADR 0040): a path a grouped list names goes
 * where its groups say (`all`: every environment, every run); then each key or env file
 * `env.notUsed` names (`notUsed`), not used; then the install's env map on this Mac (`mapping`) for
 * the paths neither names: a flat list's, an older install's.
 */
export const envPlacement = (
  recipe: WorktreeRecipe | undefined,
  mapping: readonly { path: string; to: EnvPlace }[],
  notUsed: readonly { key: string }[] = [],
): EnvPlaced[] => {
  const grouped = groupedPaths(recipe);
  const fromRecipe = [...grouped].map(([path, { groups, named }]): EnvPlaced => {
    const always = groups.includes('all');

    return {
      path,
      to: always ? [...ABE_ENVS] : ABE_ENVS.filter((e) => groups.includes(e)),
      from: 'recipe',
      groups: named,
      ...(always ? { always: true as const } : {}),
    };
  });
  const unused = [...new Set(notUsed.map((n) => n.key))]
    .filter((key) => !grouped.has(key))
    .map((path): EnvPlaced => ({ path, to: 'not-used', from: 'recipe' }));
  const said = new Set([...grouped.keys(), ...unused.map((u) => u.path)]);

  return [
    ...fromRecipe,
    ...unused,
    ...mapping
      .filter((m) => !said.has(m.path))
      .map((m): EnvPlaced => ({ path: m.path, to: m.to, from: 'record' })),
  ];
};

/** Why an env file is left out: the groups that name it are off, its environments are, or it is not placed yet. */
const skipWhy = (p: EnvPlaced): string => {
  if (typeof p.to === 'string')
    return "not placed yet: in no abe.yaml worktree group, nor the install's env map";
  const off = p.to.join(', ');
  const one = p.to.length === 1;

  return p.groups !== undefined && p.groups.length > 0
    ? `${p.groups.join(', ')}: ${off} ${one ? 'is' : 'are'} off for agents`
    : `feeds only ${off}, off for agents`;
};

/**
 * The recipe's files as a worktree gets them (`WorktreeCopy`, `listed`): each linked or copied;
 * one placed (`envPlacement`: the recipe's groups, then `mapping`, the install's env map) only in
 * environments off for agents (`enabled`: those on), or not placed yet, skipped with why; a
 * grouped list's group off for agents skipped whole. A path listed twice is linked.
 */
export const recipeCopies = (
  recipe: WorktreeRecipe | undefined,
  mapping: readonly { path: string; to: EnvPlace }[],
  enabled: readonly AbeEnv[],
  notUsed: readonly { key: string }[] = [],
): WorktreeCopy[] => {
  const placed = envPlacement(recipe, mapping, notUsed);
  const off = offRepoEnvFiles(placed, enabled);
  const links = recipePaths(recipe?.link);
  const copies = recipePaths(recipe?.copy).filter((p) => !links.includes(p));

  return [
    ...links.map((path) => ({ path, link: true as const })),
    ...copies.map((path) => ({ path })),
  ].map((c): WorktreeCopy => {
    const p = placed.find((x) => x.path === c.path);
    const skip = p !== undefined && off.includes(c.path) ? skipWhy(p) : undefined;

    return { ...c, listed: true, ...(skip === undefined ? {} : { skip }) };
  });
};

/** A grouped list as `abe.yaml` writes it: its groups in order, an empty one left out. */
const groupsWritten = (groups: ReadonlyMap<RecipeGroup, readonly string[]>): RecipeGroups =>
  Object.fromEntries(
    RECIPE_GROUPS.flatMap((g) => {
      const paths = groups.get(g) ?? [];

      return paths.length === 0 ? [] : [[g, [...paths]]];
    }),
  );

/** A list's paths by group: a flat one's all in `all` (every run, as before). */
const groupsOf = (list: RecipeEntries | undefined): Map<RecipeGroup, string[]> => {
  if (list === undefined) return new Map();
  if (Array.isArray(list)) return new Map([['all', [...new Set(list)]]]);

  return new Map(RECIPE_GROUPS.map((g) => [g, [...(list[g] ?? [])]]));
};

/** The list with `path` in it every run: a flat one's at its end, a grouped one's in `all`. */
export const withEveryRun = (list: RecipeEntries | undefined, path: string): RecipeEntries =>
  list === undefined || Array.isArray(list)
    ? [...(list ?? []), path]
    : { ...list, all: [...(list.all ?? []), path] };

/**
 * The recipe with the install's env map (`mapping`, the session's judgement) written into it as
 * groups (ADR 0040), the rest of it kept: a file feeding every environment goes in `all`, any
 * other in each environment's group it feeds, in `copy` when the recipe copies it, else `link`;
 * a not-sure one leaves the groups (placed by none, it is held and skipped until the person
 * places it); a not-used one stays where it was. A flat list's other paths go in `all` (every
 * run, as before). A map that places no file in an environment leaves the recipe as it is.
 */
export const recipeWithMap = (
  recipe: WorktreeRecipe | undefined,
  mapping: readonly { path: string; to: EnvPlace }[],
): WorktreeRecipe => {
  const was = recipe ?? {};

  if (!mapping.some((m) => Array.isArray(m.to))) return was;
  const parts = new Map(
    (['link', 'copy'] as const).map((part) => [part, groupsOf(was[part])] as const),
  );
  const copied = new Set(recipePaths(was.copy));

  for (const m of mapping) {
    if (m.to === 'not-used') continue;
    for (const groups of parts.values())
      for (const [g, paths] of groups)
        groups.set(
          g,
          paths.filter((p) => p !== m.path),
        );
    if (m.to === 'not-sure') continue;
    const into = parts.get(copied.has(m.path) ? 'copy' : 'link');
    const to: readonly RecipeGroup[] = ABE_ENVS.every((e) => m.to.includes(e)) ? ['all'] : m.to;

    for (const g of to) into?.set(g, [...(into.get(g) ?? []), m.path]);
  }
  const out: WorktreeRecipe = {};

  for (const [part, groups] of parts) {
    const written = groupsWritten(groups);

    if (Object.keys(written).length > 0) out[part] = written;
  }

  return out;
};
