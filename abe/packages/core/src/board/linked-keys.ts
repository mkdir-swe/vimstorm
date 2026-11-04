/**
 * Linked's rows and read parts (2.1 #109, #341), pure and import-free so `ui` can take them as
 * values (`@abe/core/linked-keys`); `linked.ts` re-exports them with the rest of Linked's shapes.
 */
export const LINKED_KEYS = [
  'story',
  'prototype',
  'spec',
  'sessions',
  'pr',
  'pipelines',
  'worktree',
  'box',
  'sheets',
] as const;
export type LinkedKey = (typeof LINKED_KEYS)[number];

/**
 * The parts of Linked's read (#341), each read on its own (`abe story linked <id> --part <part>`)
 * so the popup draws a row as soon as its own part is in, never waiting for the slowest: `card`
 * the story (Story, Sheets), `run` its runs and sessions (Spec, Sessions, Worktree, and the
 * rows with nothing else to read), `spec` its issue, `pr` the pull request, `pipelines` the
 * branch's workflow run, `box` your boxes.
 */
export const LINKED_PARTS = ['card', 'run', 'spec', 'pr', 'pipelines', 'box'] as const;
export type LinkedPart = (typeof LINKED_PARTS)[number];
