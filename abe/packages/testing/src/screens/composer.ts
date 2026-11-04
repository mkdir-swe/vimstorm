/**
 * Chat's composer for the contract. There is one tree per composer state of boards R-Anatomy
 * (empty, `/` typed, the menu shut with Esc, with text), R-Composer (the `/` menu open),
 * C-Context (a selection's chip) and R-Working (a queued message). Then come the chip dropped,
 * the model pick, an ended session and a gallery with every prop. Each is the `@abe/ui` composer
 * model's own output, at the bottom of the Chat column where Chat docks it. The shell's cargo
 * tests (`app/tests/factory_composer.rs`) draw them.
 */
import {
  type ChatStatus,
  composerAttach,
  composerCaret,
  composerDock,
  composerDraft,
  composerEvent,
  type ComposerFacts,
  composerKey,
  composerResult,
  composerSession,
  type ComposerState,
  composerText,
  NO_COMPOSER,
  type Node,
} from '@abe/ui';
import { session } from './ui';

const SESSION = 'demo-shop-2-1';
const FACTS: ComposerFacts = { session: SESSION, focused: true };
const CARET = { file: 'api/src/cart.ts', line: 16 };

const START = composerSession(composerCaret(NO_COMPOSER, CARET), {
  ...session(SESSION, 'working', 2),
  model: 'opus',
  effort: 'medium',
});

const keyed = (c: ComposerState, keys: string): ComposerState =>
  keys.split(' ').reduce((x, key) => composerKey(x, key, FACTS).composer, c);

const typed = (c: ComposerState, words: string): ComposerState =>
  keyed(
    c,
    Array.from(words)
      .map((ch) => (ch === ' ' ? '<Space>' : ch))
      .join(' '),
  );

const PROSE: Node = {
  kind: 'Prose',
  id: 'composer:prose',
  props: {
    markdown:
      "`cartTotal` added each line's price once, so a line with 3 of one item was charged as 1.",
  },
};

/** The column: the turn's last words at the top, the dock at the bottom. */
const column = (id: string, dock: Node | null): Node => ({
  kind: 'Island',
  id: `col:${id}`,
  props: {},
  children: [
    {
      kind: 'Stack',
      props: { direction: 'column', sizes: [{ flex: 1 }, 'auto'] },
      children: [
        {
          kind: 'Stack',
          props: { direction: 'column', pad: [12, 12, 8, 12] },
          children: [PROSE],
        },
        dock ?? { kind: 'Stack', props: { direction: 'column' }, children: [] },
      ],
    },
  ],
});

const docked = (c: ComposerState, f: ComposerFacts = FACTS): Node | null => composerDock(c, f);

const ALLOWED = composerResult(keyed(START, '/ m <CR>'), {
  kind: 'result',
  id: 'composer:models',
  command: 'settings get',
  reply: {
    ok: true,
    data: {
      key: 'allowedModels',
      value: ['opus', 'sonnet', 'haiku'],
      layer: 'core',
      lowered: null,
      problems: [],
    },
  },
}).composer;

const QUEUED = composerEvent(START, {
  seq: 1,
  at: '2026-10-25T03:00:00.000Z',
  type: 'session.queued',
  data: { session: SESSION, queue: [{ n: 1, text: 'also handle a zero quantity' }] },
});

const LONG = [
  'Keep the changes, then open the pull request',
  "with the story's acceptance criteria in its description.",
  'Mention the skipped rounding test,',
  'and that the market table is unchanged.',
  'Ask Ada to review it.',
  'Then move the card to Review.',
  'Then post the PR link on the story.',
  'Then wait for the checks.',
  'Then say when they pass.',
  'Then stop.',
].join('\n');

/** The status line as `rendered.ts` draws it while two subagents run, its list unfolded. */
const STATUS: ChatStatus = {
  kind: 'ChatStatus',
  id: 'chat:status',
  props: {
    tone: 'working',
    words: 'Waiting on 2 subagents',
    since: Date.parse('2026-10-25T02:58:30.000Z'),
    agents: { text: '2 subagents', id: 'chat:agents', running: 2, open: true },
    list: [
      {
        id: 'chat:agent:a2',
        name: 'abe:writer',
        task: 'Multiply by quantity',
        state: 'running',
        since: Date.parse('2026-10-25T02:59:10.000Z'),
        last: 'Bash bun test api/test/cart.test.ts',
      },
      {
        id: 'chat:agent:a1',
        name: 'abe:reader',
        task: 'Find every caller of cartTotal',
        state: 'running',
        since: Date.parse('2026-10-25T02:58:40.000Z'),
        last: 'Grep cartTotal',
      },
      {
        id: 'chat:agent:a0',
        name: 'Explore',
        task: 'Read the story',
        state: 'done',
        since: Date.parse('2026-10-25T02:58:31.000Z'),
        until: Date.parse('2026-10-25T02:58:52.000Z'),
        last: 'The story asks for line totals of price × quantity.',
      },
    ],
    selected: 0,
  },
};

const WORKING = composerAttach(
  composerDraft(
    START,
    'Look at these two:\nthe cart page and the total\nwhy do they differ?',
    1,
    FACTS,
  ).composer,
  ['/tmp/vimstorm-paste/pasted-1761620000000.png', '/wt/shop/api/src/cart.ts'],
  FACTS,
).composer;

/** One tree per composer state, by its contract name (`composer-<state>.json`). */
export const COMPOSER_TREES: Readonly<Record<string, Node>> = {
  // R-Anatomy · Composer · empty: the caret line chip, the placeholder, the model line
  'composer-empty': column('empty', docked(START, { ...FACTS, focused: false })),
  // R-Composer: `/` typed, the menu over the field, /override selected
  'composer-slash': column('slash', docked(keyed(START, '/'))),
  // R-Anatomy · Composer · / typed, menu closed with Esc
  'composer-slash-shut': column('slash-shut', docked(keyed(START, '/ <Esc>'))),
  // R-Anatomy · Composer · with text (wraps to a second row)
  'composer-text': column(
    'text',
    docked(
      typed(
        START,
        "Keep the changes, then open the pull request with the story's acceptance criteria in its description",
      ),
    ),
  ),
  // C-Context: a selection's chip
  'composer-selection': column(
    'selection',
    docked(
      typed(
        composerCaret(START, {
          file: 'api/src/cart.ts',
          line: 21,
          selection: { from: 14, to: 21 },
        }),
        'why not multiply here?',
      ),
    ),
  ),
  // ⌫ in the empty field drops the chip for this message
  'composer-dropped': column('dropped', docked(keyed(START, 'a <BS> <BS>'))),
  // R-Working: a message queued while the agent works, × takes it back
  'composer-queued': column('queued', docked(QUEUED)),
  // The model pick, with the current one selected
  'composer-pick': column('pick', docked(ALLOWED)),
  // ⇧⏎ adds lines. Past 8 rows the field shows its last ones
  'composer-long': column('long', docked(composerText(START, LONG, FACTS).composer)),
  // An ended session
  'composer-ended': column('ended', docked(START, { ...FACTS, ended: true })),
  // At work: the status line over the field, its subagents unfolded; a pasted image and a
  // dropped file as chips; three lines typed in the app's own field
  'composer-working': column('working', composerDock(WORKING, FACTS, STATUS)),
};

/** Every prop the composer's draw arms read, once. */
export const COMPOSER_GALLERY: Node = column('gallery', {
  kind: 'Stack',
  props: { direction: 'column', gap: 4, pad: [4, 12, 12, 12] },
  children: [
    {
      kind: 'Composer',
      id: 'gallery:composer',
      props: {
        text: '',
        placeholder: 'Ask or tell the agent…',
        model: { label: 'opus', note: 'high · next resume', id: 'gallery:model' },
      },
      children: [
        {
          kind: 'ContextChip',
          id: 'gallery:chip',
          props: { text: '#2 The cart total ignores quantity · selected card', drop: '⌫ drop' },
        },
        {
          kind: 'SlashMenu',
          id: 'gallery:menu',
          props: {
            items: [
              { id: 'gallery:menu:0', cmd: '/compact', desc: 'shorten the conversation' },
              {
                id: 'gallery:menu:1',
                cmd: '/improve',
                desc: 'change VimStorm for you',
                reason: 'Improve mode comes with #117',
              },
            ],
            selected: 1,
          },
        },
      ],
    },
  ],
});
