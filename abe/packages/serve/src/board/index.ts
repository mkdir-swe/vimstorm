/** The Board in serve: a handler for each of core's rows, and what the process folder starts. */
import { type BOARD_COMMANDS, type HandlersFor } from '@abe/core';
import { boardHandlers, type BoardCtx } from './board';
import { checkoutHandlers, type CheckoutCtx } from './checkout';
import { freshHandlers, type FreshCtx } from './fresh';
import { linkedHandlers, type LinkedCtx } from './linked';
import { newCardHandlers, type NewCardCtx } from './new-card';
import { pipelineHandlers, type PipelinesCtx } from './pipelines';
import { trackingHandlers, type TrackingCtx } from './tracking';

export { type BoardCtx } from './board';
export { type CheckoutCtx } from './checkout';
export { freshAnswer, startFresh, type FreshCtx } from './fresh';
export { type LinkedCtx } from './linked';
export { sourceAt, sourceText, type PipelinesCtx } from './pipelines';
export { type TrackingCtx } from './tracking';

export const BOARD_HANDLERS: HandlersFor<
  typeof BOARD_COMMANDS,
  BoardCtx & TrackingCtx & PipelinesCtx & LinkedCtx & NewCardCtx & CheckoutCtx & FreshCtx
> = {
  ...boardHandlers,
  ...trackingHandlers,
  ...pipelineHandlers(),
  ...linkedHandlers(),
  ...newCardHandlers(),
  ...checkoutHandlers(),
  ...freshHandlers(),
};
