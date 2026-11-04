/**
 * `abe card checkout` (B1, #4): the card's branch as origin has it, as a worktree on this Mac
 * beside the checkout, for the person to read or run: a teammate's story, or a box story's second
 * checkout (the box keeps its own). Only a fetch reaches GitHub, so local mode (#24) holds nothing.
 */
import {
  type CardCheckout,
  type Commands,
  type Handler,
  parseCardId,
  refused,
  type Handlers,
} from '@abe/core';
import { realPathAt } from '../contract/here';

/** `checkout`: the Mac's; none on a box, where cards are checked out by their workspaces. */
export type CheckoutCtx = {
  cwd: string;
  serve: {
    checkout: CardCheckout | undefined;
  };
};

const checkout: Handler<Commands['card checkout'], CheckoutCtx> = async (args, ctx) => {
  const id = parseCardId(args.id);

  if (id === undefined) return refused('usage', `not a card id (4, AB#4): ${args.id}`, 2);
  if (ctx.serve.checkout === undefined)
    return refused('no-checkout', 'this abe serve checks out no cards: run it locally');
  const made = await ctx.serve.checkout(realPathAt(ctx.cwd, args.repo ?? '.'), String(id));

  return made.ok
    ? {
        ok: true,
        data: { worktree: made.data.path, branch: made.data.branch, made: made.data.made },
      }
    : made;
};

export const checkoutHandlers = () =>
  ({ 'card checkout': checkout }) satisfies Partial<Handlers<CheckoutCtx>>;
