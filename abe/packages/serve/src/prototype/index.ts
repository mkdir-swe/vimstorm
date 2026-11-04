/** Prototypes in serve: a handler for each of core's rows, and what the process folder starts. */
import { type PROTOTYPE_COMMANDS, type HandlersFor } from '@abe/core';
import { codePrototypeHandlers, type CodePrototypeCtx } from './code-prototype';
import { prototypeHandlers, type PrototypesCtx } from './prototypes';

export {
  openPrototypes,
  type Prototypes,
  type PrototypesCtx,
  type PrototypesOptions,
} from './prototypes';

export const PROTOTYPE_HANDLERS: HandlersFor<
  typeof PROTOTYPE_COMMANDS,
  PrototypesCtx & CodePrototypeCtx
> = {
  ...prototypeHandlers(),
  ...codePrototypeHandlers(),
};
export { tryPrototype, TRY_ID, type TryOptions } from './prototype-try';
