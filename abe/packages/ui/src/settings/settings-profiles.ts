/**
 * Settings › Browser profiles (#103 S4; #345 split of `settings.ts`): the profiles' table, add /
 * rename / remove / default, a profile proposed for the repo, and Open: the profile's Chrome on
 * its own folder in front (the one open brought to the front), stored on its own when it closes.
 */
import { type SettingsDialogRules } from '@abe/core';

import { type Node, type Table, type TableCell, type TableRow } from '../runtime/components';
import { type Answer, type Refused } from '../runtime/runtime';
import { type Line, pageLines } from './settings-rows';

import {
  type Adding,
  type Out,
  PROFILES_KEY,
  PROFILES_PAGE,
  type ProfileLine,
  type SettingsState,
  addMode,
  addingOf,
  downOf,
  edited,
  proposeMode,
  refusal,
  removingOf,
  same,
  status,
} from './settings-state';
import { empty, page, settingNode } from './settings-view';

export const readProfiles = (s: SettingsState): Out => {
  const runs = s.runs + 1;

  return {
    state: { ...s, runs, profiles: { ...s.profiles } },
    commands: [{ kind: 'run', id: `settings:profiles:${runs}`, argv: ['browser', 'list'] }],
  };
};

/** A browser write (`add`, `remove`, `default`): its answer carries the list after it. */
const profileWrite = (s: SettingsState, argv: string[]): Out => {
  const runs = s.runs + 1;

  return {
    state: { ...s, runs },
    commands: [{ kind: 'run', id: `settings:profiles:${runs}`, argv: ['browser', ...argv] }],
  };
};

export const yours = (p: ProfileLine) => p.layer === 'individual';

const whose = (s: SettingsState, p: ProfileLine) => {
  switch (p.layer) {
    case 'built-in':
      return 'built-in';
    case 'individual':
      return 'yours';
    case 'repo':
      return `repo ${s.list?.scope.repo ?? '?'}`;
    default:
      return p.layer;
  }
};

/**
 * A profile's sign-ins as the table says them: its Chrome open now, when they were stored for
 * your boxes (its Chrome folder keeps them here either way), a store on its own that failed.
 */
const signInsOf = (p: ProfileLine): { text: string; hue: 'dim' | 'warn' | 'accent' } => {
  if (p.layer === 'built-in') return { text: 'none · a fresh profile every start', hue: 'dim' };
  const stored =
    p.storedAt === null ? 'not stored' : `stored ${p.storedAgo ?? p.storedAt.slice(0, 10)}`;
  const failed = p.storeFailed === null ? '' : ` · last store failed: ${p.storeFailed}`;

  if (p.open === true) return { text: `open now · ${stored}${failed}`, hue: 'accent' };

  return {
    text: `${stored}${failed}`,
    hue: p.storedAt === null || p.storeFailed !== null ? 'warn' : 'dim',
  };
};

/**
 * Open (⏎, or its button): the profile's Chrome in front on its own folder, the one open on it
 * brought to the front; it is stored on its own when it closes.
 */
export const openProfile = (s: SettingsState, p: ProfileLine): Out =>
  p.layer === 'built-in'
    ? {
        state: s,
        commands: [status('default is the built-in empty profile: nothing to sign in to')],
      }
    : profileWrite(s, ['open', p.name, '--front']);

/** A key on a profile line: Space default, r rename and ⌫ remove (yours), ⌘⏎ propose for the repo. */
export const profileKey = (
  r: SettingsDialogRules,
  s: SettingsState,
  p: ProfileLine,
  key: string,
): Out | undefined => {
  if (key === 'r') {
    if (!yours(p))
      return {
        state: s,
        commands: [status(`${p.name} is ${whose(s, p)}'s: only yours are renamed here`)],
      };

    return same({ ...s, mode: addMode({ name: null, text: p.name, from: p.name }) });
  }
  if (key === '<Space>')
    return p.default
      ? same(s)
      : profileWrite(s, ['default', p.layer === 'built-in' ? 'none' : p.name]);
  if (key === '<BS>' || key === '<Del>') {
    if (!yours(p))
      return {
        state: s,
        commands: [
          status(`${p.name} is ${whose(s, p)}'s: ⌘⏎ on a value of yours proposes a change`),
        ],
      };

    return same({ ...s, mode: { kind: 'remove', name: p.name } });
  }
  if (key === '<D-CR>') return proposeProfile(r, s, p);

  return undefined;
};

/** `Remove po-review? y / n`. */
export const removeKey = (s: SettingsState, name: string, key: string): Out => {
  if (key === 'y' || key === 'Y') return profileWrite({ ...s, mode: undefined }, ['remove', name]);
  if (key === 'n' || key === 'N' || key === '<Esc>') return same({ ...s, mode: undefined });

  return same(s);
};

/**
 * Add profile…: the name, ⏎, the purpose, ⏎ adds it to your Layer; a rename: the new name, ⏎.
 * Esc leaves it.
 */
export const addKey = (s: SettingsState, a: Adding, key: string): Out => {
  if (key === '<Esc>') return same({ ...s, mode: undefined });
  if (key !== '<CR>')
    return same({ ...s, mode: addMode({ ...a, text: edited(a.text, key), error: undefined }) });
  const text = a.text.trim();

  if (a.name === null) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(text) || text === 'default')
      return same({
        ...s,
        mode: addMode({ ...a, error: 'a profile is a name of a-z, 0-9 and -' }),
      });
    if (a.from !== undefined)
      return text === a.from
        ? same({ ...s, mode: undefined })
        : profileWrite({ ...s, mode: undefined }, ['rename', a.from, text]);

    return same({ ...s, mode: addMode({ name: text, text: '' }) });
  }
  if (text === '') return same({ ...s, mode: addMode({ ...a, error: 'a purpose, one line' }) });

  return profileWrite({ ...s, mode: undefined }, ['add', a.name, `--purpose=${text}`]);
};

/** `browser list` or a write answered: the list kept (a write's `list`), or why not. */
export const profilesAnswered = (s: SettingsState, input: Answer | Refused): Out => {
  if (!input.reply.ok) {
    const why = refusal(input.reply.error);

    return input.command === 'browser list'
      ? same({ ...s, profiles: { ...s.profiles, down: downOf(input.reply.error) } })
      : { state: s, commands: [status(why)] };
  }
  if (input.command === 'browser list')
    return same({ ...s, profiles: { data: input.reply.data, down: undefined } });
  if (
    input.command === 'browser add' ||
    input.command === 'browser rename' ||
    input.command === 'browser remove' ||
    input.command === 'browser default'
  )
    return {
      state: { ...s, profiles: { data: input.reply.data.list, down: undefined } },
      commands: [status(input.reply.data.done)],
    };
  if (input.command === 'browser open') {
    const d = input.reply.data;
    const again = readProfiles(s);

    return {
      state: again.state,
      commands: [
        status(
          `${d.name}'s Chrome is ${d.started ? 'open' : 'in front'}: sign in there; its sign-ins are kept in its folder and stored when it closes`,
        ),
        ...again.commands,
      ],
    };
  }

  return same(s);
};

/** A profile's Chrome opened, closed or stored on its own: the table read again while shown. */
export const profilesChanged = (s: SettingsState): Out =>
  s.profiles?.data === undefined ? same(s) : readProfiles(s);

/** ⌘⏎ on a profile of yours: the repo's list with it added, proposed as one pull request. */
const proposeProfile = (r: SettingsDialogRules, s: SettingsState, p: ProfileLine): Out => {
  if (!yours(p)) return { state: s, commands: [status(`${p.name} is ${whose(s, p)}'s already`)] };
  const listed = s.list?.rows.find((l) => l.key === PROFILES_KEY);

  if (listed === undefined || s.list === undefined)
    return { state: s, commands: [status('Settings are not read yet')] };
  const offer = r.offer(listed, s.list.scope);

  if (!offer.ok) return { state: s, commands: [status(`Browser profiles: ${offer.message}`)] };
  const repo = (s.profiles?.data?.profiles ?? []).filter((x) => x.layer === 'repo');
  const value = [...repo, p].map((x) => ({ name: x.name, purpose: x.purpose }));
  const names = (xs: readonly { name: string }[]) =>
    xs.length === 0 ? 'none' : xs.map((x) => x.name).join(', ');

  return same({
    ...s,
    mode: proposeMode({
      row: PROFILES_KEY,
      key: PROFILES_KEY,
      field: null,
      label: 'Browser profiles',
      from: names(repo),
      words: null,
      value: { kind: 'fixed', text: names(value), typed: JSON.stringify(value) },
      reason: '',
      focus: 'reason',
    }),
  });
};

/** What is typed in place: `Name: qa▏`, `qa · Purpose: …`, `Rename: po-review▏`, its error after. */
const typing = (a: Adding): TableCell => {
  const what = a.name === null ? 'Name' : `${a.name} · Purpose`;

  return {
    text: `${a.from === undefined ? what : 'Rename'}: ${a.text}▏${
      a.error === undefined ? '' : `  ${a.error}`
    }`,
    hue: a.error === undefined ? 'accent' : 'bad',
  };
};

/** A profile's Open button: its Chrome started, or the open one brought to the front. */
const openCell = (p: ProfileLine, at: number): TableCell =>
  p.layer === 'built-in'
    ? {}
    : {
        id: `settings:open:${at}`,
        text: 'Open',
        hue: 'accent',
        tooltip:
          p.open === true
            ? `Bring ${p.name}'s Chrome to the front`
            : `${p.name}'s Chrome on its own folder, to sign in`,
      };

/**
 * Browser profiles' table: Name · Purpose · Sign-ins · Default · Open, then Add profile…; a
 * rename typed in its own row, the whole row given to it.
 */
const profilesTable = (s: SettingsState, ls: readonly { line: Line; at: number }[]): Table => {
  const a = addingOf(s);
  const rows: TableRow[] = ls.map(({ line, at }) => {
    if (line.kind !== 'profile')
      return {
        id: `settings:line:${at}`,
        cells: [
          a === undefined || a.from !== undefined
            ? { text: 'Add profile…', hue: 'accent' }
            : typing(a),
        ],
      };
    const p = line.profile;

    if (a?.from === p.name) return { id: `settings:line:${at}`, cells: [typing(a)] };

    return {
      id: `settings:line:${at}`,
      cells: [
        { text: p.name },
        { text: p.purpose, hue: 'dim' },
        signInsOf(p),
        p.default ? { mark: '●', hue: 'accent', tooltip: 'the default' } : {},
        openCell(p, at),
      ],
    };
  });
  const focused = ls.find(({ at }) => s.focus === 'page' && s.row === at);

  return {
    kind: 'Table',
    id: 'settings:profiles',
    props: {
      columns: [
        { label: 'Name', width: { fixed: 120 } },
        { label: 'Purpose', width: { fixed: 150 } },
        { label: 'Sign-ins', width: { flex: 1 } },
        { label: 'Default', width: { fixed: 60 }, align: 'end' },
        { label: '', width: { fixed: 44 }, align: 'end' },
      ],
      rows,
      ...(focused === undefined ? {} : { selected: `settings:line:${focused.at}` }),
      foot:
        focused?.line.kind === 'add-profile'
          ? [{ keys: '⏎', label: 'add a profile of yours' }]
          : [
              { keys: '⏎', label: 'open' },
              { keys: 'r', label: 'rename' },
              { keys: 'Space', label: 'set default' },
              { keys: '⌫', label: 'remove' },
              { keys: '⌘⏎', label: 'propose for the repo' },
            ],
    },
  };
};

/** Browser profiles' page: the table in the Profiles row's place, then the default's row. */
export const profilesPage = (
  r: SettingsDialogRules,
  s: SettingsState,
  crumbs: string[],
  scope: string,
): Node => {
  const ls = pageLines(r, s, PROFILES_PAGE).map((line, at) => ({ line, at }));
  const table = ls.filter(({ line }) => line.kind === 'profile' || line.kind === 'add-profile');
  const settings = ls.flatMap(({ line, at }) =>
    line.kind === 'setting' ? [settingNode(r, s, line, at)] : [],
  );
  const down = s.profiles?.down;
  const top: Node[] =
    table.length > 0
      ? [profilesTable(s, table)]
      : [
          empty(
            down === undefined
              ? 'Reading browser profiles…'
              : `${down} · profiles read when it is back`,
          ),
        ];
  const removing = removingOf(s);
  const ask: Node[] =
    removing === undefined
      ? []
      : [{ kind: 'SettingsNote', props: { text: `Remove ${removing} from your Layer?  y / n` } }];

  return page(
    crumbs,
    scope,
    [
      {
        kind: 'SettingsGroup',
        id: 'settings:group:0',
        props: { caption: 'Browser profiles', note: "the repo's shared ones, then yours" },
        children: [...top, ...ask],
      },
      {
        kind: 'SettingsGroup',
        id: 'settings:group:1',
        props: { note: 'A verify step names its profile; Before and After use the same one' },
        children: settings,
      },
    ],
    s.row,
  );
};
