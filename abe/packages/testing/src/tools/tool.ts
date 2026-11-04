/**
 * A fake command-line tool on disk. It is a shell script first on `PATH` that keeps each call's
 * argv, environment and stdin. It answers by the first pattern its arguments contain, else with
 * its fallback. `fakeGh` and `fakeAws` are built on it, with their tool's own shapes.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What one call prints and exits with. `json` prints as one line on stdout. */
export type ToolAnswer = { json?: unknown; stdout?: string; stderr?: string; exit?: number };

export type ToolCall = { argv: string[]; env: Record<string, string>; stdin: string };

export type FakeTool = {
  dir: string;
  /** `PATH` with this tool first and only the system's tools after it. */
  path: string;
  /** Replaces the answers, given as `[pattern, answer]`. The first pattern `"$*"` contains wins. */
  answer: (answers: readonly (readonly [string, ToolAnswer])[]) => void;
  /** Every call so far, in the order they were made. */
  calls: () => ToolCall[];
  remove: () => void;
};

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export const fakeTool = (
  name: string,
  fallback: ToolAnswer,
  answers: readonly (readonly [string, ToolAnswer])[] = [],
): FakeTool => {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const calls = join(dir, 'calls');
  const bin = join(dir, name);
  let version = 0;

  const answer: FakeTool['answer'] = (list) => {
    version += 1;
    const cases = list.map(([pattern, a], i) => {
      const out = join(dir, `out.${version}.${i}`);
      const err = join(dir, `err.${version}.${i}`);

      writeFileSync(out, a.json === undefined ? (a.stdout ?? '') : `${JSON.stringify(a.json)}\n`);
      writeFileSync(err, a.stderr === undefined ? '' : `${a.stderr}\n`);

      return `  *${quote(pattern)}*) cat ${quote(out)}; cat ${quote(err)} >&2; exit ${a.exit ?? 0};;`;
    });
    const script = [
      '#!/bin/sh',
      `d=${quote(dir)}`,
      'id=$$',
      'printf \'%s\\0\' "$@" > "$d/argv.$id"',
      '/usr/bin/env > "$d/env.$id"',
      'cat > "$d/stdin.$id"',
      'echo $id >> "$d/calls"',
      'case "$*" in',
      ...cases,
      'esac',
      `printf '%s\\n' ${quote(fallback.stdout ?? '')}`,
      `printf '%s\\n' ${quote(fallback.stderr ?? '')} >&2`,
      `exit ${fallback.exit ?? 1}`,
      '',
    ].join('\n');

    writeFileSync(`${bin}.new`, script, { mode: 0o755 });
    // A rename, so a call running now reads the old script or the new one, never half of one.
    renameSync(`${bin}.new`, bin);
  };

  answer(answers);

  const read = (file: string) => readFileSync(join(dir, file), 'utf8');

  return {
    dir,
    path: `${dir}:/usr/bin:/bin`,
    answer,
    calls: () => {
      if (!existsSync(calls)) return [];

      return readFileSync(calls, 'utf8')
        .split('\n')
        .filter((id) => id !== '')
        .map((id) => ({
          argv: read(`argv.${id}`).split('\0').slice(0, -1),
          env: Object.fromEntries(
            read(`env.${id}`)
              .split('\n')
              .filter((l) => l.includes('='))
              .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
          ),
          stdin: read(`stdin.${id}`),
        }));
    },
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
