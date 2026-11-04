/**
 * The Mac's link to its boxes, with the version handshake (#188): a box's answer that is its abe
 * not knowing the command or an argument this Mac sent (core's `tableRefusalOf`) is checked
 * against the box's version (its `abe status`, asked then). When the box runs another abe than
 * this one, the answer becomes a `box-version` refusal that names both versions and what to do
 * (`boxTooOldText`), in the shape the command was asked for, so every caller (`--on`, `box keep`,
 * a cloud session's transcript, cards, messages) says it the same way. A box on this same abe, or
 * a command this Mac does not know either, keeps the box's own answer.
 */
import {
  type BoxLink,
  boxTooOldText,
  EXIT,
  parse,
  printFailure,
  type Ran,
  readEnvelope,
  StatusData,
  tableRefusalOf,
} from '@abe/core';

/** The box's abe version from its `abe status --json`; undefined when it did not say. */
const versionOf = (ran: Ran): string | undefined => {
  try {
    const doc = readEnvelope(StatusData, JSON.parse(ran.stdout));

    return doc.ok ? doc.data.version : undefined;
  } catch {
    return undefined;
  }
};

export const versionedLink = (link: BoxLink, here: string): BoxLink => ({
  ...link,
  run: async (box, argv) => {
    const ran = await link.run(box, argv);
    const refusal = tableRefusalOf(ran);

    if (refusal === undefined) return ran;
    const mine = parse(argv);

    // This Mac does not know it either, or only its usage was asked: the box's answer stands.
    if (!mine.ok || mine.global.help) return ran;
    const theirs = versionOf(await link.run(box, ['status', '--json']));

    if (theirs === undefined || theirs === here) return ran;

    return printFailure(
      {
        code: 'box-version',
        message: boxTooOldText({ box, command: mine.id, refusal, theirs, here }),
      },
      EXIT.failed,
      mine.global.json,
    );
  },
});
