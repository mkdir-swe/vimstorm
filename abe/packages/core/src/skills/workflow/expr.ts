/**
 * A `check:` (#15): an expression over the facts a workflow's steps report, which Abe evaluates
 * with no model. Facts (`checks.failed`), numbers, `true` / `false`, compared with
 * `> < >= <= == !=`, joined by `and` / `or`, negated by `not`, grouped by parentheses. A fact not
 * reported yet reads as 0.
 */

export type Expr =
  | { kind: 'fact'; name: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'not'; of: Expr }
  | { kind: 'and' | 'or'; left: Expr; right: Expr }
  | { kind: 'cmp'; op: CmpOp; left: Expr; right: Expr };

export const CMP_OPS = ['>=', '<=', '==', '!=', '>', '<'] as const;
export type CmpOp = (typeof CMP_OPS)[number];

/** A fact's value as a step reported it. */
export type FactValue = number | boolean | string;
export type Facts = Readonly<Record<string, FactValue>>;

type Token =
  | { t: 'num'; v: number; at: number }
  | { t: 'word'; v: string; at: number }
  | { t: 'op'; v: CmpOp; at: number }
  | { t: '(' | ')'; at: number };

export type CheckParsed = { ok: true; expr: Expr } | { ok: false; message: string; at: number };

const FACT = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/i;

const tokens = (text: string): Token[] | { message: string; at: number } => {
  const out: Token[] = [];
  let i = 0;

  while (i < text.length) {
    const c = text.charAt(i);

    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '(' || c === ')') {
      out.push({ t: c, at: i });
      i += 1;
      continue;
    }
    const op = CMP_OPS.find((o) => text.startsWith(o, i));

    if (op !== undefined) {
      out.push({ t: 'op', v: op, at: i });
      i += op.length;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(text.slice(i));

    if (num !== null) {
      out.push({ t: 'num', v: Number(num[0]), at: i });
      i += num[0].length;
      continue;
    }
    const word = /^[a-z][a-z0-9_.-]*/i.exec(text.slice(i));

    if (word === null) return { message: `${c} is not part of a check`, at: i };
    out.push({ t: 'word', v: word[0], at: i });
    i += word[0].length;
  }

  return out;
};

/** A `check:` read, or where and why it does not. */
export const parseCheck = (text: string): CheckParsed => {
  const read = tokens(text);

  if (!Array.isArray(read)) return { ok: false, ...read };
  const ts = read;
  let p = 0;
  const fail = (message: string): never => {
    throw new CheckError(message, ts[p]?.at ?? text.length);
  };
  const isWord = (w: string) => {
    const t = ts[p];

    return t?.t === 'word' && t.v === w;
  };
  const atom = (): Expr => {
    const t = ts[p];

    if (t === undefined) return fail('the check ends too soon');
    p += 1;
    switch (t.t) {
      case 'num':
        return { kind: 'number', value: t.v };
      case '(': {
        const e = or();

        if (ts[p]?.t !== ')') return fail('a ( is not closed');
        p += 1;

        return e;
      }
      case 'word':
        if (t.v === 'true' || t.v === 'false') return { kind: 'bool', value: t.v === 'true' };
        if (['and', 'or', 'not'].includes(t.v)) {
          p -= 1;

          return fail(`${t.v} needs a fact before it`);
        }
        if (!FACT.test(t.v)) {
          p -= 1;

          return fail(`${t.v} is not a fact name`);
        }

        return { kind: 'fact', name: t.v };
      default:
        p -= 1;

        return fail(`${t.t === 'op' ? t.v : t.t} needs a fact before it`);
    }
  };
  const cmp = (): Expr => {
    const left = atom();
    const t = ts[p];

    if (t?.t !== 'op') return left;
    p += 1;

    return { kind: 'cmp', op: t.v, left, right: atom() };
  };
  const not = (): Expr => {
    if (isWord('not')) {
      p += 1;

      return { kind: 'not', of: not() };
    }

    return cmp();
  };
  const and = (): Expr => {
    let e = not();

    while (isWord('and')) {
      p += 1;
      e = { kind: 'and', left: e, right: not() };
    }

    return e;
  };
  const or = (): Expr => {
    let e = and();

    while (isWord('or')) {
      p += 1;
      e = { kind: 'or', left: e, right: and() };
    }

    return e;
  };

  try {
    if (ts.length === 0) return { ok: false, message: 'the check is empty', at: 0 };
    const expr = or();

    if (p < ts.length) fail('the check goes on past its end: join conditions with and / or');

    return { ok: true, expr };
  } catch (err) {
    if (err instanceof CheckError) return { ok: false, message: err.message, at: err.at };
    throw err;
  }
};

class CheckError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

/** The facts an expression names, each once, in order. */
export const factsIn = (e: Expr): string[] => {
  switch (e.kind) {
    case 'fact':
      return [e.name];
    case 'number':
    case 'bool':
      return [];
    case 'not':
      return factsIn(e.of);
    case 'and':
    case 'or':
    case 'cmp':
      return [...new Set([...factsIn(e.left), ...factsIn(e.right)])];
  }
};

const numberOf = (v: FactValue | undefined): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;

  return v === undefined || v === '' ? 0 : 1;
};

const valueOf = (e: Expr, facts: Facts): number => {
  switch (e.kind) {
    case 'fact':
      return numberOf(facts[e.name]);
    case 'number':
      return e.value;
    case 'bool':
      return e.value ? 1 : 0;
    default:
      return holds(e, facts) ? 1 : 0;
  }
};

const COMPARE: Readonly<Record<CmpOp, (a: number, b: number) => boolean>> = {
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

/** Whether an expression holds over `facts`: a bare fact or number holds when it is not 0. */
export const holds = (e: Expr, facts: Facts): boolean => {
  switch (e.kind) {
    case 'not':
      return !holds(e.of, facts);
    case 'and':
      return holds(e.left, facts) && holds(e.right, facts);
    case 'or':
      return holds(e.left, facts) || holds(e.right, facts);
    case 'cmp':
      return COMPARE[e.op](valueOf(e.left, facts), valueOf(e.right, facts));
    default:
      return valueOf(e, facts) !== 0;
  }
};

/** Whether a `check:` text holds over `facts`; one that does not read never holds. */
export const checkHolds = (text: string, facts: Facts): boolean => {
  const parsed = parseCheck(text);

  return parsed.ok && holds(parsed.expr, facts);
};

/**
 * `--fact name=value`s as facts (#15): a number, `true` / `false`, else the text; each name once
 * (the last wins), or why one does not read.
 */
export const factValues = (
  given: readonly string[],
): { ok: true; facts: Record<string, FactValue> } | { ok: false; message: string } => {
  const facts: Record<string, FactValue> = {};

  for (const g of given) {
    const eq = g.indexOf('=');
    const name = eq === -1 ? '' : g.slice(0, eq).trim();
    const raw = eq === -1 ? '' : g.slice(eq + 1).trim();

    if (name === '' || !/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/i.test(name))
      return { ok: false, message: `--fact is name=value (checks.failed=0), not ${g}` };
    if (raw === 'true' || raw === 'false') facts[name] = raw === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(raw)) facts[name] = Number(raw);
    else facts[name] = raw;
  }

  return { ok: true, facts };
};
