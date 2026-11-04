/**
 * The Abe chat (the hub): Claude Code chats per repo, in its main checkout, unjailed on this Mac
 * as the person's own Claude Code. It answers about cards, makes cards, starts runs on one or
 * many cards and runs the skills the person invokes as `/abe:<name>` (`/abe:install`,
 * `/abe:triage`, `/abe:prototype` …). `abe chat` opens it (the one running, or the last one
 * reopened), `abe chat --new` starts another conversation beside the others; each is named by
 * its first message (`Abe 2` until then). The install is one following `/abe:install`. The rules
 * here: its title, names, words and what the command answers.
 */
import { z } from 'zod';
import { HUB_SKILL } from './hub-prompts';
import { SESSION_STATES } from './session';

export { HUB_HELLO, HUB_REOPENED_PROMPT, HUB_SKILL } from './hub-prompts';

/** The checkout's folder name: what Chat calls the repo. */
const repoName = (repo: string): string => repo.replace(/\/+$/, '').split('/').pop() ?? repo;

/** The Abe chat's title (Chat's header, Sessions): `Abe · demo-shop`. */
export const hubTitle = (repo: string): string => `Abe · ${repoName(repo)}`;

/** A conversation's name until its first message: `Abe 2`, the repo's second. */
export const hubNumbered = (n: number): string => `Abe ${String(n)}`;

/** Whether a conversation still has its numbered name (none: one from before names). */
export const hubUnnamed = (name: string | undefined): boolean =>
  name === undefined || /^Abe \d+$/.test(name);

/**
 * A conversation's name from your first message to it, short as Claude Code's titles; a skill
 * invoked alone by its name (`/abe:install` is `Install`).
 */
export const hubName = (text: string): string => {
  const words = text.replace(/\s+/g, ' ').trim();
  const skill = /^\/abe:([a-z][a-z0-9-]*)$/.exec(words)?.[1];
  const max = 40;

  if (skill !== undefined)
    return `${skill.charAt(0).toUpperCase()}${skill.slice(1).replace(/-/g, ' ')}`;
  if (words.length <= max) return words;
  const cut = words.slice(0, max);
  const space = cut.lastIndexOf(' ');

  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
};

/**
 * `name` told apart from the repo's other conversations' (`taken`): the same first words name a
 * second one `<name> 2`, a third `<name> 3` (N4).
 */
export const hubNameApart = (name: string, taken: readonly string[]): string => {
  let n = 1;
  const named = () => (n === 1 ? name : `${name} ${String(n)}`);

  while (taken.includes(named())) n += 1;

  return named();
};

/** Core's instructions to the Abe chat, after Claude Code's own system prompt. */
export const hubInstructions = (o: { repo: string }): string =>
  [
    `You are Abe, the hub of Abe for the repo in ${o.repo} (its main checkout, where you run), on the person's own machine. Follow /abe:${HUB_SKILL}: it says what you do and which abe commands do it.`,
    "You run unjailed, as the person's own Claude Code: read and write files, run any command, every abe command too. Act without asking, but ask first (a question of its own, with AskUserQuestion) before turning prod on for agents (`abe settings set agents.prod true`) and before starting more than one cloud run at once.",
    'The person invokes skills as /abe:<name> (/abe:install, /abe:triage, /abe:retro, /abe:improve, /abe:prototype, /abe:make-card); follow the one invoked.',
    'Ask the person in Chat, with AskUserQuestion. Never end a turn on a question in prose.',
    "Read nothing outside this checkout unless the person points you there. You never print, quote or commit a value from the person's env files (.abe/abe.*.env).",
    'What the person tells you for this conversation only (a limit like "never run X") limits you now and is never written into a repo file unless they say to keep it.',
  ].join('\n\n');

/** `abe chat`: the repo's Abe chat, opened (or started anew with `--new`). */
export const HubData = z.object({
  /** The main checkout it is on. */
  repo: z.string(),
  /** Its session: `abe session attach <id>`. */
  id: z.string(),
  title: z.string(),
  state: z.enum(SESSION_STATES),
  /** How it was opened: a new conversation, the one it had reopened, or the one running. */
  opened: z.enum(['new', 'reopened', 'running']),
});
export type HubData = z.infer<typeof HubData>;

const OPENED_WORDS: Readonly<Record<HubData['opened'], string>> = {
  new: 'a new conversation',
  reopened: 'its conversation reopened',
  running: 'open',
};

export const hubText = (d: HubData): string =>
  `${d.title}: ${OPENED_WORDS[d.opened]} · abe session attach ${d.id}\n`;
