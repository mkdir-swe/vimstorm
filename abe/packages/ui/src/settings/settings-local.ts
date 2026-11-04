/**
 * Settings › Abe › Local mode (#24, spec #19; board LM-Setting): this checkout's checkbox, read
 * with `abe local status` when the page shows and flipped at once with `abe local on|off` (your
 * Layer alone, at once: as the CLI does it), then what local mode means as fixed lines, then
 * `localMode`'s home row, every checkout your Layer lists.
 */
import { type SettingRow as CatalogueRow, type SettingsDialogRules } from '@abe/core';
import { type Node } from '../runtime/components';
import { type Answer, type Refused } from '../runtime/runtime';
import { type SettingRow, type SettingsGroup } from './settings-components';
import { type Line, pageLines } from './settings-rows';
import {
  LOCAL_PAGE,
  type Out,
  type SettingsState,
  downOf,
  refusal,
  same,
  status,
} from './settings-state';
import { captionOf, page, settingNode } from './settings-view';

export const readLocal = (s: SettingsState): Out => {
  const runs = s.runs + 1;

  return {
    state: { ...s, runs, local: { ...s.local, down: undefined } },
    commands: [{ kind: 'run', id: `settings:local:${runs}`, argv: ['local', 'status'] }],
  };
};

/** The folder's name of a checkout (`/home/me/demo-shop` → `demo-shop`). */
const nameOf = (checkout: string) =>
  checkout
    .split('/')
    .filter((p) => p !== '')
    .at(-1) ?? checkout;

/** ⏎ or Space on the checkbox: this checkout on or off at once, or why not. */
export const localPressed = (s: SettingsState): Out => {
  const l = s.local;

  if (l?.running === true) return { state: s, commands: [status('Local mode: already writing')] };
  if (l?.data === undefined)
    return { state: s, commands: [status(`Local mode: ${l?.down ?? 'reading…'}`)] };
  if (l.data.checkout === null)
    return { state: s, commands: [status('Local mode is per checkout: open one')] };
  const runs = s.runs + 1;

  return {
    state: { ...s, runs, local: { ...l, running: true } },
    commands: [
      { kind: 'run', id: `settings:local:${runs}`, argv: ['local', l.data.on ? 'off' : 'on'] },
    ],
  };
};

/** `local status`, `local on` or `local off` answered. */
export const localAnswered = (s: SettingsState, input: Answer | Refused): Out => {
  if (!input.reply.ok)
    return input.command === 'local status'
      ? same({ ...s, local: { down: downOf(input.reply.error) } })
      : {
          state: { ...s, local: { ...s.local, running: false } },
          commands: [status(`Local mode: ${refusal(input.reply.error)}`)],
        };
  if (input.command === 'local status') {
    const { checkout, on } = input.reply.data;

    return same({ ...s, local: { data: { checkout, on } } });
  }
  if (input.command === 'local on' || input.command === 'local off') {
    const { checkout, on } = input.reply.data;

    return {
      state: { ...s, local: { data: { checkout, on } } },
      commands: [
        status(
          on
            ? `Local mode on · ${nameOf(checkout)}: every write held on this machine`
            : `Local mode off · ${nameOf(checkout)}: writes go out from the next one`,
        ),
      ],
    };
  }

  return same(s);
};

/** The checkbox's row: its value once read, what keeps it unread, a write under way. */
const hereNode = (s: SettingsState, row: CatalogueRow, at: number): SettingRow => {
  const l = s.local;
  const focused = s.focus === 'page' && s.row === at;
  const source = (): SettingRow['props']['source'] => {
    if (l?.running === true) return { text: 'writing…' };
    if (l?.down !== undefined) return { text: `${l.down} · not read`, tone: 'warn' };
    if (l?.data === undefined) return { text: 'reading…' };
    if (l.data.checkout === null) return { text: 'not in a checkout: local mode is per checkout' };

    return { text: '' };
  };

  return {
    kind: 'SettingRow',
    id: `settings:line:${at}`,
    props: {
      label: row.label,
      control: { kind: 'checkbox', on: l?.data?.on === true },
      help: row.help,
      source: source(),
      ...(focused ? { focused, hint: '⏎ for this checkout · yours alone' } : {}),
    },
  };
};

/**
 * A setting's row as anywhere; a line of what local mode means (LM-Setting): its label, its
 * words dim under it, no value or source beside.
 */
const settingLineNode = (
  r: SettingsDialogRules,
  s: SettingsState,
  line: Extract<Line, { kind: 'setting' }>,
  at: number,
): SettingRow => {
  const n = settingNode(r, s, line, at);
  const words = line.row.fixed?.value;

  return words === undefined
    ? n
    : {
        ...n,
        props: {
          ...n.props,
          control: { kind: 'value', text: '' },
          help: words,
          source: { text: '' },
        },
      };
};

/** Local mode's page: `Local mode · demo-shop · yours`, the checkbox, the lines, the checkouts. */
export const localPage = (
  r: SettingsDialogRules,
  s: SettingsState,
  crumbs: string[],
  scope: string,
): Node => {
  const groups: { caption: string | null; rows: SettingRow[] }[] = [];

  pageLines(r, s, LOCAL_PAGE).forEach((line, at) => {
    if (line.kind !== 'local' && line.kind !== 'setting') return;
    const node =
      line.kind === 'local' ? hereNode(s, line.row, at) : settingLineNode(r, s, line, at);
    const caption = line.row.group;
    const last = groups.at(-1);

    if (last?.caption === caption) last.rows.push(node);
    else groups.push({ caption, rows: [node] });
  });
  const checkout = s.local?.data?.checkout ?? null;

  return page(
    crumbs,
    checkout === null ? scope : `${nameOf(checkout)} · yours`,
    groups.map((g, i): SettingsGroup => ({
      kind: 'SettingsGroup',
      id: `settings:group:${i}`,
      props: captionOf(g.caption, g.rows),
      children: g.rows,
    })),
    s.row,
  );
};
