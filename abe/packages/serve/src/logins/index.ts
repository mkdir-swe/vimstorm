/** Logins in serve: a handler for each of core's rows, and what the process folder starts. */
import { type LOGIN_COMMANDS, type HandlersFor } from '@abe/core';
import { loginHandlers, type RepoLoginsCtx, type StoredLoginsCtx } from './logins';

export {
  repoLoginStatus,
  startStoredLogins,
  type StoredLogins,
  type StoredLoginsCtx,
  type StoredLoginsOptions,
} from './logins';

export const LOGIN_HANDLERS: HandlersFor<
  typeof LOGIN_COMMANDS,
  StoredLoginsCtx & RepoLoginsCtx & { cwd: string }
> = {
  ...loginHandlers(),
};
