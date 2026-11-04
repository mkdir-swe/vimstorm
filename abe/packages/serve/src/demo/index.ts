/** The demo in serve: `abe demo new`'s handler. */
import { type DEMO_COMMANDS, type HandlersFor } from '@abe/core';
import { type DemoCtx, demoHandlers } from './demo';

export { type DemoCtx } from './demo';

export const DEMO_HANDLERS: HandlersFor<typeof DEMO_COMMANDS, DemoCtx> = {
  ...demoHandlers(),
};
