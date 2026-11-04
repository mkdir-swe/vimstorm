/**
 * Question, grill and permission cards (#114): what the session asks, as one card shape Chat
 * draws, and the answer that goes back. Pure: serve keeps the cards, sends the answers and holds
 * the hooks.
 *
 * A question comes from Claude Code's own AskUserQuestion (the #113 spike): its PreToolUse input
 * becomes the card and the tool is denied with `askDeny`, so the turn ends and the answer is the
 * session's next prompt (`questionMessage`, `grillMessage`), typed as `session send` types one.
 * Several questions in one call are a grill round, one card each, answered as one message.
 *
 * A permission card comes from a PermissionRequest serve holds under a live Override; its answer is
 * Claude Code's PermissionRequest decision (`permissionDecision`), printed by the hook.
 */
import { z } from 'zod';
import { type Outcome, refused } from '../command';
import { type PermissionAnswer, type PreToolAnswer } from './permission';
import { askedQuestions } from './transcript';

/** `needs-you` (#114 S5) comes later; its options are the Factory's. */
export const ASK_KINDS = ['question', 'grill', 'permission'] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** Options are picked with a digit: nine at most. */
export const MAX_OPTIONS = 9;

export const AskOption = z.object({
  n: z.number().int().min(1).max(MAX_OPTIONS),
  label: z.string(),
  note: z.string().optional(),
  recommended: z.boolean(),
});
export type AskOption = z.infer<typeof AskOption>;

/** What a card says on the line it shows after its time ran out (a held permission's 600 s). */
export const EXPIRED_TEXT = 'Answer in Terminal mode · ⌃⌘→';

/**
 * One card: its `title` the line drawn, `question` the words the answer quotes, `why` the line
 * under it, `where` (a permission's) where the command runs, `own` the row for your own words.
 * A grill card's `round` is its place in the round (`id` the round's, shared by its cards).
 */
export const AskCard = z.object({
  id: z.string(),
  session: z.string(),
  kind: z.enum(ASK_KINDS),
  title: z.string(),
  question: z.string(),
  why: z.string().nullable(),
  where: z.string().optional(),
  options: z.array(AskOption),
  /** Several options may be picked (AskUserQuestion's `multiSelect`): Space ticks, ⏎ sends. */
  multi: z.boolean().optional(),
  own: z.string(),
  round: z
    .object({
      id: z.string(),
      n: z.number().int().positive(),
      of: z.number().int().positive(),
    })
    .nullable(),
  at: z.iso.datetime(),
  /** Why it can no longer be answered here (`EXPIRED_TEXT`); null while it can. */
  expired: z.string().nullable(),
  /** A permission card's prompt, as the session-scoped allow matches it again. */
  prompt: z.object({ tool: z.string(), input: z.string() }).optional(),
  /**
   * A permission card Claude Code's own dialog asks (not held by serve): its answer presses the
   * dialog's keys (`dialogKeys`) while the dialog is up.
   */
  dialog: z.boolean().optional(),
  /**
   * A grill question's pick before its round is sent (#342: `session answer --pick`), kept by
   * serve so a restart, a second client and Reopen show it; absent: not picked yet.
   */
  picked: z
    .union([
      z.object({ option: z.number().int().positive() }),
      z.object({ options: z.array(z.number().int().positive()).min(1) }),
      z.object({ text: z.string().min(1) }),
    ])
    .optional(),
});
export type AskCard = z.infer<typeof AskCard>;

/**
 * Whether newly asked cards are a question round (#342): a question or a grill round, not a
 * permission held or a card asked again as expired. A session counts its rounds by it
 * (`SessionData.rounds`), on its own serve and, from the box's `session.ask`, on the Mac's.
 */
export const asksRound = (cards: readonly Pick<AskCard, 'kind' | 'expired'>[]): boolean =>
  cards.some((c) => (c.kind === 'question' || c.kind === 'grill') && c.expired === null);

/**
 * The round to count for newly asked cards, given the rounds already counted for the session: its
 * id, or none (not a question round, or counted: a pick re-sends its round's cards, a held card
 * re-sent expires). The box's `session.ask` counts the Mac's `rounds` by it.
 */
export const roundToCount = (
  seen: ReadonlySet<string>,
  cards: readonly (Pick<AskCard, 'id' | 'kind' | 'expired'> & {
    round?: { id: string } | null | undefined;
  })[],
): string | undefined => {
  const round = cards[0]?.round?.id ?? cards[0]?.id;

  return round !== undefined && asksRound(cards) && !seen.has(round) ? round : undefined;
};

const OWN: Readonly<Record<AskKind, string>> = {
  question: 'Type your own answer…',
  grill: 'Type your own answer…',
  permission: 'Tell it what to do instead…',
};

/** The rest of the deny reason: the agent ends its turn and waits for the next prompt. */
export const ASK_DENY_REASON = 'End your turn now; the answers come as your next message.';

/** AskUserQuestion's PreToolUse answer: denied, the question asked in Chat instead. */
export const askDeny = (question: string): PreToolAnswer => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `Asked in Abe's Chat: ${question} ${ASK_DENY_REASON}`,
  },
});

/** The first sentence, and what follows it (null when nothing does). */
const sentences = (text: string): [string, string | null] => {
  const at = /[.?!](\s+)(?=\S)/.exec(text);

  if (at === null) return [text.trim(), null];
  const cut = at.index + 1;
  const rest = text.slice(cut).trim();
  const [second] = sentences(rest);

  return [text.slice(0, cut).trim(), second === '' ? null : second];
};

/**
 * AskUserQuestion's input as cards, in its order; null when it is not that shape. `base` names the
 * card (a grill's cards `<base>.<n>`, the round's id `base`).
 */
export const askCards = (
  input: unknown,
  o: { session: string; base: string; at: string },
): AskCard[] | null => {
  const asked = askedQuestions(input);

  if (asked === null || asked.length === 0) return null;
  const grill = asked.length > 1;

  return asked.map((q, i): AskCard => {
    const [first, second] = sentences(q.question);
    const header = q.header?.trim() ?? '';
    const why = header !== '' ? header : second;
    const ordered = [
      ...q.options.filter((x) => x.recommended),
      ...q.options.filter((x) => !x.recommended),
    ].slice(0, MAX_OPTIONS);
    let marked = false;

    return {
      id: grill ? `${o.base}.${i + 1}` : o.base,
      session: o.session,
      kind: grill ? 'grill' : 'question',
      title: header === '' && second !== null ? first : q.question,
      question: q.question,
      why,
      options: ordered.map((x, j) => {
        // one recommended row, the one ⏎ and `y` take
        const recommended = x.recommended && !marked;

        marked ||= recommended;

        return {
          n: j + 1,
          label: x.label.trim(),
          ...(x.note === null ? {} : { note: x.note }),
          recommended,
        };
      }),
      ...(q.multiSelect ? { multi: true } : {}),
      own: OWN[grill ? 'grill' : 'question'],
      round: grill ? { id: o.base, n: i + 1, of: asked.length } : null,
      at: o.at,
      expired: null,
    };
  });
};

/**
 * One card's answer: an option by its number, a multiSelect question's options (`multi`), or your
 * own words.
 */
export type Choice = { option: number } | { options: number[] } | { text: string };

/** The card's options `ns` names, in the card's order, or why not. */
const optionsNamed = (
  card: Pick<AskCard, 'id' | 'options' | 'multi'>,
  ns: readonly number[],
): Outcome<AskOption[]> => {
  if (ns.length === 0) return refused('usage', 'no option ticked: pick one or more', 2);
  if (ns.length > 1 && card.multi !== true)
    return refused('one-option', `card ${card.id} takes one option, not ${ns.length}`, 2);
  const missing = ns.find((n) => !card.options.some((x) => x.n === n));

  if (missing !== undefined)
    return refused(
      'no-option',
      `card ${card.id} has options 1–${card.options.length}, not ${missing}`,
      2,
    );

  return { ok: true, data: card.options.filter((x) => ns.includes(x.n)) };
};

const pick = (card: AskCard, choice: Choice): Outcome<string> => {
  if ('text' in choice) {
    const text = choice.text.trim();

    return text === ''
      ? refused('usage', 'own words are empty: type the answer', 2)
      : { ok: true, data: text };
  }
  const named = optionsNamed(card, 'options' in choice ? choice.options : [choice.option]);

  return named.ok
    ? { ok: true, data: named.data.map((x) => `${x.n} ${x.label}`).join(', ') }
    : named;
};

/** A question's answer as the next prompt: `Answer to "<question>": 1 <label>`, or the words typed. */
export const questionMessage = (card: AskCard, choice: Choice): Outcome<string> => {
  const picked = pick(card, choice);

  return picked.ok ? { ok: true, data: `Answer to "${card.question}": ${picked.data}` } : picked;
};

/** A grill round's answers, one per card in the round's order, as one numbered message. */
export const grillMessage = (
  cards: readonly AskCard[],
  choices: readonly Choice[],
): Outcome<string> => {
  if (choices.length !== cards.length)
    return refused(
      'grill-answers',
      `the round has ${cards.length} questions: answer all ${cards.length} at once (${choices.length} given)`,
      2,
    );
  const lines: string[] = [];

  for (const [i, card] of cards.entries()) {
    const choice = choices[i];

    if (choice === undefined) continue;
    const line = questionMessage(card, choice);

    if (!line.ok) return line;
    lines.push(`${i + 1}. ${line.data}`);
  }

  return { ok: true, data: lines.join('\n') };
};

/** The prompt a question or a grill round's answers send. */
export const askAnswer = (
  cards: readonly AskCard[],
  choices: readonly Choice[],
): Outcome<string> => {
  const [only] = cards;

  if (cards.length === 1 && only?.round === null) {
    const [choice] = choices;
    const options = choices.flatMap((c) => ('option' in c ? [c.option] : []));

    // a multiSelect question: each --option one of its answers
    if (only.multi === true && choices.length > 1 && options.length === choices.length)
      return questionMessage(only, { options });
    if (choices.length !== 1 || choice === undefined)
      return refused('usage', `card ${only.id} takes one answer: --option <n> or --text`, 2);

    return questionMessage(only, choice);
  }

  return grillMessage(cards, choices);
};

/** A multiSelect question's options, by their numbers. */
const Options = z.array(z.number().int().positive()).min(1);

/**
 * `--pick <n>:<value>` (#342): the round's n-th question picked, its value an option's number or
 * own words as a JSON string (`2:3`, `1:"cart only"`), so no words are read as a number.
 */
export const readPick = (text: string): Outcome<{ n: number; choice: Choice }> => {
  const at = text.indexOf(':');
  const n = Number(text.slice(0, at));
  const usage = refused(
    'usage',
    `--pick is <n>:<option>, <n>:[<option>, …] or <n>:"own words", not ${text}`,
    2,
  );

  if (at < 1 || !Number.isInteger(n) || n < 1) return usage;
  let value: unknown;

  try {
    value = JSON.parse(text.slice(at + 1));
  } catch {
    return usage;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0)
    return { ok: true, data: { n, choice: { option: value } } };
  const options = Options.safeParse(value);

  if (options.success) return { ok: true, data: { n, choice: { options: options.data } } };
  if (typeof value === 'string' && value.trim() !== '')
    return { ok: true, data: { n, choice: { text: value.trim() } } };

  return usage;
};

/** The grill question a pick names on its round's card, with the pick kept, or why not. */
export const withPick = (
  cards: readonly AskCard[],
  n: number,
  choice: Choice,
): Outcome<AskCard> => {
  const card = cards.find((c) => c.round?.n === n);

  if (card?.kind !== 'grill')
    return refused('no-card', `a pick is for a grill round's question: none is ${n} here`, 2);
  if (card.expired !== null) return refused('card-expired', `${card.title}: ${card.expired}`);
  if (!('text' in choice)) {
    const named = optionsNamed(card, 'options' in choice ? choice.options : [choice.option]);

    if (!named.ok) return named;
  }

  return { ok: true, data: { ...card, picked: choice } };
};

/** `--answers` as JSON: each card's option number, its options' numbers, or own words. */
const Answers = z.array(z.union([z.number().int().positive(), Options, z.string()])).min(1);

/** `session answer`'s flags as choices: one `--option` or `--text`, repeated `--option`s, or `--answers`. */
export const readChoices = (args: {
  option: readonly number[];
  text?: string;
  answers?: string;
}): Outcome<Choice[]> => {
  const given = [args.option.length > 0, args.text !== undefined, args.answers !== undefined];

  if (given.filter(Boolean).length !== 1)
    return refused(
      'usage',
      'answer with one of --option <n> (repeated for a grill), --text or --answers',
      2,
    );
  if (args.text !== undefined) return { ok: true, data: [{ text: args.text }] };
  if (args.answers === undefined)
    return { ok: true, data: args.option.map((option) => ({ option })) };
  let doc: unknown;

  try {
    doc = JSON.parse(args.answers);
  } catch {
    return refused('usage', '--answers is not JSON: [1, "own words", 3]', 2);
  }
  const read = Answers.safeParse(doc);

  if (!read.success)
    return refused(
      'usage',
      '--answers is a list of numbers, lists of numbers or texts: [1, "own words", [2, 3]]',
      2,
    );

  return {
    ok: true,
    data: read.data.map((x): Choice => {
      if (typeof x === 'number') return { option: x };

      return typeof x === 'string' ? { text: x } : { options: x };
    }),
  };
};

/** The PermissionRequest fields a card reads. */
const Prompt = z.looseObject({ tool_name: z.string(), tool_input: z.unknown().optional() });
const Bash = z.looseObject({
  command: z.string(),
  dangerouslyDisableSandbox: z.boolean().optional(),
});
const FileInput = z.looseObject({ file_path: z.string() });
const UrlInput = z.looseObject({ url: z.string() });

const TITLE_MAX = 120;
const short = (text: string) => {
  const line = text.split('\n')[0] ?? '';

  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

/** What a prompt asks to run or reach, as one line (a command, a path, a URL); '' for none. */
export const promptInput = (
  payload: unknown,
): { tool: string; input: string; sandboxed: boolean; path?: string } => {
  const p = Prompt.safeParse(payload);

  if (!p.success) return { tool: 'This tool', input: '', sandboxed: false };
  const tool = p.data.tool_name;
  const bash = Bash.safeParse(p.data.tool_input);

  if (tool === 'Bash' && bash.success)
    return {
      tool,
      input: bash.data.command,
      sandboxed: bash.data.dangerouslyDisableSandbox !== true,
    };
  const file = FileInput.safeParse(p.data.tool_input);

  if (file.success)
    return { tool, input: file.data.file_path, sandboxed: false, path: file.data.file_path };
  const url = UrlInput.safeParse(p.data.tool_input);

  if (url.success) return { tool, input: url.data.url, sandboxed: false };

  return { tool, input: '', sandboxed: false };
};

/**
 * Where a held command runs: this Mac's sandbox, outside it, a box's workspace, or the Abe chat's
 * (`hub`: this Mac, no sandbox at all).
 */
export type PromptWhere = 'local' | 'cloud' | 'hub';

const whereText = (where: PromptWhere, sandboxed: boolean, bash: boolean): string => {
  if (where === 'cloud') return "Cloud workspace · it runs in the box's workspace container";
  if (where === 'hub')
    return bash
      ? 'Local · no sandbox · the command runs on this machine as you'
      : 'Local · no sandbox · a Claude Code tool on this machine';
  if (!bash) return 'This machine · a Claude Code tool, outside the sandbox';

  return sandboxed
    ? "Local sandbox · the command runs in Claude Code's sandbox"
    : 'This machine · the command runs outside the sandbox';
};

const PERMISSION_ROWS = ['Allow once', 'Allow for this session', 'Deny'] as const;

/**
 * A held PermissionRequest as a card: `Allow <Tool>: <command>?`, the why in Reach's words, where
 * it runs, and Allow once recommended when it stays in the worktree (a sandboxed command, a file
 * inside it).
 */
export const permissionCard = (
  payload: unknown,
  o: { session: string; id: string; at: string; why: string; where: PromptWhere; worktree: string },
): AskCard => {
  const asked = promptInput(payload);
  const bash = asked.tool === 'Bash';
  // the Abe chat has no sandbox: none of its commands is held to the worktree
  const sandboxed = asked.sandboxed && o.where !== 'hub';
  const inside = bash
    ? sandboxed
    : asked.path?.startsWith(`${o.worktree.replace(/\/+$/, '')}/`) === true;
  const title =
    asked.input === '' ? `Allow ${asked.tool}?` : `Allow ${asked.tool}: ${short(asked.input)}?`;

  return {
    id: o.id,
    session: o.session,
    kind: 'permission',
    title,
    question: title,
    why: o.why,
    where: whereText(o.where, sandboxed, bash),
    options: PERMISSION_ROWS.map((label, i) => ({
      n: i + 1,
      label,
      recommended: i === 0 && inside,
    })),
    own: OWN.permission,
    round: null,
    at: o.at,
    expired: null,
    prompt: { tool: asked.tool, input: asked.input },
  };
};

/** What a permission card's answer does: Claude Code's decision, and whether the allow lasts the session. */
export const permissionDecision = (
  choice: Choice,
): { answer: PermissionAnswer; session: boolean; words: string } => {
  const answer = (
    decision: PermissionAnswer['hookSpecificOutput']['decision'],
  ): PermissionAnswer => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });

  if ('text' in choice)
    return {
      answer: answer({ behavior: 'deny', message: choice.text }),
      session: false,
      words: choice.text,
    };
  const n = 'option' in choice ? choice.option : undefined;

  if (n === 1 || n === 2)
    return {
      answer: answer({ behavior: 'allow' }),
      session: n === 2,
      words: PERMISSION_ROWS[n - 1] ?? 'Allow',
    };

  return {
    answer: answer({ behavior: 'deny', message: "Denied in Abe's Chat." }),
    session: false,
    words: 'Deny',
  };
};

/** Claude Code's own permission dialog's question: `Do you want to proceed?`, `… make this edit to x?`. */
const DIALOG_ASK = /^\s*Do you want to .+\?\s*$/;
/** One of its rows: `❯ 1. Yes`, `  2. Yes, and don't ask again for …`, the focused one with `❯`. */
const DIALOG_ROW = /^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$/;
/** The line under its rows. */
const DIALOG_FOOT = 'Esc to cancel';

/**
 * Whether `screen` shows a dialog of Claude Code's: its permission question, or the `Esc to
 * cancel` line its dialogs end in. False once it is answered and Claude Code is at its prompt.
 */
export const dialogShown = (screen: string): boolean =>
  screen.split('\n').some((l) => DIALOG_ASK.test(l) || l.includes(DIALOG_FOOT));

/** The rows of the last dialog of Claude Code's on `screen`, the focused one marked; none: no dialog. */
const dialogRows = (screen: string): { label: string; focused: boolean }[] => {
  const lines = screen.split('\n');
  const start = lines.findLastIndex((l) => DIALOG_ASK.test(l));

  if (start < 0) return [];
  const rows: { label: string; focused: boolean }[] = [];

  for (const line of lines.slice(start + 1)) {
    if (line.includes(DIALOG_FOOT)) break;
    const m = DIALOG_ROW.exec(line);

    // a long row's wrapped words are no row
    if (m !== null) rows.push({ label: m[3] ?? '', focused: m[1] !== undefined });
  }

  return rows;
};

/**
 * Whether Allow for this session is no answer to the dialog on `screen`: it is up, and only asks
 * `Yes` / `No` (no `Yes, and don't ask again …` row). Allowing it once instead would say one
 * thing and do another: the answer is refused, saying so (N3).
 */
export const dialogNoAlways = (screen: string, choice: Choice): boolean => {
  const rows = dialogRows(screen);

  return (
    'option' in choice &&
    choice.option === 2 &&
    rows.length > 0 &&
    !rows.some((r) => r.label.startsWith('Yes,'))
  );
};

/** Why Allow for this session is refused on a dialog with no such row (`dialogNoAlways`). */
export const NO_ALWAYS_TEXT =
  "Claude Code's dialog has no allow for this session here: Allow once (1) or Deny (3)";

/**
 * The keys (tmux's `send-keys` names) that answer Claude Code's own permission dialog on `screen`
 * as a card's `choice` says: Allow once its `Yes` row, Allow for this session its second Yes row
 * (`Yes, and don't ask again …`, `Yes, allow all edits …`; none: no keys, `dialogNoAlways`),
 * reached with ↑/↓ from the focused row, then Enter; Deny and own words its Esc (No). Undefined:
 * no dialog on the screen (answered in the terminal, or Claude Code gave up on it).
 */
export const dialogKeys = (screen: string, choice: Choice): string[] | undefined => {
  const rows = dialogRows(screen);

  if (rows.length === 0) return undefined;
  const n = 'option' in choice ? choice.option : undefined;

  if (n !== 1 && n !== 2) return ['Escape'];
  const to =
    n === 2
      ? rows.findIndex((r) => r.label.startsWith('Yes,'))
      : rows.findIndex((r) => r.label === 'Yes');

  if (to < 0) return undefined;
  const from = Math.max(
    0,
    rows.findIndex((r) => r.focused),
  );

  return [...Array<string>(Math.abs(to - from)).fill(to > from ? 'Down' : 'Up'), 'Enter'];
};

/** `abe session asks`: the session's open cards, oldest first. */
export const SessionAsksData = z.object({ id: z.string(), cards: z.array(AskCard) });
export type SessionAsksData = z.infer<typeof SessionAsksData>;

const cardLine = (c: AskCard) =>
  [
    `${c.id}  ${c.kind}${c.round === null ? '' : ` ${c.round.n} of ${c.round.of}`}  ${c.title}${c.expired === null ? '' : `  (${c.expired})`}`,
    ...(c.why === null ? [] : [`  ${c.why}`]),
    ...(c.where === undefined ? [] : [`  ${c.where}`]),
    ...c.options.map((x) => `  ${x.n} ${x.label}${x.recommended ? '  recommended' : ''}`),
    `  o ${c.own}`,
  ].join('\n');

export const sessionAsksText = (d: SessionAsksData): string =>
  d.cards.length === 0 ? `${d.id}: no open cards\n` : `${d.cards.map(cardLine).join('\n')}\n`;

/** `abe session answer`: the cards answered, and what was sent (a permission: its decision). */
export const SessionAnswerData = z.object({
  id: z.string(),
  cards: z.array(z.string()),
  sent: z.string(),
  /** `--pick` (#342): the question picked, kept on its card; nothing was sent. */
  picked: z.string().optional(),
});
export type SessionAnswerData = z.infer<typeof SessionAnswerData>;

export const sessionAnswerText = (d: SessionAnswerData): string =>
  d.picked === undefined
    ? `answered ${d.cards.join(', ')} on ${d.id}: ${d.sent.split('\n')[0] ?? ''}\n`
    : `picked ${d.picked} on ${d.id}: kept until the round is sent\n`;
