/**
 * Implicit context (#115 Behaviour 4): what goes with a message to the agent without asking, the
 * code you look at or the card you have selected, written after the message as one `Context:`
 * block; and the same block read back off a sent prompt, for the chip the transcript folds on your
 * message (#113). Paths are relative to the workspace's root; the selected lines come with the
 * context or are read from the session's worktree by `serve`.
 */
import { z } from 'zod';

/** What comes between the message and its context. */
export const CONTEXT_MARK = '\n\nContext: ';
/** A selection longer than this sends its first lines and says how many more there are. */
export const CONTEXT_LINES_MAX = 200;

/** Relative to the workspace's root, never out of it. */
const WorkspacePath = z
  .string()
  .min(1)
  .refine(
    // eslint-disable-next-line no-control-regex -- a control character is what is refused
    (p) => !p.startsWith('/') && !p.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(p),
    { message: 'a path in the workspace, relative to its root (no leading / or .., one line)' },
  );
const LineNumber = z.number().int().positive();

/**
 * `abe session send --context <json>`, in the app's `context` frame's shapes: a selection (its
 * lines with it, else read from the worktree), the caret's line, or the Factory view's card; in a
 * prototype chat (#350), the page shown (its path) or the change picked in Prototype mode's list.
 */
export const ImplicitContext = z.union([
  z
    .strictObject({
      path: WorkspacePath,
      from: LineNumber,
      to: LineNumber,
      lines: z.array(z.string()).optional(),
    })
    .refine((s) => s.from <= s.to, { message: 'a selection ends at or after its first line' }),
  z.strictObject({ path: WorkspacePath, line: LineNumber }),
  z.strictObject({ card: z.number().int().positive(), title: z.string() }),
  z.strictObject({
    page: z
      .string()
      .min(1)
      .regex(/^\/[^\n]*$/),
  }),
  z.strictObject({ change: z.number().int().positive(), what: z.string() }),
]);
export type ImplicitContext = z.infer<typeof ImplicitContext>;

/** A selection as it is sent: with its lines. */
export type SelectedLines = { path: string; from: number; to: number; lines: readonly string[] };
/** A context as it is sent: a selection has its lines by now. */
export type SentContext = SelectedLines | Exclude<ImplicitContext, { from: number }>;

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

const span = (from: number, to: number) => (from === to ? `line ${from}` : `lines ${from}–${to}`);

/** The context's first line, after `Context: `: what the transcript's `user` entry keeps. */
export const contextLine = (c: ImplicitContext | SentContext): string => {
  if ('card' in c) return `story #${c.card} ${c.title}`.trimEnd();
  if ('page' in c) return `page ${c.page}`;
  if ('change' in c) return `change ${c.change} ${c.what}`.trimEnd();
  if ('line' in c) return `${c.path}, caret on line ${c.line}`;

  return `${c.path} ${span(c.from, c.to)}`;
};

/** The fence's language: the file's extension (`ts`, `md`), or none. */
const language = (path: string) =>
  /\.([A-Za-z0-9]+)$/.exec(path.split('/').at(-1) ?? '')?.[1] ?? '';

/** Three backticks, or one more than the longest run of them in the lines. */
const fenceFor = (lines: readonly string[]) => {
  const longest = Math.max(
    0,
    ...lines.map((l) => Math.max(0, ...[...l.matchAll(/`+/g)].map((m) => m[0].length))),
  );

  return '`'.repeat(Math.max(3, longest + 1));
};

/**
 * The prompt a message is sent as: the text alone, or the text, a blank line and its context; a
 * selection's lines follow in a fenced block, at most `CONTEXT_LINES_MAX` of them.
 */
export const messageWithContext = (text: string, context: SentContext | null): string => {
  if (context === null) return text;
  const head = `${text}${CONTEXT_MARK}${contextLine(context)}`;

  if (!('from' in context)) return head;
  const shown = context.lines.slice(0, CONTEXT_LINES_MAX);
  const more = context.lines.length - shown.length;
  const fence = fenceFor(shown);

  return [
    head,
    `${fence}${language(context.path)}`,
    ...shown,
    fence,
    ...(more > 0 ? [`… ${more} more ${plural(more, 'line')}`] : []),
  ].join('\n');
};

const SELECTION = /^(.+) lines? (\d+)(?:–(\d+))?$/;
const CARET = /^(.+), caret on line (\d+)$/;
const CARD = /^story #(\d+)(?: (.*))?$/;
const PAGE = /^page (\/.*)$/;
const CHANGE = /^change (\d+)(?: (.*))?$/;
const HEAD = 'Context: ';
const FENCE = /^(`{3,})[A-Za-z0-9]*$/;
const MORE = /^… \d+ more lines?$/;

/**
 * Where the context block starting at line `at` (`Context: …`) ends, or undefined when it is none
 * of the forms `messageWithContext` writes: a caret or card line alone, a selection's line followed
 * by its fenced lines (and how many more); each ends the prompt or comes before a blank line.
 */
const blockEnd = (lines: readonly string[], at: number): number | undefined => {
  const head = (lines[at] ?? '').slice(HEAD.length);
  const closes = (end: number) =>
    end === lines.length - 1 || lines[end + 1] === '' ? end : undefined;

  if (CARET.test(head) || CARD.test(head) || PAGE.test(head) || CHANGE.test(head))
    return closes(at);
  if (!SELECTION.test(head)) return undefined;
  const fence = FENCE.exec(lines[at + 1] ?? '')?.[1];

  if (fence === undefined) return undefined;
  const shut = lines.indexOf(fence, at + 2);

  if (shut < 0) return undefined;

  return closes(MORE.test(lines[shut + 1] ?? '') ? shut + 1 : shut);
};

/**
 * A sent prompt split back into your text and its context's first line (null: none). Every context
 * block is taken out (a queue sent as one prompt holds one per message that had one) and the first
 * one's line kept; the text around them stays, a blank line between. A selection's own lines are
 * never read as a block.
 */
export const splitContext = (prompt: string): { text: string; context: string | null } => {
  const lines = prompt.split('\n');
  const kept: string[] = [];
  let context: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const end =
      i >= 1 && lines[i - 1] === '' && line.startsWith(HEAD) ? blockEnd(lines, i) : undefined;

    if (end === undefined) {
      kept.push(line);
      continue;
    }
    context ??= line.slice(HEAD.length);
    // The blank line before it goes with it; the one after it parts what is left.
    kept.pop();
    i = end;
  }

  return { text: kept.join('\n'), context };
};

/**
 * The chip's words for a context line: `@api/src/cart.ts#L12-18`, `@api/src/cart.ts:16`,
 * `#2 The cart total ignores quantity · story`; null for a line in none of the forms.
 */
export const contextChip = (line: string): string | null => {
  const caret = CARET.exec(line);

  if (caret !== null) return `@${caret[1] ?? ''}:${caret[2] ?? ''}`;
  const card = CARD.exec(line);

  if (card !== null)
    return `#${card[1] ?? ''}${card[2] === undefined ? '' : ` ${card[2]}`} · story`;
  const page = PAGE.exec(line);

  if (page !== null) return `@${page[1] ?? ''} · page`;
  const change = CHANGE.exec(line);

  if (change !== null) return `change ${change[1] ?? ''} · selected`;
  const selection = SELECTION.exec(line);

  if (selection === null) return null;
  const [, path = '', from = '', to] = selection;

  return `@${path}#L${from}${to === undefined ? '' : `-${to}`}`;
};
