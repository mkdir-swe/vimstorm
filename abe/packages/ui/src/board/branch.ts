/**
 * The card a branch is on (Chat pins by it; the jumps go along it). A leaf module of
 * its own, so the jumps (imported by the component set) need not load the `chat` screen.
 */

/** The card a branch is on: `card/<n>-…` or `card/<n>`. */
export const cardOfBranch = (branch: string | undefined): number | undefined => {
  const m = /^card\/(\d+)(?:-|$)/.exec(branch ?? '');

  return m?.[1] === undefined ? undefined : Number(m[1]);
};
