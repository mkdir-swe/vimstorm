/** PR review in serve: a handler for each of core's rows, and what the process folder starts. */
import { type REVIEW_COMMANDS, type HandlersFor } from '@abe/core';
import { reviewHandlers, type ReviewCtx } from './review';

export { type ReviewCtx } from './review';

export const REVIEW_HANDLERS: HandlersFor<typeof REVIEW_COMMANDS, ReviewCtx> = {
  ...reviewHandlers(),
};
