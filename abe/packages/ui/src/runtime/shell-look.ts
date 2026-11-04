/**
 * The bridge's `look` effect (#108 S4): core's `Look` (`abe theme look`), redeclared here because
 * ui reads only core's types (#37). The check below fails the typecheck if the two drift.
 */
import type { Look as CoreLook } from '@abe/core';
import { z } from 'zod';

export const Look = z.strictObject({
  theme: z.strictObject({
    slug: z.string().min(1),
    name: z.string().min(1),
    dark: z.boolean(),
    syntax: z.enum(['darcula', 'vscode']),
  }),
  scheme: z.strictObject({
    slug: z.string().min(1),
    name: z.string().min(1),
    dark: z.boolean(),
    syntax: z.enum(['darcula', 'vscode']),
    follows: z.boolean(),
  }),
  tokens: z.record(z.string(), z.string()),
  density: z.enum(['compact', 'default']),
  font: z.strictObject({
    family: z.string().min(1),
    size: z.number().positive(),
    editorFamily: z.string().min(1),
    editorSize: z.number().positive(),
    ligatures: z.boolean(),
  }),
  staged: z.boolean(),
});
export type Look = z.infer<typeof Look>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** True only while ui's schema reads exactly core's type. */
export const LOOK_MATCHES_CORE: Same<Look, CoreLook> = true;
