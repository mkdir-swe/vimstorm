/**
 * A browser profile's sign-ins as they travel (#103 S3): the secret's name, which origins' local
 * storage is read, the size limit, the cookie as DevTools sets it, which profile a start uses
 * (the verify-phase rule) and the verify report's header line.
 */
import { describe, expect, test } from 'bun:test';
import {
  agoText,
  browserSecret,
  cookieParam,
  isPageUrl,
  personOfLogins,
  readState,
  runProfile,
  startProfile,
  STATE_MAX_BYTES,
  type StateCookie,
  stateOrigins,
  stateText,
  storageState,
  withProfileLine,
} from './browser-state';

const AT = '2026-10-25T03:00:00.000Z';

const cookie = (o: Partial<StateCookie> = {}): StateCookie => ({
  name: 'sid',
  value: 'v-1',
  domain: 'app.example.test',
  path: '/',
  expires: 1_800_000_000,
  httpOnly: true,
  secure: true,
  session: false,
  sameSite: 'Lax',
  ...o,
});

describe('the secret', () => {
  test('a sibling of the logins: abe/<person>/browser/<name>', () => {
    expect(browserSecret('ada', 'work-admin')).toBe('abe/ada/browser/work-admin');
  });

  test('the person is the logins secret’s, by name or ARN', () => {
    expect(personOfLogins('abe/ada/logins')).toBe('ada');
    expect(
      personOfLogins('arn:aws:secretsmanager:eu-west-1:111111111111:secret:abe/ada/logins-AbCdEf'),
    ).toBe('ada');
    expect(personOfLogins('abe/ada/github-token')).toBeUndefined();
  });
});

describe('the origins whose local storage is read', () => {
  test('https of each cookie domain, http too when not Secure, and the open tabs', () => {
    expect(
      stateOrigins(
        [
          { domain: '.example.test', secure: true },
          { domain: 'legacy.example.test', secure: false },
        ],
        [
          'https://app.example.test/home?x=1',
          'about:blank',
          'chrome://newtab/',
          'http://localhost:3000/a',
        ],
      ),
    ).toEqual([
      'http://legacy.example.test',
      'http://localhost:3000',
      'https://app.example.test',
      'https://example.test',
      'https://legacy.example.test',
    ]);
  });
});

describe('the stored state', () => {
  test('origins with no local storage are left out; it reads back', () => {
    const state = storageState(
      {
        cookies: [cookie()],
        origins: [
          { origin: 'https://app.example.test', localStorage: [{ name: 'token', value: 't' }] },
          { origin: 'https://example.test', localStorage: [] },
        ],
      },
      AT,
    );

    expect(state.origins.map((o) => o.origin)).toEqual(['https://app.example.test']);
    const text = stateText(state);

    expect(text.ok && readState(text.text)).toEqual(state);
    expect(readState('{"v":2}')).toBeUndefined();
    expect(readState('not json')).toBeUndefined();
  });

  test('above the limit it is refused naming the biggest origins, never cut', () => {
    const big = 'x'.repeat(STATE_MAX_BYTES);
    const state = storageState(
      {
        cookies: [cookie()],
        origins: [
          { origin: 'https://big.example.test', localStorage: [{ name: 'cache', value: big }] },
          { origin: 'https://small.example.test', localStorage: [{ name: 'k', value: 'v' }] },
        ],
      },
      AT,
    );
    const text = stateText(state);

    expect(text.ok).toBe(false);
    if (text.ok) return;
    expect(text.message).toStartWith('the sign-ins are 61 KB, more than a secret holds (60 KB): ');
    expect(text.message).toContain('local storage of https://big.example.test 61 KB');
    expect(text.message).not.toContain(big.slice(0, 50));
  });
});

describe('a cookie as DevTools sets it', () => {
  test('a session cookie has no expires; the rest is kept', () => {
    expect(cookieParam(cookie({ session: true, expires: -1 }))).toEqual({
      name: 'sid',
      value: 'v-1',
      domain: 'app.example.test',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
    expect(
      cookieParam(
        cookie({
          partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false },
        }),
      ),
    ).toMatchObject({
      expires: 1_800_000_000,
      partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false },
    });
  });
});

describe('which profile a start uses', () => {
  test.each([
    // asked, the session's, verifying → the profile or the refusal
    [undefined, undefined, false, 'default'],
    [undefined, 'work-admin', false, 'work-admin'],
    [undefined, 'work-admin', true, 'work-admin'],
    ['work-admin', 'work-admin', true, 'work-admin'],
    ['work', 'work-admin', false, 'work'],
    ['work', 'work-admin', true, 'profile-differs-from-before'],
    ['work', undefined, true, 'profile-differs-from-before'],
  ] as const)(
    'asked %p in a session on %p, verifying %p: %p',
    (asked, session, verifying, want) => {
      const r = startProfile({ asked, session, verifying });

      expect(r.ok ? r.profile : r.code).toBe(want);
    },
  );
});

describe("the verify report's header", () => {
  test('names the profile under the title, once', () => {
    const report = '# Verify after: AB#7 Pay\n\nLevel: After · card/7 abc1234\n\nResult: pass\n';

    expect(withProfileLine(report, 'work-admin')).toBe(
      '# Verify after: AB#7 Pay\n\nBrowser profile: work-admin\n\nLevel: After · card/7 abc1234\n\nResult: pass\n',
    );
    expect(withProfileLine(withProfileLine(report, 'work'), 'work-admin')).toBe(
      withProfileLine(report, 'work-admin'),
    );
    expect(withProfileLine('Result: pass\n', 'default')).toBe(
      'Browser profile: default\n\nResult: pass\n',
    );
  });
});

describe('how old a stored copy is', () => {
  test.each([
    [0, 'just now'],
    [5 * 60_000, '5 minutes ago'],
    [3_600_000, '1 hour ago'],
    [2 * 86_400_000 + 5, '2 days ago'],
  ])('%p ms: %p', (ms, text) => {
    expect(agoText(AT, Date.parse(AT) + ms)).toBe(text);
  });
});

describe('the profile a launch runs in', () => {
  const profiles = [{ name: 'work' }, { name: 'work-admin' }];

  test.each([
    // asked, browser.default → the profile or the refusal
    [undefined, null, 'default'],
    [undefined, 'work', 'work'],
    ['work-admin', 'work', 'work-admin'],
    ['default', 'work', 'default'],
    ['nope', null, 'no-profile'],
    [undefined, 'gone', 'no-profile'],
  ] as const)('asked %p, browser.default %p: %p', (asked, fallback, want) => {
    const r = runProfile({ profiles, fallback, asked });

    expect(r.ok ? r.name : r.code).toBe(want);
  });

  test('a page to open: http, https or file', () => {
    expect(
      ['https://a.test/x', 'http://localhost:3000', 'file:///tmp/a.html', '/tmp/a.html'].every(
        isPageUrl,
      ),
    ).toBe(true);
    expect(['javascript:alert(1)', 'about:blank', 'https://a.test/ x'].some(isPageUrl)).toBe(false);
  });
});
