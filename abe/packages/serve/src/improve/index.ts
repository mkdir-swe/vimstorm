/** Improve, its retro and the session logs in serve: a handler for each of core's rows, and what the process folder starts. */
import { type IMPROVE_COMMANDS, type HandlersFor } from '@abe/core';
import { improveHandlers, type ImproveCtx } from './improve';
import { logHandlers, type LogsCtx } from './logs';
import { retroHandlers, type RetroCtx } from './retro';

export { recentCommandsOf, type ImproveCtx } from './improve';
export { startLogShipper, type LogShipper, type LogsCtx } from './logs';
export { type RetroCtx } from './retro';

export const IMPROVE_HANDLERS: HandlersFor<
  typeof IMPROVE_COMMANDS,
  ImproveCtx & RetroCtx & LogsCtx
> = {
  ...improveHandlers(),
  ...retroHandlers(),
  ...logHandlers(),
};
