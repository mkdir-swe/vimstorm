/**
 * The verb table (#113 Behaviour 3): one tool call and its result as a Chat step row, glyph +
 * verb + object + result (`✓ Read api/src/cart.ts`, `✗ Ran npm test · 1 failed · cart total
 * ignores quantity`, `● Running npm test`; the running time is the UI's). Auto mode is "Bash
 * first" (t113a's spike: no Grep tool, `cat` for reading, `sed -i` for editing), so a Bash
 * command is read for what it does: `cat` / `sed -n` / `head` read, `grep` / `rg` search, a test
 * runner runs tests (its counts read from the output), `git …` and the rest run. A write Reach
 * refused on a read name is that refusal (`✗ Test DB write refused · Reach: read only · say
 * /override to lower it`).
 */
import { type TranscriptEntry } from './transcript';

export const STEP_GLYPHS = ['ok', 'failed', 'running'] as const;
export type StepGlyph = (typeof STEP_GLYPHS)[number];

/** A step row's words: `verb object · result`, result null when there is none. */
export type Step = { glyph: StepGlyph; verb: string; object: string; result: string | null };

type Use = Pick<Extract<TranscriptEntry, { kind: 'tool-use' }>, 'tool' | 'input'>;
type Result = Pick<Extract<TranscriptEntry, { kind: 'tool-result' }>, 'ok' | 'text' | 'patch'>;

/** A Bash command shown whole is cut beyond this. */
export const COMMAND_MAX = 60;
const RESULT_MAX = 80;

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const str = (input: Use['input'], key: string): string | undefined => {
  const v = input[key];

  return typeof v === 'string' ? v : undefined;
};

/** A path under `root` relative to it; any other as it is. */
const shown = (path: string, root: string | undefined) => {
  if (root === undefined) return path;
  const base = `${root.replace(/\/+$/, '')}/`;

  return path.startsWith(base) ? path.slice(base.length) : path;
};

/** Done and running forms of each verb. */
const RUNNING: Readonly<Record<string, string>> = {
  Read: 'Reading',
  Searched: 'Searching',
  Listed: 'Listing',
  Edited: 'Editing',
  Wrote: 'Writing',
  Created: 'Creating',
  Ran: 'Running',
  Fetched: 'Fetching',
  Task: 'Task',
  Updated: 'Updating',
  Asked: 'Asking',
  Used: 'Using',
};

// ── Bash, read out of its command ───────────────────────────────────────────────────────────

/**
 * A command line split at `&&`, `||`, `;` and newlines outside quotes, each part trimmed, with
 * where it starts in the line.
 */
const segmentsAt = (command: string): { text: string; at: number }[] => {
  const parts: { text: string; at: number }[] = [];
  let quote: string | null = null;
  let part = '';
  let at = 0;

  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? '';
    const two = command.slice(i, i + 2);

    if (quote !== null) {
      if (c === '\\' && quote === '"') {
        part += command.slice(i, i + 2);
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      part += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      part += c;
      continue;
    }
    if (two === '&&' || two === '||') {
      parts.push({ text: part, at });
      part = '';
      i += 1;
      at = i + 1;
      continue;
    }
    if (c === ';' || c === '\n') {
      parts.push({ text: part, at });
      part = '';
      at = i + 1;
      continue;
    }
    part += c;
  }
  parts.push({ text: part, at });

  return parts
    .map((p) => ({ text: p.text.trim(), at: p.at + p.text.length - p.text.trimStart().length }))
    .filter((p) => p.text !== '');
};

/** A command line split at `&&`, `||`, `;` and newlines outside quotes, each part trimmed. */
const segments = (command: string): string[] => segmentsAt(command).map((p) => p.text);

/** A segment's first command of its pipe (outside quotes). */
const firstOfPipe = (segment: string): string => {
  let quote: string | null = null;

  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] ?? '';

    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '|') return segment.slice(0, i).trim();
  }

  return segment;
};

/** A redirection word on its own (`>`, `2>>`, `&>`): the word after it is its target. */
const REDIRECT = /^(?:\d|&)?(?:>>?|<)$/;

/** Shell words of a command, quotes taken off; redirections and `VAR=value` prefixes dropped. */
const words = (command: string): string[] => {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;

  for (const m of command.matchAll(re)) {
    const word = m[1] ?? m[2] ?? m[3] ?? '';

    out.push(m[1] === undefined ? word : word.replace(/\\(.)/g, '$1'));
  }
  const kept = out.filter(
    (w, i) =>
      !REDIRECT.test(w) &&
      !REDIRECT.test(out[i - 1] ?? '') &&
      !/^\d*[<>]/.test(w) &&
      !/^&\d/.test(w) &&
      !w.startsWith('<<'),
  );
  const first = kept.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));

  return first < 0 ? [] : kept.slice(first);
};

/** `text` with what is inside its quotes blanked (`_`), the quotes kept: same length, same places. */
const unquoted = (text: string): string => {
  let quote: string | null = null;
  let out = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';

    if (quote === null) {
      if (c === '"' || c === "'") quote = c;
      out += c;
    } else if (c === '\\' && quote === '"' && i + 1 < text.length) {
      out += '__';
      i += 1;
    } else if (c === quote) {
      quote = null;
      out += c;
    } else out += '_';
  }

  return out;
};

/**
 * The files a command's stdout goes to (`> f`, `>> f`, `>f`, `tee f`), never `/dev/null`; only
 * outside quotes (`node -e "a => a + 1"` writes nothing).
 */
const writtenTo = (segment: string): string[] => {
  const bare = unquoted(segment);
  const at = (m: RegExpExecArray, group: number) => {
    const span = m.indices?.[group];

    return span === undefined ? '' : segment.slice(span[0], span[1]);
  };
  const targets = [...bare.matchAll(/(?:^|[^\d&<>])>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/dg)].map(
    (m) => at(m, 1).replace(/^["']|["']$/g, ''),
  );
  const tee = /(?:^|\|)\s*tee\s+((?:-\S+\s+)*)(\S+)/d.exec(bare);

  return [...targets, ...(tee === null ? [] : [at(tee, 2)])].filter(
    (t) => t !== '' && t !== '/dev/null' && !t.startsWith('&'),
  );
};

/**
 * The command without its heredocs' bodies (`cat > f <<'EOF'` … `EOF`): their lines are a
 * file's text, not commands.
 */
const withoutHeredocs = (command: string): string => {
  const out: string[] = [];
  let until: string | undefined;

  for (const line of command.split('\n')) {
    if (until !== undefined) {
      if (line.trim() === until) until = undefined;
      continue;
    }
    out.push(line);
    until = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/.exec(line)?.[1];
  }

  return out.join('\n');
};

const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);

/** The test runner a command is, as its row names it (`npm test`, `bun test`, `vitest`). */
const testRunner = (w: readonly string[]): string | undefined => {
  const [a, b, c] = w;

  if (a === undefined) return undefined;
  if ((a === 'npm' || a === 'pnpm' || a === 'yarn') && (b === 'test' || b === 't'))
    return `${a} test`;
  if ((a === 'npm' || a === 'pnpm' || a === 'yarn' || a === 'bun') && b === 'run' && c === 'test')
    return `${a} test`;
  if (a === 'bun' && b === 'test') return 'bun test';
  if ((a === 'npx' || a === 'bunx' || a === 'pnpx') && b !== undefined)
    return testRunner(w.slice(1));
  if (a === 'vitest' || a === 'jest' || a === 'pytest' || a === 'mocha') return a;
  if (a === 'node' && w.includes('--test')) return 'node --test';
  if ((a === 'cargo' || a === 'go') && b === 'test') return `${a} test`;

  return undefined;
};

/** A reading command's files (what is not a flag, nor `sed -n`'s script). */
const readFiles = (w: readonly string[]): string[] => {
  const args = w.slice(1);

  if (w[0] === 'sed') {
    const files = args.filter((a) => !a.startsWith('-'));

    return files.slice(1);
  }
  const numbered = w[0] === 'head' || w[0] === 'tail';

  return args.filter(
    (a, i) => !a.startsWith('-') && !(numbered && /^-[nc]$/.test(args[i - 1] ?? '')),
  );
};

/** A search's pattern: `-e <p>`, else its first word not a flag. */
const searchPattern = (w: readonly string[]): string | undefined => {
  const args = w.slice(1);
  const e = args.findIndex((a) => a === '-e' || a === '--regexp');

  if (e >= 0) return args[e + 1];
  const VALUED = new Set(['-A', '-B', '-C', '-m', '-g', '--glob', '-t', '--type', '--include']);

  return args.find((a, i) => !a.startsWith('-') && !VALUED.has(args[i - 1] ?? ''));
};

/** Files named in a search's output (`path:line:…`, `path:…` or `-l`'s bare paths). */
const matchedFiles = (text: string): number => {
  const files = new Set<string>();

  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('Exit code')) continue;
    const at = /^([^:\s][^:]*?):(?:\d+[:-]|\s|$)/.exec(line);

    files.add(at?.[1] ?? line.trim());
  }

  return files.size;
};

/** What a test run's output says: passed, failed, skipped and the first failing test's name. */
export type TestCounts = {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  firstFailing: string | null;
};

const count = (text: string, re: RegExp): number | null => {
  const m = re.exec(text);

  return m?.[1] === undefined ? null : Number(m[1]);
};

/**
 * The counts in a test runner's output: node's `ℹ pass 5`, vitest's `Tests  1 failed | 12
 * passed`, jest's `Tests: 1 failed, 12 passed`, bun's ` 12 pass` and pytest's `1 failed, 12
 * passed`; the first failing test's name from `✖ name (…ms)`, `× name`, `● a › name`, `(fail)
 * name` or `FAIL … > name`.
 */
export const testCounts = (text: string): TestCounts => {
  const node = {
    passed: count(text, /^ℹ pass (\d+)/m),
    failed: count(text, /^ℹ fail (\d+)/m),
    skipped: count(text, /^ℹ skipped (\d+)/m),
  };
  const summary = /^\s*Tests:?\s+(.+)$/m.exec(text)?.[1] ?? /^=+ (.+) in [\d.]+s/m.exec(text)?.[1];
  const of = (re: RegExp) => (summary === undefined ? null : count(summary, re));
  const bun = {
    passed: count(text, /^\s*(\d+) pass$/m),
    failed: count(text, /^\s*(\d+) fail$/m),
    skipped: count(text, /^\s*(\d+) skip$/m),
  };
  const pick = (k: 'passed' | 'failed' | 'skipped', re: RegExp) =>
    node[k] ?? of(re) ?? bun[k] ?? null;
  const firstFailing =
    /^\s*✖ (?!failing tests:)(.+?)(?: \([\d.]+m?s\))?$/m.exec(text)?.[1] ??
    /^\s*(?:×|✗) (.+?)(?: \d+m?s)?$/m.exec(text)?.[1] ??
    /^\s*● (?:.+ › )?(.+)$/m.exec(text)?.[1] ??
    /^\s*\(fail\) (?:.+ > )?(.+?)(?: \[[\d.]+m?s\])?$/m.exec(text)?.[1] ??
    /^\s*FAIL\s+\S+ > (?:.+ > )?(.+?)(?: \d+m?s)?$/m.exec(text)?.[1] ??
    /^FAILED \S+::(\S+)/m.exec(text)?.[1] ??
    null;

  return {
    passed: pick('passed', /(\d+) passed/),
    failed: pick('failed', /(\d+) failed/),
    skipped: pick('skipped', /(\d+) skipped/),
    firstFailing: firstFailing?.trim() ?? null,
  };
};

/** Passed and skipped counts; a failed run only its failed count and the first failing name. */
const testResult = (c: TestCounts, ok: boolean): { result: string | null; failed: boolean } => {
  const failed = (c.failed ?? 0) > 0;
  const parts = (
    failed
      ? [`${c.failed} failed`, c.firstFailing === null ? null : cut(c.firstFailing, RESULT_MAX)]
      : [
          c.passed === null ? null : `${c.passed} passed`,
          c.skipped === null || c.skipped === 0 ? null : `${c.skipped} skipped`,
        ]
  ).filter((p) => p !== null);

  return { result: parts.length === 0 ? null : parts.join(' · '), failed: failed || !ok };
};

/** `4 files`, `1 file`, or `none` for no file. */
const filesFound = (n: number, none: string) =>
  n === 0 ? none : `${n} ${n === 1 ? 'file' : 'files'}`;

/** What a failed command said: the sandbox's refusal, else its first line of output past the exit code. */
const failure = (text: string): string | null => {
  const denied = /^deny (network-outbound|file-write|file-read)\S* (\S+)/m.exec(text);

  if (denied !== null)
    return `sandbox denied ${denied[1] === 'network-outbound' ? '' : `${denied[1]} `}${denied[2] ?? ''}`;
  const exit = /^Exit code (\d+)/m.exec(text)?.[1];
  const said = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('Exit code') && !l.startsWith('<'))
    // A hook's refusal (#181, a local session's fence): its own reason, Claude Code's prefix gone.
    ?.replace(/^PreToolUse:\S+ hook error: /, '');

  return (
    [exit === undefined ? null : `exit ${exit}`, said === undefined ? null : cut(said, RESULT_MAX)]
      .filter((p) => p !== null)
      .join(' · ') || null
  );
};

/** What a database or AWS says when the read role a session holds is asked to write. */
const REFUSED: Readonly<Record<'db' | 'aws', RegExp>> = {
  db: /permission denied for |read-only transaction|must be owner of /i,
  aws: /\bAccessDenied(?:Exception)?\b|is not authorized to perform|UnauthorizedOperation/,
};

/**
 * A write Reach refused (#114's behaviour 11): the command used a read name (`$ABE_DB_READ_URL_TEST`,
 * `$ABE_AWS_READ_TEST`, the `abe-read-test` profile) and the database or AWS said no. Only an
 * Override lowers it: `✗ Test DB write refused · Reach: read only · say /override to lower it`.
 */
const reachRefusal = (command: string, text: string): Omit<Step, 'glyph'> | undefined => {
  const of = (service: 'db' | 'aws', re: RegExp) =>
    [...command.matchAll(re)].map((m) => ({ service, env: m[1] ?? '' }));
  const hit = [
    ...of('db', /\bABE_DB_READ_URL_([A-Z][A-Z0-9]*)\b/g),
    ...of('aws', /\bABE_AWS_READ_([A-Z][A-Z0-9]*)\b/g),
    ...of('aws', /\babe-read-([a-z][a-z0-9]*)\b/g),
  ].find((n) => REFUSED[n.service].test(text));

  if (hit === undefined) return undefined;
  const { service, env } = hit;
  const environment = `${env.slice(0, 1).toUpperCase()}${env.slice(1).toLowerCase()}`;

  return {
    verb: `${environment} ${service === 'db' ? 'DB' : 'AWS'} write`,
    object: 'refused',
    result: 'Reach: read only · say /override to lower it',
  };
};

/** A command with a leading `cd <dir> &&` taken off, as the row shows it: the rest as written. */
const commandShown = (command: string): string => {
  const rest = segmentsAt(command).find((p) => words(p.text)[0] !== 'cd');

  return cut(
    (rest === undefined ? command : command.slice(rest.at)).trim().replace(/\s+/g, ' '),
    COMMAND_MAX,
  );
};

const bashStep = (
  command: string,
  result: Result | null,
  root: string | undefined,
): Omit<Step, 'glyph'> & { failed: boolean } => {
  const plain = withoutHeredocs(command);
  const segs = segments(plain).filter((p) => words(p)[0] !== 'cd');
  const parts = segs.map((p) => words(firstOfPipe(p))).filter((w) => w.length > 0);
  const ok = result?.ok ?? true;
  const text = result?.text ?? '';
  const test = parts.map(testRunner).find((t) => t !== undefined);
  const refused = result === null ? undefined : reachRefusal(plain, text);

  if (refused !== undefined) return { ...refused, failed: true };
  if (test !== undefined) {
    const run =
      result === null ? { result: null, failed: false } : testResult(testCounts(text), ok);

    return { verb: 'Ran', object: test, ...run };
  }
  const first = parts[0];

  if (first === undefined)
    return { verb: 'Ran', object: commandShown(plain), result: null, failed: !ok };
  const [name] = first;
  // `cat > f <<EOF`, `echo … >> f`, `… | tee f`: the command writes that file.
  const written = writtenTo(segs[0] ?? '').length === 0 ? [] : segs.flatMap(writtenTo);

  if (written.length > 0 && name !== 'git')
    return {
      verb: 'Wrote',
      object: written.map((f) => shown(f, root)).join(', '),
      result: ok ? null : failure(text),
      failed: !ok,
    };

  if (name !== undefined && (READERS.has(name) || (name === 'sed' && first.includes('-n')))) {
    const files = readFiles(first);

    if (files.length > 0)
      return {
        verb: 'Read',
        object: files.map((f) => shown(f, root)).join(', '),
        result: ok ? null : failure(text),
        failed: !ok,
      };
  }
  const grep = name === 'git' && first[1] === 'grep' ? first.slice(1) : first;

  if (grep[0] !== undefined && (SEARCHERS.has(grep[0]) || grep[0] === 'grep')) {
    const pattern = searchPattern(grep) ?? '';
    // One file searched (grep's lines then name none): any line is that one file.
    const operands = grep.slice(1).filter((a) => !a.startsWith('-') && a !== pattern);
    const one =
      grep[0] !== 'rg' && operands.length === 1 && !grep.some((a) => /^-\w*[rRl]/.test(a));
    const lines = text.split('\n').some((l) => l.trim() !== '' && !l.startsWith('Exit code'));
    const matched = one ? Number(lines) : matchedFiles(text);
    // grep's exit 1: no line matched, which is an answer, not a failure.
    const none = !ok && /^Exit code 1\s*$/m.test(text) && matched === 0;
    const failed = !ok && !none;
    const found = failed ? failure(text) : filesFound(none ? 0 : matched, 'no matches');

    return {
      verb: 'Searched',
      object: `"${cut(pattern, COMMAND_MAX)}"`,
      result: result === null ? null : found,
      failed,
    };
  }

  // abe's own answer says whether it went: exit 1 with `ok: true` is a status that needs you
  const answered = !ok && name === 'abe' && ABE_OK.test(text.replace(/^Exit code \d+\s*/, ''));

  return {
    verb: 'Ran',
    object: commandShown(plain),
    result: ok || answered ? null : failure(text),
    failed: !ok && !answered,
  };
};

/** An abe `--json` answer that went: `{"ok": true, …}`. */
const ABE_OK = /^\s*\{\s*"ok"\s*:\s*true\b/;

// ── Every other tool ────────────────────────────────────────────────────────────────────────

const counts = (r: Result | null): string | null =>
  r?.patch === null || r?.patch === undefined ? null : `+${r.patch.added} −${r.patch.removed}`;

const hostOf = (url: string): string => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/i.exec(url);

  if (m === null) return cut(url, COMMAND_MAX);
  const path = m[2] ?? '';

  return cut(`${m[1] ?? ''}${path === '/' ? '' : path}`, COMMAND_MAX);
};

const todoCounts = (input: Use['input']): { done: number; all: number } | undefined => {
  const todos = input.todos;

  if (!Array.isArray(todos)) return undefined;
  const done = todos.filter(
    (t) => t !== null && typeof t === 'object' && !Array.isArray(t) && t.status === 'completed',
  ).length;

  return { done, all: todos.length };
};

/** A background Agent call's result begins so: launched, its work goes on. */
const ASYNC = 'Async agent launched';

/** Claude Code's question tool: Chat's question card stands for its call, never a step row. */
export const ASK_TOOL = 'AskUserQuestion';

/**
 * Whether a prompt is a card's answer as `ask.ts`' `questionMessage` or `grillMessage` wrote it
 * (`Answer to "<question>": …`, a grill round's `1. Answer to …`): Chat's answered line stands for
 * it, so the transcript draws no message of yours for it (#275).
 */
export const isAnswerMessage = (text: string): boolean => /^(1\. )?Answer to "/.test(text);

/**
 * An answer's words as its folded line says them (`◆ Answered · Magic link (1)`): the option's
 * number and label, or your own words; a grill round's numbered answers, how many.
 */
export const answerWords = (answer: string): { text: string; n?: number; questions?: number } => {
  const questions = answer.split('\n').filter((l) => /^\d+\. Answer to "/.test(l)).length;

  if (answer.startsWith('1. Answer to "')) return { text: '', questions };
  // the answer is its first line: what follows is said to the session (an install's next step)
  const m = /^Answer to ".*": (\d) ([^\n]*)/s.exec(answer);
  // a multiSelect question's options: `1 A, 3 C`, their labels alone
  const several = m === null ? [] : `${m[1] ?? ''} ${m[2] ?? ''}`.split(/, (?=\d )/);

  if (several.length > 1) return { text: several.map((x) => x.slice(2)).join(', ') };
  if (m?.[1] !== undefined && m[2] !== undefined) return { text: m[2], n: Number(m[1]) };
  const own = /^Answer to "[^\n]*": ([^\n]*)/.exec(answer);

  return { text: own?.[1] ?? answer.split('\n')[0] ?? answer };
};

/** An AskUserQuestion's first question's header, else its text. */
const askedHeader = (input: Use['input']): string => {
  const qs = input.questions;
  const first = Array.isArray(qs) ? qs[0] : undefined;

  if (first === null || typeof first !== 'object' || Array.isArray(first)) return '';
  if (typeof first.header === 'string') return first.header;

  return typeof first.question === 'string' ? first.question : '';
};

const toolStep = (
  use: Use,
  r: Result | null,
  root: string | undefined,
): Omit<Step, 'glyph'> & { failed: boolean } => {
  const ok = r?.ok ?? true;
  const failedText = r === null || ok ? null : failure(r.text);
  const path = (key: string) => shown(str(use.input, key) ?? '', root);

  switch (use.tool) {
    case 'Read':
      return { verb: 'Read', object: path('file_path'), result: failedText, failed: !ok };
    case 'Edit':
    case 'MultiEdit':
      return {
        verb: 'Edited',
        object: path('file_path'),
        result: failedText ?? counts(r),
        failed: !ok,
      };
    case 'NotebookEdit':
      return { verb: 'Edited', object: path('notebook_path'), result: failedText, failed: !ok };
    case 'Write':
      return {
        verb: r?.patch?.created === true ? 'Created' : 'Wrote',
        object: path('file_path'),
        result: failedText ?? counts(r),
        failed: !ok,
      };
    case 'Grep': {
      const files =
        r === null || !ok
          ? 0
          : Number(/^Found (\d+) file/m.exec(r.text)?.[1]) || matchedFiles(r.text);

      return {
        verb: 'Searched',
        object: `"${cut(str(use.input, 'pattern') ?? '', COMMAND_MAX)}"`,
        result: r === null ? null : (failedText ?? filesFound(files, 'no matches')),
        failed: !ok,
      };
    }
    case 'Glob': {
      const files =
        r === null || !ok
          ? 0
          : r.text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('No files')).length;

      return {
        verb: 'Listed',
        object: str(use.input, 'pattern') ?? '',
        result: r === null ? null : (failedText ?? filesFound(files, 'no files')),
        failed: !ok,
      };
    }
    case 'Task':
    case 'Agent': {
      const type = (str(use.input, 'subagent_type') ?? '').split(':').at(-1) ?? '';

      return {
        verb: 'Task',
        object: cut(str(use.input, 'description') ?? type, COMMAND_MAX),
        result:
          r === null
            ? type || null
            : (failedText ??
              [type || null, r.text.startsWith(ASYNC) ? 'in background' : 'done']
                .filter((p) => p !== null)
                .join(' · ')),
        failed: !ok,
      };
    }
    case 'WebFetch':
      return {
        verb: 'Fetched',
        object: hostOf(str(use.input, 'url') ?? ''),
        result: failedText,
        failed: !ok,
      };
    case 'WebSearch':
      return {
        verb: 'Searched',
        object: `the web "${cut(str(use.input, 'query') ?? '', COMMAND_MAX)}"`,
        result: failedText,
        failed: !ok,
      };
    case 'TodoWrite': {
      const t = todoCounts(use.input);

      return {
        verb: 'Updated',
        object: 'todos',
        result: failedText ?? (t === undefined ? null : `${t.done}/${t.all} done`),
        failed: !ok,
      };
    }
    case 'AskUserQuestion': {
      // Denied: asked in Abe's Chat instead (#114), which is no failure.
      const answer = ok ? 'answered' : 'asked in Chat';

      return {
        verb: 'Asked',
        object: cut(askedHeader(use.input), COMMAND_MAX),
        result: r === null ? null : answer,
        failed: false,
      };
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(use.tool);

      if (mcp !== null)
        return {
          verb: 'Used',
          object: `${mcp[1] ?? ''} ${mcp[2] ?? ''}`,
          result: failedText,
          failed: !ok,
        };

      return { verb: 'Used', object: use.tool, result: failedText, failed: !ok };
    }
  }
};

/**
 * A tool call (with its result once there is one) as a step row's words. `root`: the worktree,
 * so a path under it shows relative. A call without a result is running: its verb in that form.
 */
export const stepOf = (use: Use, result: Result | null, o: { root?: string } = {}): Step => {
  const command = use.tool === 'Bash' ? str(use.input, 'command') : undefined;
  const s =
    command === undefined ? toolStep(use, result, o.root) : bashStep(command, result, o.root);

  if (result === null)
    return { glyph: 'running', verb: RUNNING[s.verb] ?? s.verb, object: s.object, result: null };

  return { glyph: s.failed ? 'failed' : 'ok', verb: s.verb, object: s.object, result: s.result };
};

/** A step row as one line: `Read api/src/cart.ts`, `Ran npm test · 12 passed · 1 skipped`. */
export const stepText = (s: Step): string =>
  [`${s.verb} ${s.object}`.trim(), s.result].filter((p) => p !== null && p !== '').join(' · ');

/** Failed when one failed, else running when one runs, else ok. */
const worst = (steps: readonly Step[]): StepGlyph => {
  if (steps.some((s) => s.glyph === 'failed')) return 'failed';

  return steps.some((s) => s.glyph === 'running') ? 'running' : 'ok';
};

/**
 * Task rows next to each other as one (`Task Check the api's order total · 2 subagents · done`):
 * the first one's object, done once every one is, failed when one failed.
 */
export const foldTasks = (steps: readonly Step[]): Step[] => {
  const out: Step[] = [];
  let run: Step[] = [];
  const flush = () => {
    const [head] = run;

    if (head !== undefined && run.length === 1) out.push(head);
    else if (head !== undefined)
      out.push({
        glyph: worst(run),
        verb: head.verb,
        object: head.object,
        result: `${run.length} subagents${run.every((s) => s.glyph === 'ok' && (s.result ?? '').endsWith('done')) ? ' · done' : ''}`,
      });
    run = [];
  };

  for (const s of steps) {
    if (s.verb === 'Task') {
      run.push(s);
      continue;
    }
    flush();
    out.push(s);
  }
  flush();

  return out;
};
