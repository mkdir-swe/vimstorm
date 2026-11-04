/**
 * Reopen (#343, GLOSSARY): going back into an ended session, the same worktree (or workspace) and
 * the same Claude Code conversation (`claude --resume`), under the same Abe session id. A run not
 * over goes on at its stage; a run over is a plain conversation on its own branch. Retry run (a
 * new session from its workflow's first step) and Launch new agent… start a new one instead.
 */
import {
  CORE_INSTRUCTIONS,
  FACTORY_RUN_INSTRUCTIONS,
  PLAIN_SESSION_INSTRUCTIONS,
} from '../skills/instructions';
import { type Run } from '../factory/factory';
import { localWhen } from '../command';

/**
 * Why Abe ended a session whose Claude Code went away with no SessionEnd hook (its terminal gone,
 * the Mac restarted, a crash): its look is `✗ Crashed`.
 */
export const CRASHED = 'Claude Code exited without ending it (crashed)';

/** Whether a session ended crashed (`CRASHED`). */
export const crashed = (s: { state: string; reason: string | null }): boolean =>
  s.state === 'ended' && s.reason === CRASHED;

/**
 * A run is over once it has an outcome (done, a question answered, not reproduced, abandoned) or
 * it cleared: its reopened session is a plain conversation, and `abe factory` refuses it.
 */
export const runOver = (run: Pick<Run, 'outcome' | 'cleared'>): boolean =>
  run.outcome !== null || run.cleared !== null;

/** The first prompt of a reopened run not over, when you typed none. */
export const REOPENED_PROMPT =
  'You were reopened. Run abe factory status, read the whole card again with abe card show (its comments may have changed), and go on.';

/** What a reopened session over its run is told, after core's sections. */
export const RUN_OVER_INSTRUCTIONS = `## Reopened after its run

This session was reopened after its Factory run was over: it is a plain conversation with the person on this card's branch, no run any more.

- Answer what the person asks. Commit and push only to this session's own branch; never to another branch, and open no pull request.
- \`abe factory\` commands are refused here (\`run-over\`): the run is not moved or ended again. That refusal is final; do not look for a way around it.
- A follow-up change the person wants shipped is a new agent they launch on the card (Launch new agent…); tell them so.
`;

/** A reopened session's instructions: a run's when it is not over, else a plain conversation's. */
export const reopenedInstructions = (run: Pick<Run, 'outcome' | 'cleared'> | undefined): string => {
  if (run === undefined) return PLAIN_SESSION_INSTRUCTIONS;

  return runOver(run)
    ? [CORE_INSTRUCTIONS, RUN_OVER_INSTRUCTIONS].join('\n')
    : FACTORY_RUN_INSTRUCTIONS;
};

/**
 * A reopened session's first prompt: what you typed, else for a run not over `REOPENED_PROMPT`;
 * a plain session or a run over opens on its conversation with none ('').
 */
export const reopenedPrompt = (
  message: string | undefined,
  run: Pick<Run, 'outcome' | 'cleared'> | undefined,
): string => {
  if (message !== undefined && message.trim() !== '') return message;

  return run === undefined || runOver(run) ? '' : REOPENED_PROMPT;
};

/** `abe factory <command>` from a session reopened after its run was over. */
export const runOverText = (card: number, outcome: string | null): string =>
  `AB#${card}'s run is over${outcome === null ? ' (cleared)' : ` (${outcome})`}: this reopened session is a plain conversation on its own branch, no Factory stage and no new pull request. A follow-up change is a new agent the person launches (Launch new agent…).`;

/** Why a reopen is refused: its worktree and branch gone (Launch new agent… starts fresh). */
export const worktreeGoneText = (o: {
  branch: string;
  cleared?: string | null;
  now?: string;
}): string =>
  `its worktree and branch ${o.branch} are gone${o.cleared === undefined || o.cleared === null ? '' : ` (cleared ${localWhen(o.cleared, o.now)})`}: Launch new agent… starts fresh`;

/** Why a cloud reopen is refused: its box was terminated, its workspace and conversation with it. */
export const boxGoneText = (box: string): string =>
  `its box ${box} is gone (terminated): its workspace and conversation went with it · Launch new agent… starts fresh`;

/** Why a reopen is refused while another session of the card runs. */
export const cardRunningText = (card: number | string, session: string): string =>
  `AB#${card} has a running session ${session}: stop it first`;

/**
 * Whether a session was reopened at or after `since` (a Done run's: when it became Done): its
 * conversation is the person's now, so nothing stops it at its prompt or clears its worktree.
 */
export const reopenedSince = (reopened: readonly string[], since: string): boolean =>
  reopened.some((at) => at >= since);
