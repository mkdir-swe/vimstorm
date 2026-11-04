/** Verification's browser and its profiles in serve: a handler for each of core's rows, and what the process folder starts. */
import { type BROWSER_COMMANDS, type HandlersFor } from '@abe/core';
import { browserHandlers, type BrowserCtx } from './browser';
import { browserProfileHandlers, type BrowserStoreCtx } from './browser-profiles';

export { startBrowserService, type BrowserCtx, type BrowserService } from './browser';
export { type BrowserStoreCtx } from './browser-profiles';
export { PROFILE_WATCH_MS, type ProfileWatch, startProfileWatch } from './profile-watch';

export const BROWSER_HANDLERS: HandlersFor<typeof BROWSER_COMMANDS, BrowserCtx & BrowserStoreCtx> =
  {
    ...browserHandlers(),
    ...browserProfileHandlers(),
  };
