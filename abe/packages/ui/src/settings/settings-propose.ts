/**
 * Settings' ⌘⏎ (S-Propose; #345 split of `settings.ts`): a value and its reason for the repo, one
 * pull request on its `abe.yaml`.
 */
import { type SettingsDialogRules } from '@abe/core';
import { PAGE_ROWS, filterMove, movedRow } from '../runtime/list-moves';
import { type Answer, type Refused } from '../runtime/runtime';
import { type ProposeFocus, type SettingsPropose } from './settings-components';

import {
  type Line,
  aboveOf,
  choiceWords,
  choicesOf,
  greyedOf,
  read,
  shownOf,
  typedOf,
  valueOf,
  valueShown,
} from './settings-rows';
import { cliTyped } from './settings-change';
import {
  DOWN,
  LEFT,
  type Out,
  type Proposing,
  RIGHT,
  type SettingsState,
  UP,
  proposeMode,
  same,
  status,
  edited,
  refusal,
} from './settings-state';

import { cliArgv } from './settings-writes';

const PROPOSE_SURE = 'A proposal needs its reason: the pull request opens with it';

/** ⌘⏎ on a setting: the popup on the value it would propose, where `abe settings propose` takes it. */
export const propose = (r: SettingsDialogRules, s: SettingsState, line: Line | undefined): Out => {
  if (line?.kind !== 'setting') return same(s);
  const { row, listed } = line;

  if (row.personalOnly)
    return { state: s, commands: [status(`${row.label}: yours alone, not for the repo`)] };
  if (listed === undefined || s.list === undefined)
    return { state: s, commands: [status('Settings are not read yet')] };
  const offer = r.offer(listed, s.list.scope);

  if (!offer.ok) return { state: s, commands: [status(`${row.label}: ${offer.message}`)] };
  if (row.key === null) return same(s);
  const changed = s.changes[row.id];
  const now = valueOf(s, row, listed);
  const value = ((): Proposing['value'] | undefined => {
    switch (row.control) {
      case 'checkbox':
        // a checkbox proposes the other value unless a change of yours is being saved
        return { kind: 'toggle', on: changed === undefined ? now !== true : now === true };
      case 'combo':
      case 'segmented': {
        // greyed ones (outside the repo's allowedModels) are never proposed
        const choices = choicesOf(row, listed).filter((c) => greyedOf(listed, c) === undefined);

        if (choices.length === 0)
          return { kind: 'field', text: typedOf(r, s, row, listed), chips: false };

        return {
          kind: 'pick',
          choices,
          at: Math.max(0, choices.indexOf(shownOf(r, s, row, listed))),
        };
      }
      case 'text':
      case 'number':
      case 'path':
      case 'secret':
        return { kind: 'field', text: typedOf(r, s, row, listed), chips: false };
      case 'chips':
        return { kind: 'field', text: typedOf(r, s, row, listed), chips: true };
      case 'table':
      case 'records':
      case 'advanced':
      case 'preview':
      case 'link':
        return undefined;
    }
  })();

  if (value === undefined)
    return {
      state: s,
      commands: [status(`${row.label} is proposed from its own page, not here yet`)],
    };
  const proposing: Proposing = {
    row: row.id,
    key: row.key,
    field: row.field,
    label: row.label,
    // what the Layers above yours give: the value the proposal changes (#300: never yours)
    from: valueShown(r, row, aboveOf(listed)),
    words: row.words,
    value,
    reason: '',
    // a value already other than the one in force: its reason is what is left to write
    focus: changed !== undefined || value.kind === 'toggle' ? 'reason' : 'value',
  };

  return same({ ...s, mode: proposeMode(proposing) });
};

/** The popup's value as `abe settings propose` takes it. */
const proposedTyped = (p: Proposing): string => {
  const v = p.value;

  switch (v.kind) {
    case 'pick':
      return v.choices[v.at] ?? '';
    case 'toggle':
      return v.on ? 'true' : 'false';
    case 'fixed':
      return v.typed;
    case 'field':
      return v.chips
        ? `[${v.text
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t !== '')
            .join(', ')}]`
        : v.text;
  }
};

const proposedShown = (p: Proposing): string => {
  const v = p.value;

  switch (v.kind) {
    case 'pick':
      return choiceWords({ words: p.words }, v.choices[v.at] ?? '');
    case 'toggle':
      return v.on ? 'on' : 'off';
    case 'field':
    case 'fixed':
      return v.text;
  }
};

/** Open pull request: the value read as `settings propose` reads it, the reason required. */
const sendProposal = (r: SettingsDialogRules, s: SettingsState, p: Proposing): Out => {
  if (p.running !== undefined) return same(s);
  const reason = p.reason.trim();

  if (reason === '')
    return same({ ...s, mode: proposeMode({ ...p, focus: 'reason', error: PROPOSE_SURE }) });
  const typed = proposedTyped(p);
  const got = r.read(p.key, typed, p.field ?? undefined);

  if (!got.ok)
    return same({ ...s, mode: proposeMode({ ...p, focus: 'value', error: got.message }) });
  const runs = s.runs + 1;
  const id = `settings:propose:${runs}`;
  const name = p.field === null ? p.key : `${p.key}#${p.field}`;
  const value = cliTyped(got.value, typed);

  return {
    state: { ...s, runs, mode: proposeMode({ ...p, running: id, error: undefined }) },
    commands: [
      {
        kind: 'run',
        id,
        argv: cliArgv(['settings', 'propose'], [name, value], [`--reason=${reason}`]),
      },
    ],
  };
};

const PROPOSE_ORDER: readonly ProposeFocus[] = ['value', 'reason', 'cancel', 'open'];

const proposeTab = (p: Proposing, by: 1 | -1): Proposing => {
  const at = PROPOSE_ORDER.indexOf(p.focus);
  const focus = PROPOSE_ORDER[(at + by + PROPOSE_ORDER.length) % PROPOSE_ORDER.length] ?? 'reason';

  return { ...p, focus };
};

/** A key while the propose popup is up: it has them all. */
export const proposeKey = (
  r: SettingsDialogRules,
  s: SettingsState,
  p: Proposing,
  key: string,
): Out => {
  // while it opens: Esc leaves the popup (the answer then lands on nothing), the rest waits
  if (p.running !== undefined) return key === '<Esc>' ? same({ ...s, mode: undefined }) : same(s);
  if (key === '<Esc>') return same({ ...s, mode: undefined });
  if (key === '<Tab>') return same({ ...s, mode: proposeMode(proposeTab(p, 1)) });
  if (key === '<S-Tab>') return same({ ...s, mode: proposeMode(proposeTab(p, -1)) });
  if (key === '<CR>' || key === '<D-CR>')
    return p.focus === 'cancel' ? same({ ...s, mode: undefined }) : sendProposal(r, s, p);
  const put = (q: Proposing) => same({ ...s, mode: proposeMode({ ...q, error: undefined }) });
  const v = p.value;

  switch (p.focus) {
    case 'value':
      if (v.kind === 'pick' && (UP.has(key) || DOWN.has(key) || LEFT.has(key) || RIGHT.has(key))) {
        const by = UP.has(key) || LEFT.has(key) ? -1 : 1;
        const at = Math.max(0, Math.min(v.choices.length - 1, v.at + by));

        return put({ ...p, value: { ...v, at } });
      }
      // Home / End the first and last choice, the pages (`list-moves.ts`, #334)
      if (v.kind === 'pick') {
        const m = filterMove(key, PAGE_ROWS);

        if (m !== undefined)
          return put({ ...p, value: { ...v, at: movedRow(m, v.at, v.choices.length) } });
      }
      if (v.kind === 'toggle' && key === '<Space>')
        return put({ ...p, value: { ...v, on: !v.on } });
      if (v.kind === 'field') return put({ ...p, value: { ...v, text: edited(v.text, key) } });

      return same(s);
    case 'reason':
      return put({ ...p, reason: edited(p.reason, key) });
    case 'cancel':
    case 'open':
      if (LEFT.has(key) || RIGHT.has(key))
        return same({
          ...s,
          mode: proposeMode({ ...p, focus: p.focus === 'open' ? 'cancel' : 'open' }),
        });

      return same(s);
  }
};

export const proposeClick = (
  r: SettingsDialogRules,
  s: SettingsState,
  p: Proposing,
  id: string,
): Out => {
  if (id === 'settings:propose:cancel') return same({ ...s, mode: undefined });
  if (id === 'settings:propose:open') return sendProposal(r, s, p);
  if (id === 'settings:propose:value')
    return same({ ...s, mode: proposeMode({ ...p, focus: 'value' }) });
  if (id === 'settings:propose:reason')
    return same({ ...s, mode: proposeMode({ ...p, focus: 'reason' }) });

  return same(s);
};

/** Typed text while the popup is up: into its field, the reason or a text value. */
export const proposeText = (s: SettingsState, p: Proposing, text: string): Out => {
  if (p.running !== undefined) return same(s);
  if (p.focus === 'reason')
    return same({ ...s, mode: proposeMode({ ...p, reason: p.reason + text, error: undefined }) });
  if (p.focus === 'value' && p.value.kind === 'field')
    return same({
      ...s,
      mode: proposeMode({
        ...p,
        value: { ...p.value, text: p.value.text + text },
        error: undefined,
      }),
    });

  return same(s);
};

/** `abe settings propose` answered: the pull request said and the rows read again, or why not. */
export const proposed = (s: SettingsState, p: Proposing, input: Answer | Refused): Out => {
  if (!input.reply.ok)
    return same({
      ...s,
      mode: proposeMode({ ...p, running: undefined, error: proposeRefusal(input.reply.error) }),
    });
  if (input.command !== 'settings propose')
    return same({ ...s, mode: proposeMode({ ...p, running: undefined }) });
  const d = input.reply.data;
  const said = d.updated
    ? `Pull request #${d.pr.number} updated: ${d.label} → ${d.value}`
    : `Pull request #${d.pr.number} open for the repo: ${d.label} → ${d.value}`;
  const reread = read({ ...s, mode: undefined }, 'list');

  return { state: reread.state, commands: [...reread.commands, status(said)] };
};

/** A proposal refused, with the way out where the dialog knows it (#300). */
const proposeRefusal = (e: { code: string; message: string }): string => {
  const give = 'give this checkout its GitHub remote';

  switch (e.code) {
    case 'no-origin':
      return `${e.message}. A proposal opens a pull request on GitHub: ${give} (git remote add origin <url>)`;
    case 'not-github':
      return `${e.message}. A proposal opens a pull request on GitHub: ${give} (git remote set-url origin <url>)`;
    default:
      return refusal(e);
  }
};

export const proposeNode = (
  r: SettingsDialogRules,
  s: SettingsState,
  p: Proposing,
): SettingsPropose => {
  const where = `opens a pull request on this repo · ${r.proposalPath}`;

  return {
    kind: 'SettingsPropose',
    id: 'settings:propose',
    props: {
      title: `Propose for repo ${s.list?.scope.repo ?? '?'}`,
      label: p.label,
      value: { kind: p.value.kind, from: p.from, to: proposedShown(p) },
      reason: { text: p.reason },
      focus: p.focus,
      ...(p.error === undefined ? {} : { error: p.error }),
      ...(p.running === undefined ? {} : { busy: true }),
      where,
      cancel: { id: 'settings:propose:cancel', label: 'Cancel' },
      open: { id: 'settings:propose:open', label: 'Open pull request' },
    },
  };
};
