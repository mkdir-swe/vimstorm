/**
 * The Settings dialog's samples. `SETTINGS_RULES` are its rules as the bridge builds them. Core
 * makes the `abe settings list` and `abe settings problems` answers from the demo shop's settings
 * files (ADR 0030). The repo's allows opus and sonnet, sets the largest box and its disk, and
 * lowers auto merge with no reason. Yours on this Mac closes Chat by default.
 */
import {
  type KnownChoices,
  type LayerSource,
  listSettings,
  mergeSettings,
  personalOverrides,
  type SettingsListData,
  type SettingsProblemsData,
  settingsDialogRules,
  settingsProblems,
  settingsScope,
  toolCheck,
} from '@abe/core';
import { parseYaml } from '@abe/ports';
import { type Answer } from '@abe/ui';

export const SETTINGS_RULES = settingsDialogRules(parseYaml);

/** The demo shop's own file, `abe.yaml`. */
export const DEMO_REPO_FILE = '/work/demo-shop/abe.yaml';
/** Yours for the demo shop, `.abe/settings.local.yaml`. */
export const DEMO_LOCAL_FILE = '/work/demo-shop/.abe/settings.local.yaml';
/** Yours on this Mac. */
export const DEMO_MACHINE_FILE = '/home/me/.config/abe/settings.yaml';

/** What the repo's file sets besides its Override. */
const REPO_DOC = {
  allowedModels: ['opus', 'sonnet'],
  limits: { maxBoxSize: 'm8g.xlarge', maxBoxDisk: 300 },
  effort: 'medium',
};
const MACHINE: LayerSource = {
  place: 'machine',
  file: DEMO_MACHINE_FILE,
  doc: { chat: { openByDefault: false } },
};

export const DEMO_LAYERS: readonly LayerSource[] = [
  {
    place: 'repo',
    file: DEMO_REPO_FILE,
    doc: { ...REPO_DOC, overrides: { autoMerge: { value: true, reason: '' } } },
  },
  MACHINE,
];

/** What serve knows on the demo Mac: two gh logins, two AWS profiles and a region they name. */
export const DEMO_KNOWN: KnownChoices = {
  gh: ['octo-dev', 'octo-bot'],
  awsProfiles: ['demo-dev', 'demo-tooling'],
  awsRegions: ['eu-north-1'],
};

/** `abe settings list`'s data over these Layers. */
export const settingsList = (layers: readonly LayerSource[] = DEMO_LAYERS): SettingsListData =>
  listSettings(mergeSettings(layers), undefined, DEMO_KNOWN);

/** `abe settings problems`' data: the expired AWS SSO login and a missing node, then the merge's. */
export const settingsProblemsData = (
  layers: readonly LayerSource[] = DEMO_LAYERS,
  checks = true,
): SettingsProblemsData => {
  const merged = mergeSettings(layers);
  const scope = settingsScope(merged);

  return {
    problems: settingsProblems({
      settings: merged.problems,
      ...(checks
        ? {
            awsSso: { session: 'abe', state: 'expired' },
            tools: [toolCheck('node', { found: false }, false)],
          }
        : {}),
      overrides: personalOverrides(merged),
      scope: { repo: scope.repo, home: '/home/me' },
    }),
    checked: { logins: checks, tools: checks },
  };
};

export const settingsListAnswer = (id: string, data = settingsList()): Answer => ({
  kind: 'result',
  id,
  command: 'settings list',
  reply: { ok: true, data },
});

export const settingsProblemsAnswer = (id: string, data = settingsProblemsData()): Answer => ({
  kind: 'result',
  id,
  command: 'settings problems',
  reply: { ok: true, data },
});

/** The demo files without the reasonless Override. With no checks failing, nothing is wrong. */
export const CLEAN_LAYERS: readonly LayerSource[] = [
  { place: 'repo', file: DEMO_REPO_FILE, doc: REPO_DOC },
  MACHINE,
];

/** No problems, and your own Override of auto merge, which shows as an info row on Problems. */
export const OVERRIDE_LAYERS: readonly LayerSource[] = [
  ...CLEAN_LAYERS,
  {
    place: 'local',
    file: DEMO_LOCAL_FILE,
    doc: {
      overrides: {
        autoMerge: { value: true, reason: 'my sandbox', since: '2026-10-24T09:30:00.000Z' },
      },
    },
  },
];

/** The demo files with the repo's environments and a view tweak of yours: records rows to edit. */
export const RECORDS_LAYERS: readonly LayerSource[] = [
  {
    place: 'repo',
    file: DEMO_REPO_FILE,
    doc: {
      ...REPO_DOC,
      environments: {
        test: {
          account: '111111111111',
          region: 'eu-north-1',
          db: { read: { secret: 'demo/test-read' } },
        },
        prod: { account: '222222222222', writePolicy: 'policies/prod-write.json' },
      },
    },
  },
  {
    ...MACHINE,
    doc: {
      chat: { openByDefault: false },
      views: [{ screen: 'factory', node: 'col:Closed', hide: true }],
    },
  },
];
