/** #222, ADR 0030: yours as a cloud launch hands it to the box. */
import { describe, expect, test } from 'bun:test';
import { handedLayer } from './personal';

describe('handedLayer', () => {
  test("yours on this Mac and yours for the repo, but this Mac's alone", () => {
    const machine = {
      ui: { feel: 'vim' },
      box: { idleMinutes: 45 },
      overrides: { 'box.profile': { value: 'home', reason: 'mine' } },
    };
    const local = {
      'logins.gh': 'me-work',
      board: { azureConfigDir: '/az/work', project: 'P' },
      // this Mac's env files and TEST yes (ADR 0027): never handed
      credentials: { test: { awsProfile: 'shop-test', envFile: '.env.test' } },
      testWrites: true,
      overrides: {
        autoMerge: { value: true, reason: 'my sandbox' },
        credentials: { value: {}, reason: 'x' },
      },
    };

    expect(handedLayer(machine, local)).toEqual({
      machine: {
        ui: { feel: 'vim' },
        box: { idleMinutes: 45 },
        overrides: { 'box.profile': { value: 'home', reason: 'mine' } },
      },
      local: {
        'logins.gh': 'me-work',
        board: { project: 'P' },
        overrides: { autoMerge: { value: true, reason: 'my sandbox' } },
      },
    });
  });

  test('none, or a file that is no map, hands nothing', () => {
    expect(handedLayer(undefined, ['x'])).toEqual({ machine: {}, local: {} });
  });
});
