/**
 * One-shots for `serve`'s handlers: a small ask answered by `claude -p` through the `OneShot` port,
 * as a role (its model lowered by the `allowedModels` in force where it runs) and in the clean
 * environment a session gets, without its socket (core's `oneShotEnv`). Triage (#76) is the first
 * user; improve (#84), retro (#86) and Make card (#82) ask the same way.
 */
import {
  type Env,
  modelFor,
  ONE_SHOT_TIMEOUT_MS,
  type OneShot,
  oneShotEnv,
  type Outcome,
  refused,
  type Role,
} from '@abe/core';
import { type SettingsCtx } from './settings';

/** The port, and what its environment is made from: `serve`'s own and the session `abe`'s folder. */
export type OneShotOptions = { port: OneShot; env: Env; bin: string; timeoutMs?: number };

export type OneShotCtx = SettingsCtx & {
  serve: {
    oneShot: OneShotOptions | undefined;
  };
};

/** Asks `prompt` (with `system` after Claude Code's own) as `role`, in `cwd`: its text and model. */
export const askOneShot = async (
  ctx: OneShotCtx,
  q: {
    role: Role;
    cwd: string;
    prompt: string;
    system: string;
    /** The Reach names a session there would get (`sessionReach`'s read names). */
    reach: Readonly<Record<string, string>>;
  },
): Promise<Outcome<{ text: string; model: string }>> => {
  if (ctx.serve.oneShot === undefined)
    return refused('no-one-shot', 'this abe serve was started without a one-shot runner');
  if (ctx.settings === undefined)
    return refused('no-settings', 'no settings to read allowedModels from');
  const model = modelFor(q.role, ctx.settings.at(q.cwd).values.allowedModels);

  if (model === undefined) return refused('no-model', 'allowedModels allows no model');
  const env = oneShotEnv({
    parent: ctx.serve.oneShot.env,
    bin: ctx.serve.oneShot.bin,
    reach: q.reach,
  });

  if (!env.ok) return refused(env.code, env.message);
  const asked = await ctx.serve.oneShot.port.ask({
    prompt: q.prompt,
    system: q.system,
    model,
    cwd: q.cwd,
    env: env.env,
    timeoutMs: ctx.serve.oneShot.timeoutMs ?? ONE_SHOT_TIMEOUT_MS,
  });

  return asked.ok
    ? { ok: true, data: { text: asked.data.text, model } }
    : refused(asked.error.code, asked.error.message);
};
