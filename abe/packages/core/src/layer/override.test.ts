import { describe, expect, test } from 'bun:test';
import { inArea, overrideNote, overrideWhy, parseOverride, withOverrideNotes } from './override';

const AT = '2026-10-25T03:00:00.000Z';
const ENVS = ['test', 'prod'];
const REASON = 'Seed the shop for the Before check';

const parse = (what: string, where: 'local' | 'cloud' = 'cloud', reason = REASON) =>
  parseOverride({ what, reason, where, environments: ENVS, at: AT });

describe('parseOverride: the areas an Override may lower', () => {
  test('a Reach area: its words, the area and the reason', () => {
    expect(parse('db write test')).toEqual({
      ok: true,
      data: {
        what: 'db write test',
        words: 'Test DB write',
        area: { kind: 'reach', service: 'db', access: 'write', environment: 'test' },
        reason: REASON,
        at: AT,
      },
    });
    expect(parse('AWS  Write prod')).toMatchObject({
      ok: true,
      data: { what: 'aws write prod', words: 'Prod AWS write' },
    });
  });

  test('the read forms are areas too', () => {
    expect(parse('db read test', 'local')).toMatchObject({
      ok: true,
      data: { words: 'Test DB read' },
    });
  });

  test('network <host> is no area now: the network is open (ADR 0029), said so', () => {
    const got = parse('network api.stripe.com', 'local');

    expect(got).toMatchObject({ ok: false, error: { code: 'not-an-area' } });
    if (!got.ok)
      expect(got.error.message).toBe(
        "network api.stripe.com: a session's network is open (ADR 0029), so there is no host to override. Override one of: db read <env>, db write <env>, aws read <env>, aws write <env> (environments: test, prod)",
      );
  });

  test('anything else is refused with the list', () => {
    for (const what of [
      'sudo',
      'db write staging',
      'db delete test',
      'network',
      'network not a host!',
    ]) {
      const got = parse(what);

      expect(got.ok).toBe(false);
      if (!got.ok) {
        expect(got.error.code).toBe('not-an-area');
        expect(got.error.message).toContain('db write <env>');
        expect(got.error.message).not.toContain('network <host>');
        expect(got.error.message).toContain('test, prod');
      }
    }
  });

  test('an empty reason is refused', () => {
    const got = parse('db write test', 'cloud', '   ');

    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('no-reason');
  });

  test('a write area on a local session is refused: writes only on a box, Move to cloud', () => {
    const got = parse('db write test', 'local');

    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.error.code).toBe('writes-only-on-box');
      expect(got.error.message).toContain('Move to cloud');
    }
  });
});

describe('the texts', () => {
  const o = parse('db write test');

  if (!o.ok) throw new Error('no override');

  test("the PR note line and the held card's why", () => {
    expect(overrideNote(o.data, '2-a1b2')).toBe(
      '- Override on session 2-a1b2: Test DB write · reason: Seed the shop for the Before check',
    );
    expect(overrideWhy(o.data)).toBe(
      'Reach: Test DB write, overridden for this session: Seed the shop for the Before check',
    );
  });

  test("the PR body's Notes get the line once, after their last bullet", () => {
    const body = [
      'Fix.',
      '',
      '**Verified:** ok',
      '',
      '## Notes',
      '',
      '- One.',
      '',
      '## Later',
      '',
    ].join('\n');
    const note = overrideNote(o.data, '2-a1b2');
    const once = withOverrideNotes(body, [note]);

    expect(once).toBe(
      ['Fix.', '', '**Verified:** ok', '', '## Notes', '', '- One.', note, '', '## Later', ''].join(
        '\n',
      ),
    );
    expect(withOverrideNotes(once, [note])).toBe(once);
  });

  test('a CRLF body is not noted twice; a paragraph after Notes keeps its blank line', () => {
    const note = overrideNote(o.data, 's');

    expect(withOverrideNotes(`## Notes\r\n\r\n${note}\r\n`, [note])).toBe(
      `## Notes\r\n\r\n${note}\r\n`,
    );
    expect(withOverrideNotes('## Notes\nNothing yet.\n', [note])).toBe(
      `## Notes\n\n${note}\n\nNothing yet.\n`,
    );
  });

  test('a body with no Notes gets the section', () => {
    expect(withOverrideNotes('Fix.\n', ['- x'])).toBe('Fix.\n\n## Notes\n\n- x\n');
    expect(withOverrideNotes('Fix.\n', [])).toBe('Fix.\n');
  });
});

describe('inArea: which PermissionRequests an Override holds', () => {
  const db = parse('db write test');

  if (!db.ok) throw new Error('no override');
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

  test("a command naming the area's Reach name or profile", () => {
    expect(inArea(db.data, bash('psql "$ABE_DB_WRITE_URL_TEST" -f seed.sql'))).toBe(true);
    expect(inArea(db.data, bash('psql "$ABE_DB_READ_URL_TEST"'))).toBe(false);
    expect(inArea(db.data, bash('npm test'))).toBe(false);
    const aws = parse('aws write test');

    if (!aws.ok) throw new Error('no override');
    expect(inArea(aws.data, bash('aws s3 cp x s3://b --profile abe-write-test'))).toBe(true);
    expect(inArea(aws.data, bash('aws s3 ls --profile abe-read-test'))).toBe(false);
  });
});
