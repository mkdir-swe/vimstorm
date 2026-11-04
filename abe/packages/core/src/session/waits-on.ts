/**
 * What a waiting session waits on, pure and import-free so `ui` can take it as a value
 * (`@abe/core/waits-on`): its turn ended (`turn`: idle, your turn), a question card of Chat's
 * waits for its answer (`question`), or a dialog of Claude Code's asks in its terminal (`dialog`).
 */
export const WAITING_ON = ['turn', 'question', 'dialog'] as const;
export type WaitingOn = (typeof WAITING_ON)[number];

/**
 * Whether a session needs you: it waits on a question card or a dialog. A turn that simply ended
 * is your turn, not a need. Waiting on nothing known (an older serve's): as before, it needs you.
 */
export const waitsOnYou = (s: {
  state: string;
  waitingOn?: WaitingOn | null | undefined;
}): boolean => s.state === 'waiting' && s.waitingOn !== 'turn';
