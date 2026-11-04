/** The Factory's rows of the command table: `abe factory`. */
import { CARD_ID } from '../board';
import { SHORT_ANSWERS, command } from '../command';
import { launchSharedNote, PROFILE_FLAG } from '../session';
import { FactoryChecksData, factoryChecksText } from './checks';
import {
  ENDINGS,
  FactoryBaseWorktreeData,
  FactoryRunData,
  FactoryStatusData,
  LAUNCH_TARGETS,
  PHASES,
  RESULTS,
  STAGES,
  factoryBaseWorktreeText,
  factoryRunText,
  factoryStatusText,
} from './factory';
import { FactoryEndData, factoryEndText } from './factory-end';
import { RunRecordData, runRecordText } from './run-record';

export const FACTORY_COMMANDS = {
  'factory run': command({
    noun: 'factory',
    verb: 'run',
    summary:
      "launch a session on a card and run it through a workflow (--workflow's; else the one whose on: takes the card: yours, the repo's, then Abe's; else Feature), starting at its first step",
    inSession: false,
    args: {
      card: CARD_ID,
      repo: {
        kind: 'flag',
        type: 'string',
        summary: 'the git checkout to branch from, relative to where abe runs (default: here)',
      },
      target: {
        kind: 'flag',
        type: 'string',
        values: LAUNCH_TARGETS,
        summary:
          "where the session runs: local-sandbox (this machine, in Claude Code's sandbox) or cloud (the card's box); default: serve.target",
      },
      profile: PROFILE_FLAG(
        'the browser profile the run verifies in, Before and After alike (default: browser.default); one with nothing stored is refused',
      ),
      note: {
        kind: 'flag',
        type: 'string',
        summary:
          "your Launch note: words the agent reads after the card's (at most 2000 characters)",
      },
      noteFile: {
        kind: 'flag',
        type: 'string',
        summary: 'your Launch note from a file, relative to where abe runs (not with --note)',
      },
      prod: {
        kind: 'flag',
        type: 'boolean',
        summary:
          "prod on for agents in this run's session alone, whatever agents.prod says (ADR 0029): it reaches prod in full, read and write. Yours alone: never from a session; a local run only",
      },
      workflow: {
        kind: 'flag',
        type: 'string',
        summary:
          "the workflow it runs, by id (abe workflow list: feature, quick-fix, bug, investigate, or yours or the repo's): any, whatever its on: says; default the one whose on: takes the card, else Feature. One no source has, or that fails the load check, is refused with its problems",
      },
      short: {
        kind: 'flag',
        type: 'string',
        values: SHORT_ANSWERS,
        summary:
          "a cloud launch onto its repo's box short of memory or disk (refused box-short): resize (to the next size, stopping the box first) or anyway",
      },
      replace: {
        kind: 'flag',
        type: 'boolean',
        summary:
          "the card's live sessions in this repo (here and on its box) stopped first, as abe session stop stops them (their run and worktree kept, ended); without it a live one is refused card-has-session",
      },
    },
    result: FactoryRunData,
    text: factoryRunText,
    note: launchSharedNote,
  }),
  'factory stage-done': command({
    noun: 'factory',
    verb: 'stage-done',
    summary:
      "from inside the run's session only: the step is finished, move on (its loops, its ends:, else the next step)",
    inSession: true,
    inWorkspace: 'session',
    only: 'session',
    args: {
      stage: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: `the step finished, by its name in the run's workflow (or its kind: ${STAGES.filter((s) => s !== 'step' && s !== 'done').join(', ')})`,
      },
      report: {
        kind: 'flag',
        type: 'string',
        summary: 'a report on it (markdown), relative to where abe runs; kept with the session',
      },
      fact: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary:
          'a fact the step reports, name=value (checks.failed=0): what its loops and done_when read (again for more)',
      },
      made: {
        kind: 'flag',
        type: 'string',
        summary:
          "what the step made, as JSON (build's lanes, the tickets), relative to where abe runs; kept on the run",
      },
    },
    result: FactoryRunData,
    text: factoryRunText,
  }),
  'factory judge': command({
    noun: 'factory',
    verb: 'judge',
    summary:
      "from inside the run's session only: answer the judge: question its workflow asks (a loop's, a done_when's, a gate's or an ends'), yes or no, with a reason (kept as a decision)",
    inSession: true,
    inWorkspace: 'session',
    only: 'session',
    args: {
      answer: {
        kind: 'flag',
        type: 'string',
        values: ['yes', 'no'],
        required: true,
        summary: "the answer to the judge's question",
      },
      reason: { kind: 'flag', type: 'string', required: true, summary: 'why, one line' },
    },
    result: FactoryRunData,
    text: factoryRunText,
  }),
  'factory review': command({
    noun: 'factory',
    verb: 'review',
    summary:
      "from inside the run's session only: a review round (standards and spec) and its findings; findings go back to build",
    inSession: true,
    inWorkspace: 'session',
    only: 'session',
    args: {
      findings: {
        kind: 'flag',
        type: 'number',
        required: true,
        summary: 'how many findings to fix (0: none, on to the next step)',
      },
      report: {
        kind: 'flag',
        type: 'string',
        summary: "the review (markdown), relative to where abe runs; kept in the card's .scratch",
      },
      regression: {
        kind: 'flag',
        type: 'string',
        summary: 'the regression tests run, comma-separated (when you judged the work risky)',
      },
      findingsFile: {
        kind: 'flag',
        type: 'string',
        summary:
          'the findings as JSON (file:line, what, fix, severity; the earlier ones fixed or not; the risk), relative to where abe runs; its must findings match --findings',
      },
    },
    result: FactoryRunData,
    text: factoryRunText,
  }),
  'factory verify': command({
    noun: 'factory',
    verb: 'verify',
    summary:
      "from inside the run's session only: a verification phase's result: Before in a bug's reproduce step (or verify's own Before+after), After in verify",
    inSession: true,
    inWorkspace: 'session',
    only: 'session',
    args: {
      phase: {
        kind: 'flag',
        type: 'string',
        values: PHASES,
        required: true,
        summary: 'before (on the merge base) or after (on the branch)',
      },
      result: {
        kind: 'flag',
        type: 'string',
        values: RESULTS,
        required: true,
        summary: 'pass (at before: reproduced), fail, or not-reproduced (before only)',
      },
      report: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary:
          "the verification (markdown), relative to where abe runs; kept in the card's .scratch",
      },
      regression: {
        kind: 'flag',
        type: 'string',
        summary: 'the regression tests run, comma-separated (when the work is risky)',
      },
      html: {
        kind: 'flag',
        type: 'string',
        summary:
          "the after pass's report as HTML from the verify kit, relative to where abe runs (a Feature map: required on the after pass, each feature's verdict as ## Features says); sanitised and kept beside the report",
      },
    },
    result: FactoryRunData,
    text: factoryRunText,
  }),
  'factory base-worktree': command({
    noun: 'factory',
    verb: 'base-worktree',
    summary:
      "from inside the run's session only: a worktree at the merge base of the card's branch and the default branch, for Before",
    inSession: true,
    inWorkspace: 'session',
    only: 'session',
    args: {},
    result: FactoryBaseWorktreeData,
    text: factoryBaseWorktreeText,
  }),
  'factory needs-you': command({
    noun: 'factory',
    verb: 'needs-you',
    summary: "from inside the run's session only: the run waits on the person, and why",
    inSession: true,
    inWorkspace: 'session',
    only: 'session',
    args: {
      reason: { kind: 'flag', type: 'string', required: true, summary: 'what it needs, one line' },
      option: {
        kind: 'flag',
        type: 'string',
        repeats: true,
        summary:
          'an answer the person can pick, short (again for more): Chat offers them as 1, 2, …',
      },
    },
    result: FactoryRunData,
    text: factoryRunText,
  }),
  'factory pr': command({
    noun: 'factory',
    verb: 'pr',
    summary:
      "from inside the run's session only, in pr: the body checked, the branch pushed, its pull request opened or updated, linked to the card",
    inSession: true,
    inWorkspace: 'session',
    only: 'session',
    args: {
      title: { kind: 'flag', type: 'string', required: true, summary: "the pull request's title" },
      bodyFile: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary:
          'the body (markdown, written with the pr skill): one **Verified:** line, ## Notes of at most five bullets',
      },
    },
    result: FactoryRunData,
    text: factoryRunText,
  }),
  'factory status': command({
    noun: 'factory',
    verb: 'status',
    summary:
      "every run, or a card's: its workflow, step, state, since when, what the step's subagent gets, each finished step's time (inside a session: its own)",
    inSession: true,
    inWorkspace: 'session',
    args: {
      card: {
        kind: 'positional',
        type: 'string',
        summary: 'the card (`4`, `AB#4`)',
      },
      cleared: {
        kind: 'flag',
        type: 'boolean',
        summary: 'the cleared runs (History) instead of the shown ones',
      },
    },
    result: FactoryStatusData,
    text: factoryStatusText,
  }),
  'factory end': command({
    noun: 'factory',
    verb: 'end',
    summary:
      "end a card's Factory run that cannot go on by itself, with a reason: done (its deploy failed or never comes), not-reproduced (its bug does not reproduce) or abandoned; the card and its pull request get the reason, the card moves (Done, or New when abandoned), its session stops",
    inSession: false,
    args: {
      card: CARD_ID,
      as: {
        kind: 'flag',
        type: 'string',
        values: ENDINGS,
        required: true,
        summary: 'how it ended',
      },
      reason: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'why, one line: kept with the run and on the pull request',
      },
    },
    result: FactoryEndData,
    text: factoryEndText,
  }),
  'factory checks': command({
    noun: 'factory',
    verb: 'checks',
    summary:
      "run a card's checks again in its run's worktree and write .scratch/<card>/checks.md; moves nothing (inside a session: its own)",
    inSession: true,
    inWorkspace: 'session',
    args: { card: CARD_ID },
    result: FactoryChecksData,
    text: factoryChecksText,
  }),
  'factory record': command({
    noun: 'factory',
    verb: 'record',
    summary:
      "a card's Run page (3.0 #21): its newest run's stages, every step (files, commands, the person's decisions), the acceptance criteria with their proof and the spec; live while the run goes, afterwards from the org log store (your own runs only)",
    inSession: false,
    args: { card: CARD_ID },
    result: RunRecordData,
    text: runRecordText,
  }),
};
