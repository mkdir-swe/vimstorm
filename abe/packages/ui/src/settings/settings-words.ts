/**
 * Core's settings words that screens show (#168 Overrides, Problems' info rows, a row's open
 * proposals), redeclared here because ui reads only core's types (#37). `settings-words.test.ts`
 * keeps them equal to core's.
 */
import type { ListedRow, PersonalOverride, SettingsProblem } from '@abe/core';

/** An info row (#168: your Override), not a problem: never counted, never landed on. */
export const isInfoRow = (p: SettingsProblem): boolean => p.kind === 'override';

/** The rows that are problems (`isInfoRow` left out): what counts and lands. */
export const problemsOnly = (ps: readonly SettingsProblem[]): SettingsProblem[] =>
  ps.filter((p) => !isInfoRow(p));

/** A row's open proposals as words: `PR #1 open`, `PRs #1, #2 open`; empty for none. */
export const prsText = (prs: ListedRow['prs']): string =>
  prs.length === 0
    ? ''
    : `${prs.length === 1 ? 'PR' : 'PRs'} ${prs.map((p) => `#${p.number}`).join(', ')} open`;

/** The pill's words: `Override · autoMerge on`, `+N` for the rest. */
export const overridePill = (overrides: readonly PersonalOverride[]): string | undefined => {
  const [first, ...rest] = overrides;

  if (first === undefined) return undefined;

  return `Override · ${first.key} ${first.shown}${rest.length === 0 ? '' : ` · +${rest.length}`}`;
};

/** One Override for a tooltip or a list: `autoMerge on — my sandbox (since 2026-10-24)`. */
export const overrideWords = (o: PersonalOverride): string =>
  `${o.key} ${o.shown} — ${o.reason}${o.since === null ? '' : ` (since ${o.since.slice(0, 10)})`}`;

/** A source file or a code name: `theme.rs:54`, `darcula.lua`, `VCS_LOG_HOVER_BG`, `WsIconGold`. */
const REF =
  /\b[\w/-]+\.(?:rs|lua)\b(?::[\d-]+)?|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bWsIcon\w+|\(expUI_dark palette\)|:\d+\b/g;
/**
 * A Colours token's usage as the dialog shows it (#300): where it shows, its source references
 * (`FRAME_BG (theme.rs:54).`, `(darcula.lua:4)`, `not yet in theme.rs`) left out; core keeps them.
 */
export const tokenHelp = (usage: string): string =>
  usage
    // a clause that only names where it comes from: `ISL X;`, `Int UI Purple9 (…); not yet in theme.rs.`
    .replace(/^ISL [A-Z0-9_]+;\s*/, '')
    .replace(/^Int UI \w+ \([^)]*\);\s*not yet in [\w.]+\.\s*/, '')
    .replace(/\s*\([^()]*\)/g, (m) => (new RegExp(REF.source).test(m) ? '' : m))
    .replace(REF, '')
    // what the refs leave: `.  .`, `; ,`, a sentence with no words
    .replace(/^[\s/.,;]+/, '')
    // a code name left alone as a sentence: `BORDER.`, `CARET.`
    .replace(/^[A-Z][A-Z0-9]+(?:\s*\/)?\.\s+/, '')
    .replace(/\s+([.,;])/g, '$1')
    .replace(/([.;,])(?:\s*[.;,])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
