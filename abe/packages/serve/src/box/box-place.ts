/**
 * `abe box place <card>` (#57; ADR 0016 as amended, ADR 0021: one Workspace, one box) from the
 * Mac: where the card's Workspace goes, by the launches' own rules (core's `placeCard`) and queue
 * (`cloud.ts`). `--apply` wakes or makes the box (`box.state` `starting`, then `running`), or holds
 * it Queued in this `serve` until a box stops or is deleted, or
 * `limits.maxBoxesPerPerson` rises.
 */
import { existsSync } from 'node:fs';
import { localCheckoutOf, type Outcome, parseCardId, refused, type Handlers } from '@abe/core';
import { type CloudSessions } from './cloud';
import { realPathAt } from '../contract/here';
import { cloudRepo } from '../session/sessions';
import { type SettingsCtx } from '../layer/settings';

export type BoxPlaceCtx = SettingsCtx & {
  serve: {
    cloud: CloudSessions | undefined;
  };
};

/**
 * Local mode (#24) where `where` is: agents run on this Mac only, so no box is placed, woken or
 * made for it (ADR 0022's repo box stays as it is). Undefined when local mode is off there.
 */
export const localModeBoxRefusal = (
  ctx: SettingsCtx,
  where: string,
): Outcome<never> | undefined => {
  const on = localCheckoutOf(ctx.settings?.at(where).values.localMode ?? [], where);

  return on === undefined
    ? undefined
    : refused('local-mode', `local mode is on in ${on}: no box for it (abe local off first)`);
};

export const boxPlaceHandlers = () =>
  ({
    'box place': async (args, ctx) => {
      const card = parseCardId(args.card);

      if (card === undefined) return refused('usage', `not a card id (4, AB#4): ${args.card}`, 2);
      const text = args.repo ?? '.';
      const path = realPathAt(ctx.cwd, text);
      const where = existsSync(path) ? path : ctx.cwd;
      const local = localModeBoxRefusal(ctx, where);

      if (local !== undefined) return local;
      if (ctx.serve.cloud === undefined)
        return refused(
          'no-boxes',
          'this abe serve fronts no boxes: boxes are placed from your local machine',
        );
      const repo = await cloudRepo(text, path);

      if (!repo.ok) return repo;

      return ctx.serve.cloud.place({
        repo: repo.data,
        card,
        title: args.title ?? '',
        where,
        apply: args.apply,
      });
    },
  }) satisfies Partial<Handlers<BoxPlaceCtx>>;
