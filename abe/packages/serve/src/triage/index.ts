/** Triage in serve: a handler for each of core's rows, and what the process folder starts. */
import { type TRIAGE_COMMANDS, type HandlersFor } from '@abe/core';
import { triageHandlers, type TriageCtx } from './triage';

export { type TriageCtx } from './triage';

export const TRIAGE_HANDLERS: HandlersFor<typeof TRIAGE_COMMANDS, TriageCtx> = {
  ...triageHandlers(),
};
