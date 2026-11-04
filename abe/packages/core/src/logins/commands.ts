/** Logins' rows of the command table: `abe login`. */
import { command } from '../command';
import {
  LOGIN_TOOLS,
  LoginData,
  LoginRestoreData,
  LoginStatusData,
  loginRestoreText,
  loginStatusText,
  loginText,
} from './logins';

export const LOGIN_COMMANDS = {
  login: command({
    noun: 'login',
    summary:
      "sign in to a tool with its own device or browser login (it prints the URL and code to open locally), then store it in your login secret: on a box; az and aws also locally, for your boxes; on a local machine with no boxes the tool's own login alone, no aws",
    inSession: false,
    // The tool's own login runs in the client's terminal.
    only: 'client',
    args: {
      tool: {
        kind: 'positional',
        type: 'string',
        values: LOGIN_TOOLS,
        required: true,
        summary: 'the tool: github, claude, az or aws',
      },
      tenant: {
        kind: 'flag',
        type: 'string',
        summary: 'az only: the Entra tenant (id or domain) to sign in to',
      },
      profile: {
        kind: 'flag',
        type: 'string',
        summary:
          "aws only: the SSO profile to sign in to (a repo's logins: names it); locally it is stored for your boxes",
      },
    },
    result: LoginData,
    text: loginText,
  }),
  'login status': command({
    noun: 'login',
    verb: 'status',
    summary:
      'each login (github, claude, az) here: ok, expired, missing or unchecked (its tool could not run), and the secret keeping them; with --repo, the logins its logins: names (aws for its profile) and which are missing',
    // A Factory install's agent checks the repo's logins (never reads one).
    inSession: true,
    args: {
      repo: {
        kind: 'flag',
        type: 'string',
        summary: "a checkout: report against its logins: (its abe.yaml and the Layers')",
      },
    },
    result: LoginStatusData,
    text: loginStatusText,
  }),
  'login restore': command({
    noun: 'login',
    verb: 'restore',
    summary:
      'put your stored logins where their tools read them (a box does on start); a newer one here is kept and stored',
    inSession: false,
    args: {},
    result: LoginRestoreData,
    text: loginRestoreText,
  }),
};
