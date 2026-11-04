/**
 * The jumps: ⌃L Linked, from anywhere but an nvim split and a PTY (there ⌃⌥L); the
 * linked story's Card page (Open card in the menus, no key: ⏎ on a Board card) and its workspace
 * (Open workspace, no key: the Board's ⌘→). Pure, a table in `jumps.test.ts`. The shell sends a
 * `jump` frame with what had the keyboard; the bridge asks each part for its story
 * ([`storyOfJump`]: the layer up, a slot's screen, the shown workspace) and hands the jump on
 * ([`jumpCommands`]): `story` and `workspace` to the Factory overview, which holds the cards and
 * the sessions, `linked` to Command mode, which draws the popup. They replace the `g` jumps.
 */
import type { AttachSpec, FactoryRunData, SessionData } from '@abe/core';
import { cardOfBranch } from './branch';
import { type CardOn, cardSession } from './flow';
import type { Command, JumpFrom, JumpTo, ShellEffect, Slot } from '../runtime/runtime';
import { type WorkspaceLook } from './workspaces';

/** The jump's key as menus, the footer and the key help name it (the others have none). */
export const JUMP_KEYS: Readonly<Record<Extract<JumpTo, 'linked'>, string>> = { linked: '⌃L' };

/** What a jump with nothing linked says (the main checkout, an unlinked pipeline). */
export const NOTHING_LINKED = 'Nothing linked here';

/** Open workspace on a story with no session yet: none to open (how to start one: yours only). */
export const noWorkspace = (story: number, yours = true): string =>
  `No workspace for #${story} yet${yours ? ' · ⌘⏎ Launch agent' : ''}`;

/** What each part says its story is, as the bridge asks them. */
export type JumpFacts = {
  /** The layer up's story (Linked's, the story dialog's); undefined: none, or no layer. */
  layer?: number | undefined;
  /** Each slot's screen's (`Screen.linked`). */
  slots: Readonly<Partial<Record<Slot, number | undefined>>>;
  /** The shown workspace's (`workspaceStory`). */
  workspace?: number | undefined;
};

const SLOT_PLACES: readonly string[] = ['main', 'chat', 'pane'] satisfies Slot[];

const isSlot = (place: string): place is Slot => SLOT_PLACES.includes(place);

/**
 * What is linked, first match: the layer up (Linked, the story dialog), the
 * slot with the keyboard (a card, a Sessions / Boxes / Pipelines row, Chat), else the shown
 * workspace's story (an editor split, the tree, Git) on the Editor, the Board's on the Factory view.
 */
export const storyOfJump = (from: JumpFrom, facts: JumpFacts): number | undefined => {
  if (facts.layer !== undefined) return facts.layer;
  if (isSlot(from.place)) return facts.slots[from.place];

  return from.view === 'factory' ? facts.slots.main : facts.workspace;
};

const bare = (path: string) => path.replace(/\/+$/, '');

/**
 * The shown workspace's story: the header's entry for it (a cloud one by its box and its branch's
 * card, as a box holds a workspace per card, ADR 0022; a local one by its folder), else its
 * branch's (`card/<n>-…`); the main checkout has none.
 */
export const workspaceStory = (
  looks: readonly WorkspaceLook[],
  shown: { root?: string | undefined; box?: string | undefined; branch?: string | undefined },
): number | undefined => {
  const look =
    shown.box === undefined
      ? looks.find(
          (l) =>
            l.box === undefined && shown.root !== undefined && bare(l.root) === bare(shown.root),
        )
      : looks.find(
          (l) =>
            l.box === shown.box &&
            (cardOfBranch(shown.branch) === undefined || l.story.id === cardOfBranch(shown.branch)),
        );

  return look?.story.id ?? cardOfBranch(shown.branch);
};

const balloon = (text: string): Command => ({
  kind: 'shell',
  effect: { kind: 'balloon', tone: 'info', text },
});

/** The jump handed on, or `Nothing linked here` (a no-op). */
export const jumpCommands = (to: JumpTo, story: number | undefined): Command[] =>
  story === undefined ? [balloon(NOTHING_LINKED)] : [{ kind: 'jump', to, story }];

/** Open workspace on a story whose only run never got a box: nothing ran, none to open. */
export const neverPlacedWorkspace = (story: number): string =>
  `#${story}’s run never got a box: no workspace to open`;

/**
 * The story's session Open workspace opens the workspace of: the one its card is on (`cardSession`: as
 * its Board card, Chat and Linked read it).
 */
export const workspaceSession = (
  runs: readonly FactoryRunData[],
  sessions: readonly SessionData[],
  story: number,
): CardOn | undefined => cardSession(runs, sessions, story);

/** A workspace jump's `workspace attach-spec`: its id names the session. */
export const JUMP_WORKSPACE = 'jump-workspace:';

/**
 * The workspace jump: the session's `abe workspace attach-spec`, or why there is no workspace yet. A run of yours
 * still going whose session is not listed yet is attached all the same (it is about to be); one
 * that is over, or a teammate's, has none here.
 */
export const workspaceJump = (
  runs: readonly FactoryRunData[],
  sessions: readonly SessionData[],
  story: number,
  yours = true,
): Command[] => {
  const session = workspaceSession(runs, sessions, story);

  if (session?.session?.neverPlaced === true) return [balloon(neverPlacedWorkspace(story))];
  const unlisted = session?.session === undefined && (session?.run?.outcome !== null || !yours);

  return session === undefined || unlisted
    ? [balloon(noWorkspace(story, yours))]
    : [
        {
          kind: 'run',
          id: `${JUMP_WORKSPACE}${session.id}`,
          argv: ['workspace', 'attach-spec', session.id],
        },
      ];
};

/**
 * Where the workspace jump lands: a local worktree opened as a project, a box's workspace
 * through its attach (Waking while the box is not known to run), the Chat column shown beside it
 * on its session with the keys. `download` is RemoteState's Download locally.
 */
export const workspaceLanding = (spec: AttachSpec, download: string): ShellEffect =>
  spec.where === 'local' || spec.box === null
    ? { kind: 'open-project', path: spec.root, chat: true }
    : {
        kind: 'open-project',
        path: spec.root,
        attach: {
          nvim: spec.nvim,
          shell: spec.shell,
          exec: spec.exec,
          box: spec.box,
          waking: spec.waking,
          download,
        },
        chat: true,
      };
