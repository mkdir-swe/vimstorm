/** The Layers' rows of the command table: `abe settings`, `reach` and `session override`. */
import { command } from '../command';
import { SessionOverrideData, sessionOverrideText } from './override';
import {
  REACH_TARGETS,
  ReachCheckData,
  ReachCredsData,
  ReachEnvData,
  ReachProfilesData,
  reachCheckText,
  reachCredsText,
  reachEnvText,
} from './reach';
import {
  FeelSwitches,
  SettingExplainData,
  SettingGetData,
  SettingSetData,
  SettingsCheckData,
  SettingsListData,
  SettingsProblemsData,
  SettingsProposeData,
  feelText,
  settingExplainText,
  settingGetText,
  settingSetText,
  settingUnsetText,
  settingsCheckText,
  settingsListText,
  settingsProblemsText,
  settingsProposeText,
} from './settings';

/** The session an Override is for (session's own rows name it the same way). */
const SESSION_ID_ARG = {
  kind: 'positional',
  type: 'string',
  required: true,
  summary: 'the session: its id (`4-a1b2`)',
} as const;

const TARGET = {
  kind: 'flag',
  type: 'string',
  values: REACH_TARGETS,
  required: true,
  summary: 'where the session runs: cloud gets the granted writes, local never',
} as const;

export const LAYER_COMMANDS = {
  'settings get': command({
    noun: 'settings',
    verb: 'get',
    summary: "a setting's value, merged across the Layers core, repo and yours",
    inSession: true,
    args: { key: { kind: 'positional', type: 'string', required: true, summary: 'the setting' } },
    result: SettingGetData,
    text: settingGetText,
  }),
  'settings explain': command({
    noun: 'settings',
    verb: 'explain',
    summary: "where a setting's value comes from: each Layer's value, the winner, any Override",
    inSession: true,
    args: { key: { kind: 'positional', type: 'string', required: true, summary: 'the setting' } },
    result: SettingExplainData,
    text: settingExplainText,
  }),
  'settings set': command({
    noun: 'settings',
    verb: 'set',
    summary:
      "write a setting into one file: the repo's (--repo) or yours for this repo (--mine); an editor preference into yours on this machine. Lowering an upper value takes an Override",
    inSession: false,
    args: {
      key: { kind: 'positional', type: 'string', required: true, summary: 'the setting' },
      value: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'its value, as YAML (`true`, `3`, `[a, b]`) or text',
      },
      repo: {
        kind: 'flag',
        type: 'boolean',
        summary: "the repo's abe.yaml (committed when the install is Connected)",
      },
      mine: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'yours for this repo: .abe/settings.local.yaml, never committed (the default for a factory setting)',
      },
      override: {
        kind: 'flag',
        type: 'boolean',
        summary: 'write it as an Override of the value above (needs --reason)',
      },
      reason: { kind: 'flag', type: 'string', summary: "the Override's reason, shown as lowered" },
      here: { kind: 'flag', type: 'boolean', summary: 'the same as --mine' },
    },
    result: SettingSetData,
    text: settingSetText,
  }),
  'settings unset': command({
    noun: 'settings',
    verb: 'unset',
    summary:
      'take a setting out of one file (plain or Override), so the value above stands there again',
    inSession: false,
    args: {
      key: { kind: 'positional', type: 'string', required: true, summary: 'the setting' },
      repo: { kind: 'flag', type: 'boolean', summary: "the repo's abe.yaml" },
      mine: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'yours for this repo: .abe/settings.local.yaml (the default for a factory setting)',
      },
      here: { kind: 'flag', type: 'boolean', summary: 'the same as --mine' },
    },
    result: SettingSetData,
    text: settingUnsetText,
  }),
  'settings check': command({
    noun: 'settings',
    verb: 'check',
    summary:
      'check the settings files in a folder (a checkout, or your config folder); exit 1 on any problem',
    inSession: true,
    args: {
      dir: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the folder, or one settings file',
      },
    },
    result: SettingsCheckData,
    text: settingsCheckText,
  }),
  'settings list': command({
    noun: 'settings',
    verb: 'list',
    summary:
      'every row of Settings: the value in effect, where it comes from (built-in, Repo, Yours, fixed), what yours differs from, choices greyed and why',
    waits: 'GitHub for the open proposals (gh)',
    inSession: true,
    args: {
      filesOnly: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'only what the settings in force say, at once: no open proposals, no gh accounts (Settings opens on it, then reads the rest)',
      },
    },
    result: SettingsListData,
    text: settingsListText,
  }),
  'settings problems': command({
    noun: 'settings',
    verb: 'problems',
    summary:
      'what Settings lists first, worst first: logins, tools, Overrides without a reason, Layer files that do not read, settings the merge dropped; each with its fix or the row to open',
    inSession: false,
    args: {
      filesOnly: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'only what the settings in force say, at once: no login, tool or Docker check (Settings opens on it, then reads the rest)',
      },
    },
    result: SettingsProblemsData,
    text: settingsProblemsText,
  }),
  'settings propose': command({
    noun: 'settings',
    verb: 'propose',
    summary:
      'propose a setting for the repo: one pull request on its abe.yaml (the default branch, no checkout touched), the reason its first line; a second proposal of the same setting updates it',
    waits: "GitHub: reading the repo's file and opening the pull request (gh)",
    inSession: false,
    args: {
      key: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the setting, or <key>#<field> for one field of it (board#done)',
      },
      value: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'its value, as YAML (`true`, `3`, `[a, b]`) or text',
      },
      reason: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: "why, for the repo's people to read: the pull request's first line",
      },
    },
    result: SettingsProposeData,
    text: settingsProposeText,
  }),
  'settings feel': command({
    noun: 'settings',
    verb: 'feel',
    summary:
      'the Feel in force (vimstorm, webstorm, vscode or vim) and the behaviour switches the shell honours: each one the Feel’s value unless a Layer writes it',
    inSession: true,
    args: {},
    result: FeelSwitches,
    text: feelText,
  }),
  'reach env': command({
    noun: 'reach',
    verb: 'env',
    summary: 'the ABE_* names a session gets in this repo, and their values',
    // It holds database URLs a session was not given (a cloud one's writes): never from inside.
    inSession: false,
    inWorkspace: 'session',
    args: { target: TARGET },
    result: ReachEnvData,
    text: reachEnvText,
  }),
  'reach profiles': command({
    noun: 'reach',
    verb: 'profiles',
    summary: 'AWS config text: one profile per AWS name, its credentials from abe reach creds',
    inSession: true,
    inWorkspace: 'session',
    args: { target: TARGET },
    result: ReachProfilesData,
    says: 'config',
  }),
  'reach creds': command({
    noun: 'reach',
    verb: 'creds',
    summary:
      "an AWS profile's credential_process: the environment's abe-read or abe-write role, as you",
    // The AWS CLI inside a session calls it for every AWS name's profile.
    inSession: true,
    inWorkspace: 'session',
    args: {
      env: { kind: 'positional', type: 'string', required: true, summary: 'the environment' },
      access: {
        kind: 'positional',
        type: 'string',
        values: ['read', 'write'],
        required: true,
        summary: 'read, or write (granted only by an Override)',
      },
    },
    result: ReachCredsData,
    text: reachCredsText,
  }),
  'reach check': command({
    noun: 'reach',
    verb: 'check',
    summary:
      "check a checkout's Reach (abe.yaml): names, environments, Overrides; exit 1 on any problem",
    inSession: true,
    args: {
      dir: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the checkout',
      },
    },
    result: ReachCheckData,
    text: reachCheckText,
  }),
  'session override': command({
    noun: 'session',
    verb: 'override',
    summary:
      'lower one limit for this session only, with a reason: tracked on the story and the pull request',
    // Only a person lowers a limit, never the agent it binds.
    inSession: false,
    args: {
      id: SESSION_ID_ARG,
      what: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'the area: db write <env>, aws write <env>, or their read forms',
      },
      reason: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'why: kept with it, on the story and in the pull request',
      },
    },
    result: SessionOverrideData,
    text: sessionOverrideText,
  }),
};
