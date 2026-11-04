/** Terminal colour and cursor codes in text a tool printed (#187: vitest's in `checks.md`). */

// eslint-disable-next-line no-control-regex -- terminal colours and cursor moves in captured output
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Z0-9]/g;

/** The text with its terminal codes taken out: what a person or an agent reads as markdown. */
export const withoutAnsi = (text: string): string => text.replace(ANSI, '');

// eslint-disable-next-line no-control-regex -- what is left of a code once its ESC is gone, and other control characters
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]|\[\?[0-9;]*[hl]/g;

/**
 * A check's output as a row shows it (#345: `claude auth status failed: [?2004hDo you trust…`):
 * its terminal codes, a bracketed-paste switch that lost its ESC and other control characters out.
 */
export const plainText = (text: string): string => withoutAnsi(text).replace(CONTROL, '');
