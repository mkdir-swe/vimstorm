/** Verification's browser's rows of the command table: `abe browser`. */
import { command } from '../command';
import { PROFILE_FLAG } from '../session';
import { BrowserData, browserText } from './browser';
import { BrowserListData, BrowserWriteData, browserListText } from './browser-profiles';
import {
  BrowserOpenData,
  BrowserStoreData,
  browserOpenText,
  browserStoreText,
} from './browser-state';

export const BROWSER_COMMANDS = {
  'browser start': command({
    noun: 'browser',
    verb: 'start',
    summary:
      "in a workspace or a local Factory run: start the session's headless browser (one per session) for its chrome-devtools tools, in the run's browser profile (its sign-ins restored) unless --profile names another",
    inSession: true,
    inWorkspace: 'socket',
    args: {
      profile: PROFILE_FLAG(
        "the browser profile to start in (default: the session's, as its launch named it); while the run verifies, only its own",
      ),
    },
    result: BrowserData,
    text: browserText,
  }),
  'browser stop': command({
    noun: 'browser',
    verb: 'stop',
    summary:
      "in a workspace or a local Factory run: stop the session's browser (it also stops after 10 minutes with no activity)",
    inSession: true,
    inWorkspace: 'socket',
    args: {},
    result: BrowserData,
    text: browserText,
  }),
  'browser status': command({
    noun: 'browser',
    verb: 'status',
    summary:
      "in a workspace or a local Factory run: whether the session's browser runs, and its DevTools endpoint",
    inSession: true,
    inWorkspace: 'socket',
    args: {},
    result: BrowserData,
    text: browserText,
  }),
  'browser list': command({
    noun: 'browser',
    verb: 'list',
    summary:
      "the browser profiles a verify step can name: the team's shared ones, then yours, then the built-in default (empty); locally, 1.0's two Chromes become work and work-admin the first time",
    inSession: false,
    args: {},
    result: BrowserListData,
    text: browserListText,
  }),
  'browser add': command({
    noun: 'browser',
    verb: 'add',
    summary: 'add a browser profile of yours (your Layer)',
    inSession: false,
    args: {
      name: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the profile: a-z, 0-9 and -',
      },
      purpose: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: "one line: app user, admin, product owner's login",
      },
    },
    result: BrowserWriteData,
    says: 'done',
  }),
  'browser rename': command({
    noun: 'browser',
    verb: 'rename',
    summary:
      "rename a browser profile of yours (its Chrome folder moves with it); the repo's is proposed",
    inSession: false,
    args: {
      old: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the profile: a-z, 0-9 and -',
      },
      new: { kind: 'positional', type: 'string', required: true, summary: 'its new name' },
    },
    result: BrowserWriteData,
    says: 'done',
  }),
  'browser remove': command({
    noun: 'browser',
    verb: 'remove',
    summary:
      'remove a browser profile of yours from your Layer; its Chrome folder stays unless --forget',
    inSession: false,
    risky: true,
    args: {
      name: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the profile: a-z, 0-9 and -',
      },
      forget: {
        kind: 'flag',
        type: 'boolean',
        summary: 'also delete its Chrome folder on this machine',
      },
    },
    result: BrowserWriteData,
    says: 'done',
  }),
  'browser default': command({
    noun: 'browser',
    verb: 'default',
    summary:
      'the profile a run verifies in when it names none (your Layer); none: the built-in default',
    inSession: false,
    args: {
      name: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'a profile, or none',
      },
    },
    result: BrowserWriteData,
    says: 'done',
  }),
  'browser open': command({
    noun: 'browser',
    verb: 'open',
    summary:
      "locally: the profile's Chrome on its own folder (a tab per URL), where you sign in once before abe browser store",
    inSession: false,
    args: {
      name: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the profile: a-z, 0-9 and -',
      },
      urls: {
        kind: 'positional',
        type: 'string',
        repeats: true,
        summary: 'pages to open (http, https or file)',
      },
      front: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'in front of the window in front; an open one with no pages named is brought to the front',
      },
    },
    result: BrowserOpenData,
    text: browserOpenText,
  }),
  'browser store': command({
    noun: 'browser',
    verb: 'store',
    summary:
      "locally: store the sign-ins of the profile's open Chrome (cookies, local storage) in your secret abe/<person>/browser/<name>, which your boxes restore",
    inSession: false,
    args: {
      name: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the profile: a-z, 0-9 and -',
      },
    },
    result: BrowserStoreData,
    text: browserStoreText,
  }),
};
