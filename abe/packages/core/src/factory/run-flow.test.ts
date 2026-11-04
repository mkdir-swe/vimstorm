import { expect, test } from 'bun:test';
import { FEATURE_WORKFLOW } from '../skills/workflow/run';
import { FEATURE_FLOW } from './run-flow';

test("Feature's steps as the Run page reads them are the run's Feature workflow's", () => {
  expect(FEATURE_FLOW).toEqual(
    FEATURE_WORKFLOW.steps.map((x) => ({
      name: x.name,
      kind: x.kind,
      skill: x.skill,
      fresh: x.fresh,
      gated: x.when !== null,
      ends: x.ends !== null,
    })),
  );
});
