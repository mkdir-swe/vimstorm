/**
 * A prototype session (`/abe:prototype X` in the Abe chat, `abe prototype start <words…>`; ADR
 * 0018 PT7): real code in a throwaway worktree, `proto/<card or id>-<slug>` off the default branch
 * with no upstream and a pre-push hook that refuses, in a Claude Code session with the prototype
 * skill that keeps a card session's jail. The app runs from that worktree behind the prototype
 * proxy: its `url` is the preview link. Nothing of it ships: `abe prototype make-card` makes a
 * plain card of it (its diff and screenshots in the org store as the card's reference) and
 * Discard throws the worktree away. The rules here: the branch, the hook, the session's words, the
 * upload and the answers.
 */
import { z } from 'zod';
import { Clearing } from '../factory/factory-pr';
import { CORE_INSTRUCTIONS } from '../skills/instructions';
import {
  type OrgPrototype,
  type OrgPrototypeVersion,
  type Upload,
  versionPrefix,
} from './make-card';
import { type Screenshot } from './prototype';
import { type Settings } from '../layer/settings';
import { Effort, launchPrompt } from '../session/session';
import { allows, type PluginFile, PLUGIN_NAME } from '../skills/subagents';
import { slugOf } from '../box/workspace';
import logic from '../../skills/prototype/LOGIC.md' with { type: 'text' };
import skill from '../../skills/prototype/SKILL.md' with { type: 'text' };
import protocol from '../../skills/prototype/PROTOCOL.md' with { type: 'text' };
import ui from '../../skills/prototype/UI.md' with { type: 'text' };

/** The skill a prototype session is launched on (`/abe:prototype`). */
const CODE_PROTOTYPE_SKILL = 'prototype';

/** What the session's plugin holds beside core's: Matt Pocock's prototype skill, as core ships it. */
export const CODE_PROTOTYPE_PLUGIN: readonly PluginFile[] = [
  { path: 'skills/prototype/SKILL.md', text: skill },
  { path: 'skills/prototype/PROTOCOL.md', text: protocol },
  { path: 'skills/prototype/UI.md', text: ui },
  { path: 'skills/prototype/LOGIC.md', text: logic },
];

/** Where prototypes' branches live: never pushed, never merged. */
export const PROTOTYPE_BRANCH_PREFIX = 'proto/';

/**
 * `proto/<key>-<slug>`: the throwaway branch, its key the card (`4`) or, with none, the
 * prototype's own (`1a2b3c` of `proto-1a2b3c`), its slug the card's title or the words.
 */
export const prototypeBranch = (key: number | string, title: string): string => {
  const slug = slugOf(title);
  const k = String(key).replace(/^proto-/, '');

  return slug === '' ? `${PROTOTYPE_BRANCH_PREFIX}${k}` : `${PROTOTYPE_BRANCH_PREFIX}${k}-${slug}`;
};

/**
 * What the session's own tools are refused besides the hook (Claude Code's deny rules, prefix
 * matches): a push, the hook turned off, or a pull request, typed as a command. The hook holds for
 * any push git makes with its hooks on; `--no-verify` or a script that turns them off is not
 * stopped by either (the sandbox reaches github.com for installs): the refusal keeps an agent
 * from shipping by mistake, it is no wall.
 */
export const CODE_PROTOTYPE_DENY = [
  'Bash(git push:*)',
  'Bash(git -c core.hooksPath:*)',
  'Bash(gh pr create:*)',
] as const;

/** The worktree's `pre-push` hook: every push refused, whatever the remote or ref. */
export const PRE_PUSH_HOOK = `#!/bin/sh
echo "abe: prototype-never-ships: this is a throwaway prototype; nothing of it is pushed. abe prototype make-card makes a card of it, built for real by a run." >&2
exit 1
`;

/** The session's title (Chat's header): the card it is for, else its words. */
export const prototypeTitle = (o: { card: number | null; words: string }): string => {
  const words = o.words.trim().split(/\s+/).slice(0, 6).join(' ');

  return o.card === null ? `Prototype · ${words}` : `Prototype · #${o.card}`;
};

/** The session's first prompt: the prototype skill invoked on the card, or on the words. */
export const codePrototypePrompt = (o: {
  card: Parameters<typeof launchPrompt>[0] | null;
  words: string;
}): string =>
  `/${PLUGIN_NAME}:${CODE_PROTOTYPE_SKILL} ${[o.words.trim(), ...(o.card === null ? [] : [launchPrompt(o.card)])].filter((w) => w !== '').join('\n\n')}`;

/**
 * What every prototype session is told of a design and of the database: a Figma link is read
 * with the person's Figma MCP server (loaded in every prototype session) and built with the
 * repo's own parts; the database is never migrated, a field it lacks mocked.
 */
export const PROTOTYPE_DESIGN_RULES = `Given a Figma link, read the design with the Figma MCP server (its design context and a screenshot of the node) and build it with the repo's own components and design tokens, never new ones beside them.

Never migrate the database or change its schema (no migration, no DDL, no seed of your own): the app may be on a shared dev database. A field the design needs that the database lacks is mocked in the backend's response.`;

/** Where the session's app runs: on its box, on the repo's fixed ports, or behind the proxy. */
const appWhere = (p: { id: string; onBox?: boolean; fixedPorts?: readonly number[] }): string => {
  const fixed = p.fixedPorts ?? [];

  if (p.onBox === true)
    return `You run in a workspace on a box. Start the app here as soon as there is something to see: \`abe run prototype-start\` (the repo's prototype-start script, with \`--env test\` when its \`# abe-env:\` line says test), or \`abe run start\` when the repo has no such script (a dev server reloads your edits as you save them); the person's machine forwards its port and \`abe prototype list\` there gives the preview link (prototype ${p.id}).`;
  if (fixed.length > 0)
    return `The app runs from this worktree the normal way, by the repo's start (\`abe run start\`'s script: its backend and its frontend), on the repo's own ports (${fixed.map((n) => `:${n}`).join(', ')}), with no proxy: the app's own URL is the preview link, so sign-in works as in the main checkout, in VimStorm's Preview as in the browser (prototype ${p.id}: \`abe prototype list --json\` gives it). One app holds those ports at a time: the main checkout's was stopped for this one and comes back when the prototype stops. A dev server reloads your edits as you save them; backend changes are fine, and \`abe prototype restart\` starts the app again when a change needs it.`;

  return `The app runs from this worktree by its start script, behind the prototype proxy (prototype ${p.id}: \`abe prototype list --json\` gives its url, the preview link); a dev server reloads your edits as you save them.`;
};

/** Core's instructions to the session, after Claude Code's own system prompt. */
export const codePrototypeInstructions = (p: {
  id: string;
  card: number | null;
  branch: string;
  base: string;
  commit: string;
  /** In a box's workspace (`serve.target` cloud): its app forwarded to the person's machine. */
  onBox?: boolean;
  /**
   * The ports the repo's app always takes (`ports.fixed`, what its install read fixed): on this
   * Mac its app starts the normal way on them, no proxy. None or empty: behind the proxy.
   */
  fixedPorts?: readonly number[];
}): string =>
  [
    CORE_INSTRUCTIONS,
    `## A prototype session

You write a throwaway prototype${p.card === null ? '' : ` of AB#${p.card}`} in real code, with the prototype skill. Your ${p.onBox === true ? 'clone' : 'worktree'} is on ${p.branch}, off ${p.base} at ${p.commit.slice(0, 7)}: it has no upstream and its pre-push hook refuses every push. ${appWhere(p)}

${PROTOTYPE_DESIGN_RULES}

Nothing ships: never push, never open a pull request, never run \`abe factory stage-done\` (refused: prototype-never-ships). Committing is not needed. ${
      p.onBox === true
        ? 'Keep the PNGs of what matters under .scratch/prototype/, each named for what it shows. When the person wants a card of it, tell them to ask the Abe chat on their machine (/abe:make-card, naming prototype ' +
          p.id +
          '): it reads your diff from this workspace.'
        : 'Keep a PNG of what matters with `abe prototype screenshot add --file <png> --what "<what it shows>"`. When the person wants a card of it, follow /abe:make-card: `abe prototype make-card --title … --description-file …` makes a plain card (your diff and screenshots go with it as its reference).'
    }`,
  ].join('\n');

/** What a prototype session runs on (#350): its model and effort, and why it is not the one asked. */
export const PrototypeModel = z.object({
  model: z.string(),
  effort: Effort.nullable(),
  /** `prototype.model` outside allowedModels: the first allowed instead, in words. */
  fellBack: z.string().nullable(),
});
export type PrototypeModel = z.infer<typeof PrototypeModel>;

/**
 * A new prototype session's model and effort (#350): `prototype.model` and `prototype.effort`,
 * held to allowedModels as every agent is (a family name allows its full ids): one it leaves out
 * falls to the first allowed, said in words.
 */
export const prototypeModel = (
  v: Pick<Settings, 'prototype.model' | 'prototype.effort'> & {
    allowedModels: readonly string[];
  },
): PrototypeModel & { effort: Effort } => {
  const asked = v['prototype.model'];
  const effort = v['prototype.effort'];

  if (allows(v.allowedModels, asked)) return { model: asked, effort, fellBack: null };
  const first = v.allowedModels[0] ?? asked;

  return {
    model: first,
    effort,
    fellBack: `${asked} isn't in allowedModels (${v.allowedModels.join(', ')}) · on ${first}`,
  };
};

// ---------------------------------------------------------------------------------------------
// Make card's upload

/** The files a `git diff` names (`diff --git a/x b/x` lines). */
export const diffFiles = (patch: string): number =>
  patch.split('\n').filter((l) => l.startsWith('diff --git ')).length;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What the prototype was, as the prompt, the issue and the card's line name it. */
export type CodeShown = {
  branch: string;
  base: string;
  commit: string;
  /** The worktree against the default branch, uncommitted and untracked files included. */
  diff: string;
  screenshots: readonly { n: number; what: string }[];
};

/** `Prototype · proto/4-vat at 3f2a9c1 · 3 files · 1 screenshot`: the prototype as its line names it. */
export const codePrototypeLine = (s: Omit<CodeShown, 'base'>): string =>
  [
    'Prototype',
    `${s.branch} at ${s.commit.slice(0, 7)}`,
    plural(diffFiles(s.diff), 'file'),
    ...(s.screenshots.length === 0 ? [] : [plural(s.screenshots.length, 'screenshot')]),
  ].join(' · ');

/** The one comment on the card: the prototype's line. */
export const codeCardComment = (shown: Omit<CodeShown, 'base'>): string => codePrototypeLine(shown);

/** The file the diff is copied to in the reference folder, and kept as in the org store. */
export const REFERENCE_DIFF = 'prototype.diff';

/**
 * The org store's version Make card keeps the prototype as: the one this prototype already has (a
 * retry replaces it), else the card's next, else v1.
 */
export const codeStoreVersion = (index: OrgPrototype | undefined, prototype: string): number =>
  index?.versions.find((v) => v.prototype === prototype)?.n ?? (index?.versions.at(-1)?.n ?? 0) + 1;

/**
 * Make card's upload: the diff, each screenshot, then `meta.json` last. With it in the org store
 * the card's run (and any later one) reads it as its reference.
 */
export const codeUploadPlan = (o: {
  prototype: string;
  at: string;
  /** The repo's name in the keys (`storeRepoName`). */
  repo: string;
  remote: string | null;
  card: number;
  n: number;
  shown: CodeShown;
  screenshots: readonly Screenshot[];
}): { meta: OrgPrototypeVersion; uploads: Upload[] } => {
  const base = versionPrefix(o.repo, o.card, o.n);
  const meta: OrgPrototypeVersion = {
    v: 1,
    prototype: o.prototype,
    version: o.n,
    at: o.at,
    card: o.card,
    repo: o.repo,
    remote: o.remote,
    branch: o.shown.base,
    commit: o.shown.commit,
    spec: null,
    changes: [],
    mocks: [],
    screenshots: o.screenshots.map((s) => ({
      n: s.n,
      what: s.what,
      at: s.at,
      file: `screenshots/${s.file}`,
    })),
    code: { branch: o.shown.branch, diff: REFERENCE_DIFF },
  };

  return {
    meta,
    uploads: [
      {
        key: `${base}${REFERENCE_DIFF}`,
        contentType: 'text/x-diff; charset=utf-8',
        text: o.shown.diff,
      },
      ...o.screenshots.map((s) => ({
        key: `${base}screenshots/${s.file}`,
        contentType: 'image/png',
        screenshot: s.file,
      })),
      {
        key: `${base}meta.json`,
        contentType: 'application/json',
        text: `${JSON.stringify(meta, null, 2)}\n`,
      },
    ],
  };
};

/** What became of the prototype's worktree: removed (it held nothing uncommitted), kept and why, gone. */
export const WorktreeFate = Clearing.omit({ at: true });
export type WorktreeFate = z.infer<typeof WorktreeFate>;

/** `prototype discard`: the prototype's session stopped, its worktree and branch gone. */
export const DiscardData = z.object({
  prototype: z.string(),
  card: z.number().int().positive().nullable(),
  session: z.string(),
  branch: z.string(),
  worktree: z.string(),
  fate: WorktreeFate,
});
export type DiscardData = z.infer<typeof DiscardData>;

export const discardText = (d: DiscardData): string =>
  `discarded ${d.prototype}${d.card === null ? '' : ` on AB#${d.card}`}: session ${d.session} stopped, ${d.worktree} ${d.fate.worktree}${d.fate.why === null ? '' : ` (${d.fate.why})`}, ${d.branch} deleted\n`;
