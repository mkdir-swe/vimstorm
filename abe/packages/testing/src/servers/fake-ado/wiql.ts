/**
 * The WIQL the fake Azure DevOps reads. It takes `SELECT … FROM WorkItems WHERE … ORDER BY …` with
 * `=`, `<>`, `<`, `>`, `IN`, `NOT IN`, `UNDER`, `CONTAINS`, `AND`, `OR`, `NOT` and parentheses. It
 * knows the macros the Board sends: `@project`, `@me`, and `@today` with an optional `- <days>`.
 */

/** A field's value as the fake keeps it. */
export type Identity = { displayName: string; uniqueName: string; id: string; imageUrl: string };
export type FieldValue = string | number | Identity;
export type Fields = Record<string, FieldValue>;

/** `@me` in a query matches the fake's own person. */
const ME = Symbol('me');
type Value = string | number | typeof ME;

/** `today` is the fake's own date as `YYYY-MM-DD`, its clock's day in UTC. */
export type Macros = { project: string; me: Identity; today: string };

export class WiqlError extends Error {}

const TOKEN =
  /\s*(\[[^\]]+\]|'(?:[^']|'')*'|@\w+|<>|!=|>=|<=|=|<|>|\(|\)|,|[+-]?\d+(?:\.\d+)?|[+-]|[A-Za-z_][\w.]*)/y;

const tokenize = (text: string): string[] => {
  const out: string[] = [];
  let at = 0;

  while (at < text.length) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(text);
    const tok = m?.[1];

    if (tok === undefined) {
      if (/^\s*$/.test(text.slice(at))) break;
      throw new WiqlError(`TF51006: The query cannot be parsed near '${text.slice(at, at + 20)}'.`);
    }
    out.push(tok);
    at = TOKEN.lastIndex;
  }

  return out;
};

const isIdentity = (v: FieldValue | undefined): v is Identity => typeof v === 'object';

export const plain = (v: FieldValue | undefined): string => {
  if (v === undefined) return '';
  if (isIdentity(v)) return `${v.displayName} <${v.uniqueName}>`;

  return String(v);
};

const equal = (field: FieldValue | undefined, v: Value, m: Macros): boolean => {
  if (v === ME)
    return isIdentity(field) && field.uniqueName.toLowerCase() === m.me.uniqueName.toLowerCase();
  if (field === undefined) return v === '';
  if (isIdentity(field)) {
    const want = String(v).toLowerCase();

    return [field.displayName, field.uniqueName, plain(field)].some(
      (s) => s.toLowerCase() === want,
    );
  }
  if (typeof field === 'number' || typeof v === 'number') return Number(field) === Number(v);

  return field.toLowerCase() === v.toLowerCase();
};

export const compare = (a: FieldValue | undefined, b: FieldValue | undefined): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = plain(a).toLowerCase();
  const y = plain(b).toLowerCase();

  if (x < y) return -1;

  return x > y ? 1 : 0;
};

type Test = (fields: Fields) => boolean;
export type Query = { where: Test; order: { name: string; desc: boolean }[] };

export const parseWiql = (text: string, m: Macros): Query => {
  const t = tokenize(text);
  let i = 0;
  const peek = (k = 0) => t[i + k];
  const word = (k = 0) => (peek(k) ?? '').toUpperCase();
  const take = (): string => {
    const tok = t[i];

    if (tok === undefined) throw new WiqlError('TF51006: The query ends too soon.');
    i += 1;

    return tok;
  };
  const expect = (w: string) => {
    if (word() !== w) throw new WiqlError(`TF51006: Expecting ${w} near '${peek() ?? 'the end'}'.`);
    take();
  };
  const field = (tok: string) => {
    if (!tok.startsWith('[')) throw new WiqlError(`TF51006: Expecting a field near '${tok}'.`);

    return tok.slice(1, -1);
  };
  const value = (): Value => {
    const tok = take();

    if (tok.startsWith("'")) return tok.slice(1, -1).replaceAll("''", "'");
    const v = tok.toLowerCase();

    if (v === '@project') return m.project;
    if (v === '@me') return ME;
    if (v === '@today') {
      // `@Today - 14` is that many days back, as a date that compares with the fake's ISO dates
      const next = peek() ?? '';
      let days = 0;

      if (next === '-' || next === '+') {
        take();
        days = (next === '-' ? -1 : 1) * Number(take());
      } else if (/^[+-]\d+$/.test(next)) days = Number(take());
      if (!Number.isInteger(days)) throw new WiqlError(`TF51006: Expecting days after ${tok}.`);

      return new Date(Date.parse(`${m.today}T00:00:00Z`) + days * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }
    if (v.startsWith('@')) throw new WiqlError(`TF51006: The fake has no macro ${tok}.`);
    if (/^[+-]?\d/.test(tok)) return Number(tok);

    return tok;
  };
  const values = (): Value[] => {
    expect('(');
    const out: Value[] = [];

    while (peek() !== ')') {
      out.push(value());
      if (peek() === ',') take();
    }
    take();

    return out;
  };
  const operand = (v: Value): FieldValue => (v === ME ? m.me : v);

  const condition = (): Test => {
    const name = field(take());
    let not = false;

    if (word() === 'NOT') {
      take();
      not = true;
    }
    if (word() === 'EVER') take();
    const op = word();
    let test: Test;

    if (op === 'IN') {
      take();
      const vs = values();

      test = (f) => vs.some((v) => equal(f[name], v, m));
    } else if (op === 'UNDER') {
      take();
      const v = String(value()).toLowerCase();

      test = (f) => {
        const p = plain(f[name]).toLowerCase();

        return p === v || p.startsWith(`${v}\\`);
      };
    } else if (op === 'CONTAINS') {
      take();
      if (word() === 'WORDS') take();
      const v = String(value()).toLowerCase();

      test = (f) => plain(f[name]).toLowerCase().includes(v);
    } else if (['=', '<>', '!=', '<', '>', '<=', '>='].includes(op)) {
      take();
      const other = peek()?.startsWith('[') === true ? field(take()) : undefined;
      const v = other === undefined ? value() : '';
      const right = (f: Fields) => (other === undefined ? operand(v) : f[other]);
      const eq = (f: Fields) =>
        other === undefined ? equal(f[name], v, m) : compare(f[name], f[other]) === 0;
      const cmp = (f: Fields) => compare(f[name], right(f));
      const tests: Record<string, Test> = {
        '=': eq,
        '<>': (f) => !eq(f),
        '!=': (f) => !eq(f),
        '<': (f) => cmp(f) < 0,
        '>': (f) => cmp(f) > 0,
        '<=': (f) => cmp(f) <= 0,
        '>=': (f) => cmp(f) >= 0,
      };
      const found = tests[op];

      if (found === undefined) throw new WiqlError(`TF51006: Unknown operator '${op}'.`);
      test = found;
    } else {
      throw new WiqlError(`TF51006: Unknown operator '${peek() ?? ''}'.`);
    }

    return not ? (f) => !test(f) : test;
  };
  const factor = (): Test => {
    if (word() === 'NOT') {
      take();
      const f = factor();

      return (x) => !f(x);
    }
    if (peek() === '(') {
      take();
      const e = or();

      expect(')');

      return e;
    }

    return condition();
  };
  const and = (): Test => {
    const parts = [factor()];

    while (word() === 'AND') {
      take();
      parts.push(factor());
    }

    return (f) => parts.every((p) => p(f));
  };
  const or = (): Test => {
    const parts = [and()];

    while (word() === 'OR') {
      take();
      parts.push(and());
    }

    return (f) => parts.some((p) => p(f));
  };

  expect('SELECT');
  while (peek() !== undefined && word() !== 'FROM') take();
  expect('FROM');
  take();
  let where: Test = () => true;

  if (word() === 'WHERE') {
    take();
    where = or();
  }
  const order: Query['order'] = [];

  if (word() === 'ORDER') {
    take();
    expect('BY');
    while (peek()?.startsWith('[') === true) {
      const name = field(take());
      let desc = false;

      if (word() === 'ASC' || word() === 'DESC') desc = take().toUpperCase() === 'DESC';
      order.push({ name, desc });
      if (peek() === ',') take();
    }
  }

  return { where, order };
};
