/**
 * `abe check json|yaml <files…>` (ADR 0026): a repo's static checks parse its config files with
 * Abe itself, read-only, from where the command is typed. The first file that does not parse is
 * refused with its `file:line:column` (exit 1); a file that is not there too.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type CheckFilesData,
  jsonError,
  type ParseError,
  parseErrorText,
  refused,
  type Handlers,
} from '@abe/core';
import { yamlError } from '@abe/ports';

export type CheckCtx = { cwd: string };

const checkFiles = async (
  kind: CheckFilesData['kind'],
  files: readonly string[],
  cwd: string,
  parse: (text: string) => ParseError | null,
) => {
  const parsed: string[] = [];

  for (const file of files) {
    let text: string;

    try {
      text = await readFile(resolve(cwd, file), 'utf8');
    } catch {
      return refused('not-readable', `${file}: no such file, or not readable`);
    }
    const e = parse(text);

    if (e !== null) return refused('not-parsed', parseErrorText(file, e));
    parsed.push(file);
  }

  return { ok: true as const, data: { kind, parsed } };
};

export const checkFilesHandlers = <Ctx extends CheckCtx>() =>
  ({
    'check json': (args, ctx) => checkFiles('json', args.files, ctx.cwd, jsonError),
    'check yaml': (args, ctx) => checkFiles('yaml', args.files, ctx.cwd, yamlError),
  }) satisfies Partial<Handlers<Ctx>>;
