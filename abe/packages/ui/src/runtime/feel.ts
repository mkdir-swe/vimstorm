/**
 * The bridge's `feel` effect (#121): core's `FeelSwitches` (`abe settings feel`), redeclared here
 * because ui reads only core's types (#37). The checks below fail the typecheck if the two drift.
 */
import type { FeelSwitches as CoreFeel } from '@abe/core';
import { z } from 'zod';

export const FeelSwitches = z.strictObject({
  feel: z.enum(['vimstorm', 'webstorm', 'vscode', 'vim']),
  tree: z.strictObject({
    autoReveal: z.boolean(),
    singleClick: z.boolean(),
    decorations: z.enum(['colors', 'letters']),
    compactFolders: z.boolean(),
  }),
  tabs: z.strictObject({
    limit: z.number().int().min(1).max(100).nullable(),
    dirtyDot: z.boolean(),
    preview: z.boolean(),
  }),
  files: z.strictObject({ autoSave: z.enum(['off', 'onFocusChange', 'afterDelay']) }),
  editor: z.strictObject({ minimap: z.boolean(), vim: z.boolean() }),
  chat: z.strictObject({
    openByDefault: z.boolean(),
    width: z.number().int().min(320).max(640),
  }),
  keys: z.array(
    z.strictObject({
      key: z.string().min(1),
      action: z.string().min(1),
      lhs: z.array(z.string().min(1)),
      does: z.string().min(1),
    }),
  ),
});
export type FeelSwitches = z.infer<typeof FeelSwitches>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True only while ui's schema reads exactly core's type. */
export const FEEL_MATCHES_CORE: Same<FeelSwitches, CoreFeel> = true;
