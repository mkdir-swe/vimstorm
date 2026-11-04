/**
 * Linked's parts for story 2 as board 3.2 (W-Linked) draws it. A local bug in Build waits on you
 * with no spec decided. Two of your sessions run, and story 2's has two subagents. There is no
 * pull request yet, `ci` passed on its branch, and there are no Sheets. `linkedOf(LINKED_PARTS,
 * LINKED_ENV)` is the `abe story linked 2` answer that the popup's tests and the contract's
 * fixtures draw.
 */
import type {
  CardShowData,
  FactoryRunData,
  PipelineRun,
  SessionData,
  SheetSummary,
} from '@abe/core';
import { pipelineRun } from './pipelines';
import { factoryRun, listCard, minutes, session } from './ui';

export const LINKED_STORY = 2;
export const LINKED_TITLE = 'The cart total ignores quantity';
const BRANCH = 'card/2-the-cart-total-ignores-quantity';
const WORKTREE = '/home/ada/projects/demo-shop-wt/2-the-cart-total-ignores-quantity';

/** When the parts were read, and the home that shortens paths. */
export const LINKED_ENV = { now: minutes(21), home: '/home/ada' };

const ok = <T>(data: T) => ({ ok: true as const, data });

const CARD: CardShowData = {
  ...listCard(LINKED_STORY, LINKED_TITLE, 'Active', 'Ada Example', { type: 'Bug' }),
  comments: [],
  sheets: [],
};

/** A Bug run: reproduced, in build; its workflow writes no spec. */
const RUN: FactoryRunData = factoryRun(LINKED_STORY, LINKED_TITLE, 'build', 'needs-you', {
  session: '2-a1b2',
  worktree: WORKTREE,
  since: minutes(0),
  workflow: {
    id: 'bug',
    name: 'Bug',
    layer: 'built-in',
    steps: (['reproduce', 'build', 'checks', 'review', 'verify', 'pr'] as const).map((kind) => ({
      name: kind,
      kind,
      skill: kind === 'checks' ? null : kind,
      fresh: 'never' as const,
      gated: false,
      ends: kind === 'reproduce',
    })),
  },
});

const SESSION: SessionData = {
  ...session('2-a1b2', 'working', LINKED_STORY),
  worktree: WORKTREE,
  branch: BRANCH,
  subagents: [0, 1].map((i) => ({
    id: `a${i}`,
    name: 'abe:reader',
    task: null,
    model: null,
    state: 'running' as const,
    startedAt: minutes(1),
    endedAt: null,
    result: null,
  })),
};

const PIPELINE: PipelineRun = {
  ...pipelineRun('7001', 'ci', 'The cart total ignores quantity', BRANCH, '00:05', 4),
  url: 'https://github.com/demo/demo-shop/actions/runs/7001',
  createdAt: minutes(5),
  startedAt: minutes(5),
  finishedAt: minutes(9),
};

/** The parts (`ui`'s `LinkedParts`), each read. */
export const LINKED_PARTS = {
  story: LINKED_STORY,
  card: ok(CARD),
  run: ok(RUN),
  sessions: ok([SESSION, session('9-c3d4', 'working', 9)]),
  pr: ok(null),
  pipeline: ok(PIPELINE),
  sheets: ok<SheetSummary[]>([]),
};
