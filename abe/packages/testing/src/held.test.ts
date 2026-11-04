import { describe, expect, test } from 'bun:test';
import { held } from './held';

describe('held, a fake port whose calls wait for the test', () => {
  test('answers the oldest open call equal to the input', async () => {
    const gh = held<{ repo: string }, string>('gh.pr');
    const first = gh.call({ repo: 'a' });
    const second = gh.call({ repo: 'b' });

    expect(gh.open()).toEqual([{ repo: 'a' }, { repo: 'b' }]);
    gh.resolve({ repo: 'b' }, 'B');
    gh.fail({ repo: 'a' }, new Error('offline'));
    expect(await second).toBe('B');
    expect(first).rejects.toThrow('offline');
    gh.settled();
  });

  test('answering a call nobody made names the open ones', () => {
    const gh = held<string, string>('gh.pr');

    void gh.call('a');
    expect(() => {
      gh.resolve('z', '');
    }).toThrow('No open gh.pr("z"); open: "a"');
    expect(() => {
      gh.settled();
    }).toThrow('gh.pr left open: "a"');
  });
});
