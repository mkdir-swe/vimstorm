/** What a Factory run keeps of the Overrides in force (#168): never one of a setting it does not read. */
import { describe, expect, test } from 'bun:test';
import { type LayerSource } from '@abe/core';
import { fixedSettings, runOverridesIn, type SettingsService } from './settings';

const repoFile = (doc: unknown): LayerSource => ({
  place: 'repo',
  file: '/repo/abe.yaml',
  doc,
});

const yoursForRepo = (doc: unknown): LayerSource => ({
  place: 'local',
  file: '/repo/.abe/settings.local.yaml',
  doc,
});

const service = (sources: LayerSource[]): SettingsService =>
  fixedSettings({ configDir: '/me', home: '/home' }, sources);

describe('runOverridesIn', () => {
  test("your session.mcp Override is no fact of a Factory run (it loads Abe's servers alone); autoMerge is", () => {
    const run = runOverridesIn(
      service([
        repoFile({ session: { mcp: 'abe-only' } }),
        yoursForRepo({
          overrides: {
            'session.mcp': { value: 'yours', reason: 'my tracker MCP' },
            autoMerge: { value: true, reason: 'my sandbox' },
          },
        }),
      ]),
      '/repo',
    );

    expect(run.keys).toEqual(['autoMerge']);
    expect(run.personal.map((o) => o.key)).toEqual(['autoMerge']);
  });
});
