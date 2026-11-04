/**
 * The New card dialog (#346): a card written from nothing, in the card dialog's look (Make card's).
 * Command mode keeps it as one of its layers: the title, the four picks (Type, Column, Assignee,
 * Sprint: ⏎ on one opens its pick, a word typed there goes to Description; a board on this
 * machine has no Sprint) and the two markdown fields (⇧⏎ a new line), Tab ⇧Tab between them; ⌘⏎ Draft with the agent (`abe card draft`, a one-shot: Why, What and criteria from the
 * title, again from the draft before), ⏎ Create (`abe card create`). Made: the status line says
 * so and the Board is told (`made:<id>`) to select it. Refused: the dialog stays with why in red,
 * and the form is kept for the board, as after Esc; a card made empties it.
 *
 * Pure: the form, its keys, the runs and their answers, and the dialog drawn.
 */
import type { CardDraft } from '@abe/core';
import { draftFields } from '@abe/core/draft-fields';
import { cardName } from '@abe/core/local-names';
import { type Field, fieldInsert, fieldKey, fieldOf, withCaret } from '../runtime/field';
import type { CardDialog } from '../runtime/layers';
import type { Answer, Command, Input, Menu, Refused } from '../runtime/runtime';

/** The menu id the Board gets `made:<id>:<me|none>` on, and an empty column's click (`newcard:<column>`). */
export const NEW_CARD_MENU = 'newcard';

/** The dialog's own id (its node), and its picks' menus (`newcard:pick:<field>`). */
export const NEW_CARD_DIALOG = 'newcard:dialog';
const PICK = 'newcard:pick:';

/** A run's id names its board (`newcard:create:<n>:<board>`): its answer is that board's form's. */
const DRAFT_RUN = 'newcard:draft:';
const CREATE_RUN = 'newcard:create:';
const RUN_ID = /^newcard:(?:draft|create):\d+:(.*)$/s;

/** The board a dialog's run is for, from its id. */
export const runBoard = (id: string): string | undefined => RUN_ID.exec(id)?.[1];

/**
 * A screen opens the dialog (the Board, its `:new <title>` word, an empty column): the board it
 * is on (its key keeps the form), the types (the first the default), the columns, where it was
 * opened, the team's current sprint, the title typed, the Ask chat it comes from.
 */
export type NewCardOn = {
  kind: 'newcard';
  board: string;
  types: readonly string[];
  columns: readonly string[];
  column?: string | undefined;
  sprint: string | null;
  /** The board is on this machine: no sprints, and not Azure's. */
  onThisMachine?: boolean | undefined;
  title?: string | undefined;
  session?: string | undefined;
};

export type Assignee = 'me' | 'none';
export type SprintPick = 'current' | 'none';

/** What is written so far. */
export type NewCardForm = {
  title: string;
  type: string;
  column: string;
  assignee: Assignee;
  sprint: SprintPick;
  description: string;
  criteria: string;
  /** The agent's last draft: drafting again starts from it. */
  drafted?: CardDraft | undefined;
};

export const FIELDS = [
  'title',
  'type',
  'column',
  'assignee',
  'sprint',
  'description',
  'criteria',
] as const;
export type FieldId = (typeof FIELDS)[number];

type TextField = 'title' | 'description' | 'criteria';
type PickField = Exclude<FieldId, TextField>;

const isText = (f: FieldId): f is TextField =>
  f === 'title' || f === 'description' || f === 'criteria';

export type NewCardLayer = {
  kind: 'newcard';
  on: NewCardOn;
  form: NewCardForm;
  focus: FieldId;
  /** The focused text field's caret; absent: at its end. */
  caret?: number | undefined;
  phase: 'ready' | 'drafting' | 'creating';
  /** Why the last draft or create did not go through, red on its line. */
  error?: string | undefined;
  /**
   * When it opened and when its last ⏎ came (ms): Create takes no ⏎ within the guard of either
   * (#285's), so the ⏎ that chose `New card …` held down never also creates.
   */
  opened?: number | undefined;
  enter?: number | undefined;
};

/** A step of the dialog: the layer after it (none: closed), what to run, the form to keep. */
export type NewCardStep = {
  layer: NewCardLayer | undefined;
  commands: Command[];
  /** The board's form kept (Esc, refused) or forgotten (`null`: made); absent: unchanged. */
  keep?: NewCardForm | null | undefined;
  /** A pick to open over it (a ▾ field's). */
  pick?: Menu | undefined;
};

const firstColumn = (on: NewCardOn): string => on.columns[0] ?? 'New';

/** The form a fresh dialog starts with: the board's first type, where it was opened, Me, this sprint. */
export const freshForm = (on: NewCardOn): NewCardForm => ({
  title: on.title ?? '',
  type: on.types[0] ?? 'User Story',
  column: on.column ?? firstColumn(on),
  assignee: 'me',
  sprint: on.sprint === null ? 'none' : 'current',
  description: '',
  criteria: '',
});

/** The dialog opened: on the form kept for its board, the title and column it was opened with over it. */
export const openNewCard = (
  on: NewCardOn,
  kept: NewCardForm | undefined,
  at?: number,
): NewCardLayer => {
  const form =
    kept === undefined
      ? freshForm(on)
      : {
          ...kept,
          ...(on.title === undefined || on.title.trim() === '' ? {} : { title: on.title }),
          ...(on.column === undefined ? {} : { column: on.column }),
        };

  return { kind: 'newcard', on, form, focus: 'title', phase: 'ready', opened: at };
};

const textOf = (l: NewCardLayer, f: TextField): string => l.form[f];

/** The dialog's fields in Tab's order: a board on this machine has no Sprint. */
const fieldsOf = (l: Pick<NewCardLayer, 'on'>): readonly FieldId[] =>
  l.on.onThisMachine === true ? FIELDS.filter((f) => f !== 'sprint') : FIELDS;

/** Its pick fields, as the dialog's line shows them. */
const picksOf = (l: Pick<NewCardLayer, 'on'>): PickField[] =>
  fieldsOf(l).filter((f): f is PickField => !isText(f));

const fieldAt = (l: NewCardLayer): Field | undefined =>
  isText(l.focus) ? fieldOf(textOf(l, l.focus), l.caret) : undefined;

const focused = (l: NewCardLayer, by: 1 | -1): NewCardLayer => {
  const fields = fieldsOf(l);
  const at = fields.indexOf(l.focus);
  const next = fields[(at + by + fields.length) % fields.length] ?? 'title';

  return { ...l, focus: next, caret: undefined };
};

const stay = (layer: NewCardLayer, commands: Command[] = []): NewCardStep => ({ layer, commands });

/** Why Create and Draft are grey, if they are. */
const busy = (l: NewCardLayer): string | undefined => {
  if (l.phase === 'drafting') return 'drafting';
  if (l.phase === 'creating') return 'creating';

  return undefined;
};

const noTitle = (l: NewCardLayer): string | undefined =>
  l.form.title.trim() === '' ? 'give it a title' : undefined;

// ---------------------------------------------------------------- the picks

const pickValues = (l: NewCardLayer, f: PickField): { value: string; text: string }[] => {
  switch (f) {
    case 'type':
      return l.on.types.map((t) => ({ value: t, text: t }));
    case 'column':
      return l.on.columns.map((c) => ({ value: c, text: c }));
    case 'assignee':
      return [
        { value: 'me', text: 'Me' },
        { value: 'none', text: 'Unassigned' },
      ];
    case 'sprint':
      return [
        ...(l.on.sprint === null ? [] : [{ value: 'current', text: l.on.sprint }]),
        { value: 'none', text: 'No sprint (backlog)' },
      ];
  }
};

const pickLabel = (f: PickField): string => {
  switch (f) {
    case 'type':
      return 'Type';
    case 'column':
      return 'Column';
    case 'assignee':
      return 'Assignee';
    case 'sprint':
      return 'Sprint';
  }
};

/** A ▾ field's pick: Command mode's, its rows the values, the one set first. */
const pickOf = (l: NewCardLayer, f: PickField): Menu => ({
  kind: 'menu',
  id: `${PICK}${f}`,
  title: pickLabel(f),
  rows: pickValues(l, f).map((v, i) => ({
    id: `v${i}`,
    text: v.text,
    ...(v.value === l.form[f] ? { dim: 'now' } : {}),
    does: { kind: 'back' },
  })),
});

/** Whether a menu is one of the dialog's picks. */
export const isNewCardPick = (menu: string): boolean => menu.startsWith(PICK);

/** A pick's row chosen: its value set, the keys back on the field. */
export const picked = (l: NewCardLayer, menu: string, row: string): NewCardLayer => {
  const f = menu.slice(PICK.length);
  const field = FIELDS.find((x) => x === f);

  if (field === undefined || isText(field)) return l;
  const value = pickValues(l, field)[Number(row.slice(1))]?.value;

  if (value === undefined) return l;
  switch (field) {
    case 'assignee':
      return { ...l, form: { ...l.form, assignee: value === 'me' ? 'me' : 'none' } };
    case 'sprint':
      return { ...l, form: { ...l.form, sprint: value === 'current' ? 'current' : 'none' } };
    case 'type':
      return { ...l, form: { ...l.form, type: value } };
    case 'column':
      return { ...l, form: { ...l.form, column: value } };
  }
};

// ---------------------------------------------------------------- the runs

/**
 * The draft as the person now has it: Why and What and the criteria read back from the fields
 * (their edits kept for the agent's next draft), the agent's last words where a field reads as none.
 */
const asWritten = (f: NewCardForm, d: CardDraft): CardDraft => {
  const parts = /^## Why\s*\n([\s\S]*?)\n## What\s*\n([\s\S]*)$/.exec(f.description.trim());
  const why = (parts?.[1] ?? f.description).trim();
  const what = (parts?.[2] ?? '').trim();
  const criteria = f.criteria
    .split('\n')
    .map((c) => c.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '').trim())
    .filter((c) => c !== '');

  return {
    title: f.title.trim() === '' ? d.title : f.title.trim(),
    why: why === '' ? d.why : why,
    what: what === '' ? d.what : what,
    criteria: criteria.length === 0 ? d.criteria : criteria,
  };
};

/** `abe card draft`: from the title, the Ask chat it comes from, the draft before as edited. */
const draft = (l: NewCardLayer, n: number): NewCardStep => {
  const why = busy(l) ?? noTitle(l);

  if (why !== undefined) return stay(l);

  return stay({ ...l, phase: 'drafting', error: undefined }, [
    {
      kind: 'run',
      id: `${DRAFT_RUN}${n}:${l.on.board}`,
      argv: [
        'card',
        'draft',
        ...(l.on.session === undefined ? [] : ['--session', l.on.session]),
        ...(l.form.drafted === undefined
          ? []
          : [`--earlier=${JSON.stringify(asWritten(l.form, l.form.drafted))}`]),
        // the words are words, even when they start with `-`
        '--',
        l.form.title.trim(),
      ],
    },
  ]);
};

/** `abe card create` with the form's fields, each `--flag=value` (a value may start with `-`). */
export const createArgv = (l: Pick<NewCardLayer, 'on' | 'form'>): string[] => {
  const f = l.form;

  return [
    'card',
    'create',
    `--title=${f.title.trim()}`,
    // the board's first type is its default; with none known the board picks
    ...(l.on.types.length === 0 || f.type === l.on.types[0] ? [] : [`--type=${f.type}`]),
    `--state=${f.column}`,
    `--assign=${f.assignee}`,
    // a board on this machine has no sprints
    ...(l.on.onThisMachine === true ? [] : [`--sprint=${f.sprint}`]),
    ...(f.description.trim() === '' ? [] : [`--description=${f.description.trim()}`]),
    ...(f.criteria.trim() === '' ? [] : [`--criteria=${f.criteria.trim()}`]),
  ];
};

const create = (l: NewCardLayer, n: number): NewCardStep => {
  if (busy(l) !== undefined || noTitle(l) !== undefined) return stay(l);

  return stay({ ...l, phase: 'creating', error: undefined }, [
    { kind: 'shell', effect: { kind: 'status', text: `Creating “${l.form.title.trim()}”…` } },
    { kind: 'run', id: `${CREATE_RUN}${n}:${l.on.board}`, argv: createArgv(l) },
  ]);
};

// ---------------------------------------------------------------- keys

/**
 * A key or a click while the dialog is up. `n` numbers the run it may start. Esc closes it, the
 * form kept for the board; Tab ⇧Tab move between the fields; on a text field every letter types
 * (⇧⏎ a new line in Description and criteria), ⏎ creates; on a ▾ field ⏎ opens its pick, a
 * word typed goes to Description; ⌘⏎ drafts with the agent.
 */
/** Esc: closed, the form kept; while it is being created it stays up for the answer (never made twice). */
const closing = (l: NewCardLayer): NewCardStep =>
  l.phase === 'creating' ? stay(l) : { layer: undefined, commands: [], keep: l.form };

export const onNewCard = (
  l: NewCardLayer,
  input: Input,
  n: number,
  guard: { at: number | undefined; ms: number } = { at: undefined, ms: 0 },
): NewCardStep => {
  if (input.kind === 'click') {
    switch (input.id) {
      case 'dialog:close':
        return closing(l);
      case 'dialog:primary':
        return create(l, n);
      case 'dialog:menu':
        return draft(l, n);
      default:
        return stay(l);
    }
  }
  const field = fieldAt(l);
  const typed = (f: Field | undefined): NewCardStep =>
    f === undefined || !isText(l.focus)
      ? stay(l)
      : stay({
          ...l,
          form: { ...l.form, [l.focus]: f.text },
          caret: f.caret >= Array.from(f.text).length ? undefined : f.caret,
        });

  if (input.kind === 'text') {
    // the title is one line: a paste's lines joined
    const text = l.focus === 'title' ? input.text.replace(/\s*\n\s*/g, ' ') : input.text;

    return field === undefined ? stay(l) : typed(fieldInsert(field, text));
  }
  if (input.kind !== 'key') return stay(l);
  switch (input.key) {
    case '<Esc>':
      return closing(l);
    case '<Tab>':
    case '<Down>':
      return stay(focused(l, 1));
    case '<S-Tab>':
    case '<Up>':
      return stay(focused(l, -1));
    case '<D-CR>':
      return draft(l, n);
    case '<S-CR>':
      return l.focus === 'description' || l.focus === 'criteria'
        ? typed(field === undefined ? undefined : fieldInsert(field, '\n'))
        : stay(l);
    case '<Space>':
      // on a pick: words typed are the Description's
      if (!isText(l.focus)) return onNewCard(toDescription(l), input, n, guard);

      return typed(field === undefined ? undefined : fieldInsert(field, ' '));
    case '<CR>':
      if (!isText(l.focus)) return { layer: l, commands: [], pick: pickOf(l, l.focus) };
      {
        const at = guard.at;
        const early = (since: number | undefined) =>
          at !== undefined && since !== undefined && at - since < guard.ms;

        // too soon after it opened or the ⏎ before: nothing, and the wait starts again
        if (early(l.opened) || early(l.enter)) return stay({ ...l, enter: at });
      }

      return create(l, n);
    default:
      // a letter on a pick goes to Description, never lost (⏎ opens the pick)
      if (!isText(l.focus) && Array.from(input.key).length === 1)
        return onNewCard(toDescription(l), input, n, guard);

      return field === undefined
        ? stay(l)
        : typed(fieldKey(field, input.key, { lines: l.focus !== 'title' }));
  }
};

/** The keys on Description, at its end. */
const toDescription = (l: NewCardLayer): NewCardLayer => ({
  ...l,
  focus: 'description',
  caret: undefined,
});

/** Whether a run's answer is the dialog's. */
export const isNewCardRun = (id: string): boolean =>
  id.startsWith(DRAFT_RUN) || id.startsWith(CREATE_RUN);

const why = (r: { error: { message: string; code: string } }) =>
  `${r.error.message} (${r.error.code})`;

/**
 * A draft or create answered (`l`: the dialog, when still up; else the form kept for the board).
 * A draft fills Why, What and criteria (the title too while there is none); a card made closes
 * it, says so and tells the Board; a refusal keeps the form and says why.
 */
export const onNewCardResult = (
  l: NewCardLayer | undefined,
  kept: NewCardForm | undefined,
  input: Answer | Refused,
): NewCardStep => {
  const created = input.id.startsWith(CREATE_RUN);
  const form = l?.form ?? kept;

  if (!input.reply.ok) {
    const error = why(input.reply);

    if (l !== undefined)
      return { layer: { ...l, phase: 'ready', error }, commands: [], keep: l.form };

    return {
      layer: undefined,
      commands: [{ kind: 'shell', effect: { kind: 'balloon', tone: 'error', text: error } }],
    };
  }
  if (input.command === 'card draft') {
    const d = input.reply.data;

    if (form === undefined) return { layer: l, commands: [] };
    const written = draftFields(d);
    const next: NewCardForm = {
      ...form,
      title: form.title.trim() === '' ? d.title : form.title,
      description: written.description,
      criteria: written.acceptanceCriteria,
      drafted: d,
    };

    return l === undefined
      ? { layer: undefined, commands: [], keep: next }
      : {
          layer: { ...l, form: next, phase: 'ready', error: undefined, caret: undefined },
          commands: [],
          keep: next,
        };
  }
  if (created && input.command === 'card create') {
    const c = input.reply.data;

    return {
      layer: undefined,
      keep: null,
      commands: [
        { kind: 'shell', effect: { kind: 'status', text: `Made #${cardName(c.id)} ${c.title}` } },
        {
          kind: 'choice',
          menu: NEW_CARD_MENU,
          row: `made:${c.id}:${c.assignee === null ? 'none' : 'me'}`,
        },
      ],
    };
  }

  return { layer: l, commands: [] };
};

// ---------------------------------------------------------------- the dialog drawn

const valueText = (l: NewCardLayer, f: PickField): string =>
  pickValues(l, f).find((v) => v.value === l.form[f])?.text ?? l.form[f];

const fieldsLine = (l: NewCardLayer): string =>
  picksOf(l)
    .map((f) => {
      const v = `${pickLabel(f)} ${valueText(l, f)} ▾`;

      return l.focus === f ? `**▸ ${v}**` : v;
    })
    .join(' · ');

const shownText = (l: NewCardLayer, f: TextField): string =>
  l.focus === f ? withCaret(fieldOf(l.form[f], l.caret)) : l.form[f];

/** The dialog as Command mode draws it, and its page's lines (an estimate for its scroll). */
export const newCardDialog = (l: NewCardLayer): { dialog: CardDialog; lines: number } => {
  const grey = busy(l) ?? noTitle(l);
  const sections = [
    {
      title: picksOf(l).map(pickLabel).join(' · '),
      ...(isText(l.focus) ? {} : { note: '⏎ pick' }),
      markdown: fieldsLine(l),
    },
    {
      title: l.focus === 'description' ? '▸ Description' : 'Description',
      note: l.focus === 'description' ? 'Why and What · ⇧⏎ new line' : 'Why and What',
      markdown: shownText(l, 'description'),
    },
    {
      title: l.focus === 'criteria' ? '▸ Acceptance criteria' : 'Acceptance criteria',
      ...(l.focus === 'criteria' ? { note: '⇧⏎ new line' } : {}),
      markdown: shownText(l, 'criteria'),
    },
  ];
  const title = l.focus === 'title' ? shownText(l, 'title') : l.form.title;
  const lines = sections.reduce((n, s) => n + s.markdown.split('\n').length + 2, 0);

  return {
    dialog: {
      kind: 'CardDialog',
      id: NEW_CARD_DIALOG,
      props: {
        kicker: 'New card',
        card: 0,
        state:
          l.phase === 'drafting'
            ? 'drafting…'
            : `${l.on.onThisMachine === true ? 'On this machine' : 'Azure'} · draft`,
        title: title === '' ? 'Title' : title,
        meta: [],
        sections,
        scroll: 0,
        buttons: [
          {
            id: 'dialog:menu',
            label: 'Draft with the agent',
            keys: '⌘⏎',
            ...(grey === undefined ? {} : { reason: grey }),
          },
          {
            id: 'dialog:primary',
            label: 'Create',
            keys: '⏎',
            primary: true,
            ...(grey === undefined ? {} : { reason: grey }),
          },
        ],
        ...(l.error === undefined ? {} : { error: l.error }),
      },
    },
    lines,
  };
};
