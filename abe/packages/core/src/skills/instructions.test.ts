import { expect, test } from 'bun:test';
import { COMMANDS } from '../contract/commands';
import {
  CARD_COMMENT_INSTRUCTIONS,
  CORE_INSTRUCTIONS,
  FACTORY_INSTRUCTIONS,
  FACTORY_RUN_INSTRUCTIONS,
  NO_RUN_INSTRUCTIONS,
  PLAIN_SESSION_INSTRUCTIONS,
  SHEETS_INSTRUCTIONS,
  SUBAGENTS_INSTRUCTIONS,
  withSubagentsMax,
} from './instructions';

test('every abe command the instructions name is a row of the command table, or its noun', () => {
  const named = [
    ...`${FACTORY_RUN_INSTRUCTIONS}${PLAIN_SESSION_INSTRUCTIONS}`.matchAll(
      /`abe ([a-z]+)(?: ([a-z-]+))?/g,
    ),
  ].map((m) => (m[2] === undefined ? (m[1] ?? '') : `${m[1] ?? ''} ${m[2]}`));

  expect(named.length).toBeGreaterThan(0);
  // A noun alone (`abe factory`) lists its commands: some row has it.
  const nouns = new Set(Object.values(COMMANDS).map((c) => c.noun));

  for (const id of named) expect(Object.hasOwn(COMMANDS, id) || nouns.has(id)).toBe(true);
});

test('the Sheets section: make a Sheet for data to show, save it, end with Show <title>', () => {
  expect(SHEETS_INSTRUCTIONS).toContain('When you have data to show');
  expect(SHEETS_INSTRUCTIONS).toContain('abe sheet save --title');
  expect(SHEETS_INSTRUCTIONS).toContain('End your message with the line `Show <title>`');
});

test('the Card comments section: every session comments on a card only when asked, or a card spec', () => {
  expect(CORE_INSTRUCTIONS).toContain(CARD_COMMENT_INSTRUCTIONS);
  expect(CARD_COMMENT_INSTRUCTIONS).toContain('only when the person asks you to');
  expect(CARD_COMMENT_INSTRUCTIONS).toContain('`spec.where: card`');
});

test('subagents.max sets the limit every session is told: a plain one and a Factory run', () => {
  expect(withSubagentsMax(PLAIN_SESSION_INSTRUCTIONS, 2)).toContain('At most 2 subagents at once.');
  expect(withSubagentsMax(FACTORY_RUN_INSTRUCTIONS, 1)).toContain('At most 1 subagent at once.');
  expect(withSubagentsMax(FACTORY_RUN_INSTRUCTIONS, 1)).not.toContain('At most 4');
  expect(withSubagentsMax(CORE_INSTRUCTIONS, 3)).toContain('At most 3 subagents at once.');
  expect(withSubagentsMax(CORE_INSTRUCTIONS, 4)).toBe(CORE_INSTRUCTIONS);
});

test('the Subagents section: delegate, at most 4 at once, readers share, writers merged', () => {
  expect(CORE_INSTRUCTIONS).toContain(SUBAGENTS_INSTRUCTIONS);
  expect(SUBAGENTS_INSTRUCTIONS).toContain('At most 4 subagents at once.');
  expect(SUBAGENTS_INSTRUCTIONS).toContain('`abe:reader`');
  expect(SUBAGENTS_INSTRUCTIONS).toContain('own git worktree off the card branch');
  expect(SUBAGENTS_INSTRUCTIONS).toContain('git merge --no-ff');
  // A writer's words are not checks (#151); its leftovers are serve's to tidy (#183).
  expect(SUBAGENTS_INSTRUCTIONS).toContain("A writer's report is its word");
  expect(SUBAGENTS_INSTRUCTIONS).toContain('never ask the person to');
});

test('the run section: the picked workflow, each step in a subagent, fresh ones given only what status says, gates answered, stage-done, needs-you', () => {
  expect(FACTORY_RUN_INSTRUCTIONS.startsWith(CORE_INSTRUCTIONS)).toBe(true);
  expect(FACTORY_INSTRUCTIONS).toContain('through the workflow the launch picked');
  expect(FACTORY_INSTRUCTIONS).toContain("never earlier steps' reports or your notes");
  expect(FACTORY_INSTRUCTIONS).toContain('`abe factory judge --answer yes|no --reason <why>`');
  expect(FACTORY_INSTRUCTIONS).toContain('`abe factory stage-done <step>`');
  expect(FACTORY_INSTRUCTIONS).toContain('`abe factory needs-you --reason');
  expect(FACTORY_INSTRUCTIONS).not.toContain('decide');
});

test('the run section: one review with findings back to build, a bug reproduced first, regression for risky', () => {
  expect(FACTORY_INSTRUCTIONS).toContain('`abe factory review --findings <n> --report <file>`');
  expect(FACTORY_INSTRUCTIONS).toContain('`abe factory base-worktree`');
  expect(FACTORY_INSTRUCTIONS).toContain('`abe factory verify --phase before');
  expect(FACTORY_INSTRUCTIONS).toContain('`--regression <name,name>`');
});

test("a plain session's instructions (#186): core's, then no Factory run here, and who starts one", () => {
  expect(PLAIN_SESSION_INSTRUCTIONS).toBe([CORE_INSTRUCTIONS, NO_RUN_INSTRUCTIONS].join('\n'));
  expect(NO_RUN_INSTRUCTIONS).toContain('This session is not a Factory run');
  expect(NO_RUN_INSTRUCTIONS).toContain('Do not load the factory skill');
  expect(NO_RUN_INSTRUCTIONS).toContain('`abe factory run <card>`');
  // A run's instructions never say there is none.
  expect(FACTORY_RUN_INSTRUCTIONS).not.toContain(NO_RUN_INSTRUCTIONS);
});
