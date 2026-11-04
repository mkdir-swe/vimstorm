/**
 * A box's abe against this Mac's (#188): a box runs the abe its release pins (`/opt/abe`, put
 * there by its boot), the Mac what was built here, so the two can differ. The Mac reads a box's
 * version from its `abe status`; a command or argument the box's abe has not got is said as that
 * (both versions and what to do), never as the box's `unknown command`. Pure: the words and the
 * reading of what a box's `abe` printed.
 */
import { z } from 'zod';
import { ErrorBody } from '../command';
import { type Ran } from '../ports';

/** Where the steps that bring a new abe to the boxes are written. */
export const BOX_RELEASE_DOC = 'docs/cloud.md › A new abe on your box';

const STEP = `update the box release (${BOX_RELEASE_DOC})`;

/** What a box's abe refused for its own table: a command, or an argument of one, it has not got. */
export type TableRefusal = { kind: 'command' | 'argument'; said: string };

/** The usage words of `parse` for an argument the command's table has not got. */
const ARGUMENT = /^(unknown flag |unexpected argument )/;

const ofError = (code: string, message: string): TableRefusal | undefined => {
  if (code === 'unknown-command') return { kind: 'command', said: message };
  if (code === 'usage' && ARGUMENT.test(message)) return { kind: 'argument', said: message };

  return undefined;
};

const Refused = z.object({ ok: z.literal(false), error: ErrorBody });

/** The error of a `--json` answer, if it is one. */
const jsonError = (stdout: string): ErrorBody | undefined => {
  try {
    const doc = Refused.safeParse(JSON.parse(stdout));

    return doc.success ? doc.data.error : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether what `abe <argv>` printed on a box is its abe not knowing the command or one of its
 * arguments (`parse`'s refusals, exit 2): `--json`'s error, else the first line on stderr.
 */
export const tableRefusalOf = (ran: Ran): TableRefusal | undefined => {
  if (ran.exit !== 2) return undefined;
  const error = jsonError(ran.stdout.trim());

  if (error !== undefined) return ofError(error.code, error.message);
  const first = ran.stderr.split('\n')[0] ?? '';

  if (!first.startsWith('abe: ')) return undefined;
  const said = first.slice('abe: '.length);

  return said.startsWith('unknown command: ') ? { kind: 'command', said } : ofError('usage', said);
};

/** A build's release line: its version without the commit `scripts/version.sh` puts after it. */
export const abeLine = (version: string): string => version.replace(/-[0-9a-f]{8}(-dirty)?$/, '');

/**
 * Whether a box's abe is another release than this Mac's (`2.0.0-alpha.0` against `2.2.0-…`): only
 * then is the skew said up front. Another commit of the same line is no warning; a command it lacks
 * is still said as that (`boxTooOldText`).
 */
export const abeSkewed = (theirs: string, here: string): boolean =>
  abeLine(theirs) !== abeLine(here);

/** `box` runs abe `theirs`, this Mac `here`: what that means, and what to do. */
export const abeSkewText = (box: string, theirs: string, here: string): string =>
  `${box} runs abe ${theirs}, this machine ${here}: commands newer than the box's abe fail there · ${STEP}`;

/**
 * `box` just woke on abe `theirs`, not this Mac's `here` (#244): its boot reads the boxes' release
 * (`abe/current`) and, when that is another, installs it and restarts the box's `serve` a minute
 * or two after the wake answered, so the version said now may not be the one that runs then.
 */
export const abeWokeText = (box: string, theirs: string, here: string): string =>
  `${box} woke on abe ${theirs}, this machine ${here}: it stays on ${theirs} unless the boxes' release (abe/current) is another, which its boot then installs a minute or two from now · abe box status ${box} says which abe runs`;

/** A command this Mac sent that the box's abe has not got (or not with these arguments). */
export const boxTooOldText = (o: {
  box: string;
  command: string;
  refusal: TableRefusal;
  theirs: string;
  here: string;
}): string => {
  const runs = `${o.box} runs abe ${o.theirs}, this machine ${o.here}`;

  return o.refusal.kind === 'command'
    ? `${runs}: \`${o.command}\` needs this machine's abe on the box · ${STEP}`
    : `${runs}: its \`${o.command}\` does not take what this machine sends (${o.refusal.said}) · ${STEP}`;
};
