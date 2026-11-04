/**
 * `abe check yaml`'s parse (ADR 0026): where a YAML text first stops parsing, every document in it
 * (`---`), with the `yaml` package Abe ships, so a repo's check needs no YAML tool of its own.
 */
import { type ParseError } from '@abe/core';
import { LineCounter, parseAllDocuments } from 'yaml';

/** Where a YAML text first stops parsing (its line and column from 1, and why); null: it parses. */
export const yamlError = (text: string): ParseError | null => {
  const lines = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lines });
  const all = Array.isArray(docs) ? docs : [];
  const first = all.flatMap((d) => d.errors)[0];

  if (first === undefined) return null;
  const pos = first.linePos?.[0] ?? lines.linePos(first.pos[0]);

  return {
    line: pos.line,
    column: pos.col,
    message: (first.message.split('\n')[0] ?? first.message).replace(
      / at line \d+, column \d+:?$/,
      '',
    ),
  };
};
