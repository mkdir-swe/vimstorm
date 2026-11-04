import { describe, expect, test } from 'bun:test';
import { readRequest } from '.';

describe('a request line: v1 is read, anything else is refused with why', () => {
  test('a v1 request', () => {
    expect(readRequest('{"v":1,"argv":["status"],"cwd":"/"}')).toEqual({
      ok: true,
      request: { v: 1, argv: ['status'], cwd: '/' },
    });
  });

  test('any other v is unsupported-version', () => {
    const read = readRequest('{"v":2,"argv":["status","--json"],"cwd":"/"}');

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reply.exit).toBe(1);
    expect(read.reply.error?.code).toBe('unsupported-version');
    expect(JSON.parse(read.reply.stdout)).toMatchObject({
      ok: false,
      error: { code: 'unsupported-version' },
    });
  });

  test.each([
    ['not json', 'bad-request'],
    ['[1]', 'bad-request'],
    ['{"argv":["status"],"cwd":"/"}', 'unsupported-version'],
    ['{"v":2,"argv":[1]}', 'unsupported-version'],
    ['{"v":1,"argv":"status","cwd":"/"}', 'bad-request'],
  ])('%s is refused with %s', (line, code) => {
    const read = readRequest(line);

    expect(read.ok ? undefined : read.reply.error?.code).toBe(code);
  });
});
