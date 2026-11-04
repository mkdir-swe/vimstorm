import { describe, expect, test } from 'bun:test';
import {
  commandIds,
  COMMANDS,
  dispatch,
  envelope,
  type Handlers,
  help,
  HelpData,
  inSessionRules,
} from '.';
import { localWhen } from '../command';

const STATUS = {
  version: '2.0.0-test',
  pid: 42,
  startedAt: '2026-10-01T09:00:00.000Z',
  socket: '/tmp/abe.sock',
  sessions: 0,
  workspaces: 0,
};

const handlers: Partial<Handlers<null>> = {
  help: (args) => Promise.resolve(help(args.command)),
  serve: () => Promise.resolve({ ok: false, error: { code: 'serve-running', message: 'running' } }),
  'serve stop': () => Promise.resolve({ ok: true, data: { stopped: true, pid: 42 } }),
  status: () => Promise.resolve({ ok: true, data: STATUS }),
  watch: () => Promise.resolve({ ok: false, error: { code: 'streams', message: 'a stream' } }),
};

/** In one order, whatever the table's: a list's members, not their place. */
const sorted = <T>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const run = (argv: string[], caller: 'user' | 'session' = 'user') =>
  dispatch(argv, handlers, null, caller);

describe('the command table', () => {
  test('each key is its noun and verb', () => {
    for (const id of commandIds()) {
      const def = COMMANDS[id];

      expect([def.noun, 'verb' in def ? def.verb : undefined].filter(Boolean).join(' ')).toBe(id);
    }
  });

  test("help names what Command mode leaves out (a session's own steps, the client's) and what it asks first", () => {
    const listed = help([]);

    if (!listed.ok) throw new Error(listed.error.message);
    const named = (c: { noun: string; verb: string | null }) =>
      c.verb === null ? c.noun : `${c.noun} ${c.verb}`;
    const where = (only: 'session' | 'client' | 'shell') =>
      listed.data.commands.filter((c) => c.only === only).map(named);

    const session = [
      'factory stage-done',
      'factory judge',
      'factory review',
      'factory verify',
      'factory base-worktree',
      'factory needs-you',
      'factory pr',
      'hook',
    ];

    expect(sorted(where('session'))).toEqual(sorted(session));
    const client = [
      'serve',
      'session attach',
      'login',
      'fresh',
      'watch',
      'ui render',
      'ui bridge',
      'box attach',
      'box forward',
      'port pipe',
    ];

    expect(sorted(where('client'))).toEqual(sorted(client));
    // VimStorm's Git Log review and Create Draft PR, over the bridge
    const shell = [
      'review show',
      'review drafts',
      'review mark',
      'review draft',
      'review edit-draft',
      'review drop-draft',
      'review submit',
      'review reply',
      'review resolve',
      'review prs',
      'review pr',
      'review open',
      'review say',
      'review ready',
      'review close',
      'pr draft-plan',
      'pr draft-create',
    ];

    expect(sorted(where('shell'))).toEqual(sorted(shell));
    const risky = [
      'serve stop',
      'pr merge',
      'local merge',
      'board discard',
      'pipeline cancel',
      'pipeline approve',
      'browser remove',
      'session stop',
      'session revert',
      'prototype discard',
      'box terminate',
      'review close',
    ];

    expect(sorted(listed.data.commands.filter((c) => c.risky).map(named))).toEqual(sorted(risky));
  });

  test('help --json lists every command with its usage and arguments', async () => {
    const out = await run(['help', '--json']);
    const doc = envelope(HelpData).parse(JSON.parse(out.stdout));

    expect(out.exit).toBe(0);
    if (!doc.ok) throw new Error(doc.error.message);
    const { data } = doc;

    const rows = [
      ['help', null, 'abe help [command…] [--json]', true],
      ['serve', null, 'abe serve [--json]', false],
      ['serve', 'stop', 'abe serve stop [--json]', false],
      ['status', null, 'abe status [--json]', true],
      ['settings', 'get', 'abe settings get <key> [--json]', true],
      ['settings', 'explain', 'abe settings explain <key> [--json]', true],
      [
        'settings',
        'set',
        'abe settings set <key> <value> [--repo] [--mine] [--override] [--reason <reason>] [--here] [--json]',
        false,
      ],
      ['settings', 'unset', 'abe settings unset <key> [--repo] [--mine] [--here] [--json]', false],
      ['settings', 'check', 'abe settings check <dir> [--json]', true],
      ['settings', 'list', 'abe settings list [--files-only] [--json]', true],
      ['workflow', 'list', 'abe workflow list [--repo <repo>] [--json]', true],
      ['workflow', 'path', 'abe workflow path <file> [--repo <repo>] [--json]', true],
      ['workflow', 'tree', 'abe workflow tree [--repo <repo>] [--json]', false],
      [
        'workflow',
        'update',
        'abe workflow update [name…] [--write] [--repo <repo>] [--json]',
        false,
      ],
      [
        'workflow',
        'read',
        'abe workflow read <file> [--text <text>] [--repo <repo>] [--json]',
        true,
      ],
      ['workflow', 'copy', 'abe workflow copy <file> [--repo <repo>] [--json]', false],
      [
        'workflow',
        'propose',
        'abe workflow propose <file> --why <why> [--repo <repo>] [--json]',
        false,
      ],
      [
        'workflow',
        'change',
        'abe workflow change <file> <wish…> [--text <text>] [--write] [--repo <repo>] [--json]',
        false,
      ],
      ['workflow', 'retro', 'abe workflow retro <file> [--repo <repo>] [--json]', false],
      ['settings', 'problems', 'abe settings problems [--files-only] [--json]', false],
      [
        'settings',
        'propose',
        'abe settings propose <key> <value> --reason <reason> [--json]',
        false,
      ],
      ['settings', 'feel', 'abe settings feel [--json]', true],
      [
        'settings',
        'import',
        'abe settings import <source> [--dry-run] [--only <only>] [--json]',
        false,
      ],
      ['tools', 'check', 'abe tools check [--json]', false],
      ['demo', 'new', 'abe demo new [folder] [--name <name>] [--json]', false],
      ['theme', 'list', 'abe theme list [--json]', true],
      ['theme', 'show', 'abe theme show <theme> [--json]', true],
      ['theme', 'look', 'abe theme look [--stage <stage>] [--json]', true],
      [
        'theme',
        'save',
        'abe theme save <theme> [--tokens <tokens>] [--name <name>] [--replace] [--json]',
        false,
      ],
      ['reach', 'env', 'abe reach env --target cloud|local [--json]', false],
      ['reach', 'profiles', 'abe reach profiles --target cloud|local [--json]', true],
      ['reach', 'creds', 'abe reach creds <env> <access> [--json]', true],
      ['reach', 'check', 'abe reach check <dir> [--json]', true],
      ['issue', 'show', 'abe issue show <ref> [--json]', true],
      [
        'issue',
        'create',
        'abe issue create --repo <repo> --title <title> --body-file <body-file> [--label <label>…] [--parent <parent>] [--json]',
        true,
      ],
      ['pr', 'show', 'abe pr show <ref> [--json]', true],
      [
        'pr',
        'create',
        'abe pr create --repo <repo> --head <head> --base <base> --title <title> --body-file <body-file> [--draft] [--json]',
        true,
      ],
      [
        'pr',
        'update',
        'abe pr update <ref> --body-file <body-file> [--title <title>] [--json]',
        true,
      ],
      [
        'pr',
        'merge',
        'abe pr merge <ref> [--method merge|squash|rebase] [--sha <sha>] [--json]',
        false,
      ],
      ['local', 'status', 'abe local status [--json]', true],
      ['local', 'on', 'abe local on [--json]', false],
      ['local', 'off', 'abe local off [--json]', false],
      ['local', 'merge', 'abe local merge <pr> [--json]', false],
      ['local', 'discard', 'abe local discard <pr> [--json]', false],
      ['board', 'read-only', 'abe board read-only <state> [--json]', true],
      ['board', 'discard', 'abe board discard [--json]', false],
      ['compose', null, 'abe compose --cwd <cwd> [args…] [--json]', true],
      [
        'deploy',
        'status',
        'abe deploy status --repo <repo> --sha <sha> --env <env> [--json]',
        true,
      ],
      ['card', 'list', 'abe card list [--mine] [--closed] [--json]', true],
      ['card', 'show', 'abe card show <id> [--json]', true],
      ['card', 'images', 'abe card images <url…> [--json]', false],
      [
        'card',
        'comment',
        'abe card comment <id> [--text <text>] [--body-file <body-file>] [--json]',
        true,
      ],
      ['card', 'tag', 'abe card tag <id> [--add <add>…] [--remove <remove>…] [--json]', true],
      ['card', 'move', 'abe card move <id> <state…> [--json]', true],
      ['card', 'assign', 'abe card assign <id> <who> [--json]', false],
      ['card', 'members', 'abe card members [--json]', true],
      ['card', 'checkout', 'abe card checkout <id> [--repo <repo>] [--json]', false],
      [
        'card',
        'create',
        'abe card create --title <title> [--parent <parent>] [--type <type>] [--state <state>] [--assign me|none] [--sprint current|none] [--description <description>] [--description-file <description-file>] [--criteria <criteria>] [--criteria-file <criteria-file>] [--json]',
        true,
      ],
      [
        'card',
        'draft',
        'abe card draft <words…> [--session <session>] [--earlier <earlier>] [--json]',
        false,
      ],
      [
        'story',
        'linked',
        'abe story linked <id> [--part card|run|spec|pr|pipelines|box] [--json]',
        false,
      ],
      [
        'pipeline',
        'list',
        'abe pipeline list [--repo <repo>] [--limit <limit>] [--workflow <workflow>] [--page <page>] [--json]',
        true,
      ],
      [
        'pipeline',
        'workflows',
        'abe pipeline workflows [--ref <ref>] [--repo <repo>] [--json]',
        true,
      ],
      [
        'pipeline',
        'run',
        'abe pipeline run <workflow> [--ref <ref>] [--input <input>…] [--repo <repo>] [--json]',
        false,
      ],
      ['pipeline', 'show', 'abe pipeline show <run> [--repo <repo>] [--json]', true],
      [
        'pipeline',
        'inspect',
        'abe pipeline inspect <run> [--repo <repo>] [--attempt <attempt>] [--json]',
        true,
      ],
      ['pipeline', 'log', 'abe pipeline log <run> --job <job> [--repo <repo>] [--json]', true],
      [
        'pipeline',
        'rerun',
        'abe pipeline rerun <run> --attempt <attempt> [--failed] [--repo <repo>] [--json]',
        false,
      ],
      [
        'pipeline',
        'cancel',
        'abe pipeline cancel <run> --attempt <attempt> [--repo <repo>] [--json]',
        false,
      ],
      [
        'pipeline',
        'approve',
        'abe pipeline approve <run> --environment <environment> [--yes] [--repo <repo>] [--json]',
        false,
      ],
      [
        'pipeline',
        'fix',
        'abe pipeline fix <run> [--card <card>] [--job <job>] [--evidence <evidence>] [--artifact <artifact>…] [--message <message>] [--repo <repo>] [--json]',
        false,
      ],
      [
        'sheet',
        'save',
        'abe sheet save --title <title> [--card <card>] [--session <session>] --file <file> [--json]',
        true,
      ],
      ['sheet', 'list', 'abe sheet list [--card <card>] [--session <session>] [--json]', true],
      [
        'sheet',
        'find',
        'abe sheet find <name…> [--card <card>] [--session <session>] [--json]',
        true,
      ],
      ['sheet', 'show', 'abe sheet show <id> [--version <version>] [--json]', true],
      ['sheet', 'attach', 'abe sheet attach <id> --card <card> [--json]', true],
      ['sheet', 'open', 'abe sheet open <id> [--version <version>] [--json]', true],
      [
        'workspace',
        'up',
        'abe workspace up [--repo <repo>] [--card <card>] [--title <title>] [--branch <branch>] [--all] [--json]',
        false,
      ],
      ['workspace', 'status', 'abe workspace status [--json]', false],
      ['workspace', 'rm', 'abe workspace rm <card> [--json]', false],
      ['workspace', 'ports', 'abe workspace ports [--card <card>] [--json]', false],
      ['workspace', 'relay', 'abe workspace relay <card> <port> [--json]', false],
      ['workspace', 'attach-spec', 'abe workspace attach-spec <session> [--json]', false],
      ['browser', 'start', 'abe browser start [--profile <profile>] [--json]', true],
      ['browser', 'stop', 'abe browser stop [--json]', true],
      ['browser', 'status', 'abe browser status [--json]', true],
      ['browser', 'list', 'abe browser list [--json]', false],
      ['browser', 'add', 'abe browser add <name> --purpose <purpose> [--json]', false],
      ['browser', 'rename', 'abe browser rename <old> <new> [--json]', false],
      ['browser', 'remove', 'abe browser remove <name> [--forget] [--json]', false],
      ['browser', 'default', 'abe browser default <name> [--json]', false],
      ['browser', 'open', 'abe browser open <name> [urls…] [--front] [--json]', false],
      ['browser', 'store', 'abe browser store <name> [--json]', false],
      ['run', null, 'abe run <script> [args…] [--env dev|test|prod] [--json]', true],
      [
        'session',
        'launch',
        'abe session launch --card <card> --repo <repo> [--profile <profile>] [--note <note>] [--note-file <note-file>] [--short resize|anyway] [--json]',
        false,
      ],
      [
        'session',
        'run',
        'abe session run --repo <repo> [--card <card>] [--prototype <prototype>] --text <text> [--id <id>] [--resume <resume>] [--transcript <transcript>] [--from <from>] [--factory] [--reopen] [--message <message>] [--profile <profile>] [--layer <layer>] [--reference <reference>] [--sync <sync>] [--json]',
        false,
      ],
      ['session', 'sync', 'abe session sync --repo <repo> --sync <sync> [--json]', false],
      ['session', 'list', 'abe session list [--json]', true],
      ['session', 'show', 'abe session show <id> [--json]', true],
      ['session', 'send', 'abe session send <id> <text…> [--context <context>] [--json]', false],
      [
        'session',
        'answer',
        'abe session answer <id> --card <card> [--option <option>…] [--text <text>] [--answers <answers>] [--pick <pick>] [--json]',
        false,
      ],
      ['session', 'asks', 'abe session asks <id> [--json]', false],
      [
        'session',
        'override',
        'abe session override <id> --what <what> --reason <reason> [--json]',
        false,
      ],
      ['session', 'unqueue', 'abe session unqueue <id> <n> [--json]', false],
      [
        'session',
        'model',
        'abe session model <id> --model <model> [--effort low|medium|high] [--json]',
        false,
      ],
      ['session', 'skills', 'abe session skills <id> [--json]', false],
      ['session', 'attach', 'abe session attach <id> [--json]', false],
      ['session', 'stop', 'abe session stop <id> [--json]', true],
      [
        'session',
        'reopen',
        'abe session reopen <id> [--message <message>] [--short resize|anyway] [--json]',
        false,
      ],
      ['session', 'transcript', 'abe session transcript <id> [--since <since>] [--json]', true],
      [
        'session',
        'revert',
        'abe session revert <id> --turn <turn> [--file <file>] [--json]',
        false,
      ],
      ['session', 'download', 'abe session download <id> [--repo <repo>] [--json]', false],
      [
        'session',
        'move-to-cloud',
        'abe session move-to-cloud <id> [--short resize|anyway] [--json]',
        false,
      ],
      [
        'factory',
        'run',
        'abe factory run <card> [--repo <repo>] [--target local-sandbox|local|cloud] [--profile <profile>] [--note <note>] [--note-file <note-file>] [--prod] [--workflow <workflow>] [--short resize|anyway] [--replace] [--json]',
        false,
      ],
      [
        'factory',
        'stage-done',
        'abe factory stage-done <stage> [--report <report>] [--fact <fact>…] [--made <made>] [--json]',
        true,
      ],
      ['factory', 'judge', 'abe factory judge --answer yes|no --reason <reason> [--json]', true],
      [
        'factory',
        'review',
        'abe factory review --findings <findings> [--report <report>] [--regression <regression>] [--findings-file <findings-file>] [--json]',
        true,
      ],
      [
        'factory',
        'verify',
        'abe factory verify --phase before|after --result pass|fail|not-reproduced --report <report> [--regression <regression>] [--html <html>] [--json]',
        true,
      ],
      ['factory', 'base-worktree', 'abe factory base-worktree [--json]', true],
      [
        'factory',
        'needs-you',
        'abe factory needs-you --reason <reason> [--option <option>…] [--json]',
        true,
      ],
      ['factory', 'pr', 'abe factory pr --title <title> --body-file <body-file> [--json]', true],
      ['factory', 'status', 'abe factory status [card] [--cleared] [--json]', true],
      [
        'factory',
        'end',
        'abe factory end <card> --as done|not-reproduced|abandoned --reason <reason> [--json]',
        false,
      ],
      ['factory', 'checks', 'abe factory checks <card> [--json]', true],
      ['factory', 'record', 'abe factory record <card> [--json]', false],
      [
        'prototype',
        'start',
        'abe prototype start [words…] [--repo <repo>] [--card <card>] [--json]',
        false,
      ],
      ['prototype', 'restart', 'abe prototype restart [--id <id>] [--json]', true],
      [
        'prototype',
        'screenshot add',
        'abe prototype screenshot add --file <file> --what <what> [--id <id>] [--json]',
        true,
      ],
      ['prototype', 'show', 'abe prototype show [--id <id>] [--json]', true],
      [
        'prototype',
        'make-card',
        'abe prototype make-card [--id <id>] --title <title> [--description <description>] [--description-file <description-file>] [--json]',
        true,
      ],
      ['prototype', 'discard', 'abe prototype discard [id] [--json]', false],
      ['prototype', 'stop', 'abe prototype stop [--id <id>] [--json]', true],
      ['prototype', 'list', 'abe prototype list [--json]', true],
      ['triage', null, 'abe triage [--team] [--repo <repo>] [--json]', false],
      ['triage', 'apply', 'abe triage apply <id…> [--json]', false],
      ['triage', 'launch', 'abe triage launch <id…> [--json]', false],
      ['improve', null, 'abe improve <wish…> [--again <again>] [--json]', false],
      ['improve', 'apply', 'abe improve apply <id> [--json]', false],
      ['improve', 'undo', 'abe improve undo [--force] [--json]', false],
      ['chat', null, 'abe chat [words…] [--new] [--shown <shown>] [--repo <repo>] [--json]', false],
      ['improve', 'suggest', 'abe improve suggest [--json]', false],
      ['improve', 'retro', 'abe improve retro <scope> [--since <since>] [--json]', false],
      [
        'improve',
        'retro make',
        'abe improve retro make <finding> [--pr] [--file] [--retro <retro>] [--json]',
        false,
      ],
      ['improve', 'retro last', 'abe improve retro last [--json]', false],
      ['hook', null, 'abe hook <event> --payload <payload> [--json]', true],
      ['log', 'ship', 'abe log ship <id> [--json]', false],
      ['log', 'list', 'abe log list [--repo <repo>] [--user <user>] [--json]', false],
      ['login', null, 'abe login <tool> [--tenant <tenant>] [--profile <profile>] [--json]', false],
      ['login', 'status', 'abe login status [--repo <repo>] [--json]', true],
      ['login', 'restore', 'abe login restore [--json]', false],
      ['install', null, 'abe install [--repo <repo>] [--json]', false],
      ['install', 'reset', 'abe install reset [--repo <repo>] [--json]', false],
      ['install', 'status', 'abe install status [--repo <repo>] [--json]', true],
      ['install', 'logins', 'abe install logins [--repo <repo>] [--json]', true],
      ['install', 'sources', 'abe install sources [--repo <repo>] [--json]', true],
      [
        'install',
        'source',
        'abe install source <name> [--url <url>] [--skip] [--transport http|sse|stdio] [--command <command>] [--arg <arg>…] [--env <env>…] [--header <header>…] [--repo <repo>] [--json]',
        true,
      ],
      ['source', 'status', 'abe source status [--repo <repo>] [--json]', true],
      ['source', 'sign-in', 'abe source sign-in <source> [--repo <repo>] [--json]', true],
      [
        'install',
        'checks-env',
        'abe install checks-env <env> [--why <why>] [--repo <repo>] [--json]',
        true,
      ],
      [
        'install',
        'env-map',
        'abe install env-map [--file <file>…] [--ci <ci>] [--ci-key <ci-key>…] [--repo <repo>] [--json]',
        true,
      ],
      [
        'install',
        'env-profile',
        'abe install env-profile <env> <profile> [--repo <repo>] [--json]',
        true,
      ],
      [
        'install',
        'gate',
        'abe install gate [--url <url>] [--before-run] [--cannot-run <cannot-run>] [--test-host <test-host>…] [--read-only-host <read-only-host>…] [--not-used <not-used>…] [--repo <repo>] [--json]',
        true,
      ],
      ['install', 'kind', 'abe install kind <kind> [--part <part>] [--repo <repo>] [--json]', true],
      ['install', 'check', 'abe install check [part] [--all] [--repo <repo>] [--json]', true],
      [
        'install',
        'try',
        'abe install try [name] [--all] [--command <command>] [--repo <repo>] [--json]',
        true,
      ],
      ['install', 'connection', 'abe install connection [--repo <repo>] [--json]', true],
      ['check', 'json', 'abe check json <files…> [--json]', true],
      ['check', 'yaml', 'abe check yaml <files…> [--json]', true],
      ['box', 'list', 'abe box list [--json]', false],
      ['box', 'status', 'abe box status <box> [--json]', false],
      ['box', 'up', 'abe box up <repo> <card> [--title <title>] [--json]', false],
      [
        'box',
        'place',
        'abe box place <card> [--repo <repo>] [--title <title>] [--apply] [--json]',
        false,
      ],
      ['box', 'start', 'abe box start <box> [--json]', false],
      ['box', 'stop', 'abe box stop <box> [--yes] [--json]', false],
      ['box', 'keep', 'abe box keep <box> [--json]', false],
      ['box', 'sleep', 'abe box sleep <box> [--json]', false],
      ['box', 'terminate', 'abe box terminate <box> [--yes] [--json]', false],
      ['box', 'resize', 'abe box resize <box> <size> [--yes] [--json]', false],
      ['fresh', null, 'abe fresh [--follow] [--json]', false],
      ['watch', null, 'abe watch [--since <since>] [--json]', false],
      ['ui', 'render', 'abe ui render <screen> [--page <page>] [--json]', false],
      ['ui', 'bridge', 'abe ui bridge [--json]', false],
      [
        'box',
        'attach',
        'abe box attach <box> [--session <session>] [--card <card>] [--shared] [command…] [--json]',
        false,
      ],
      ['box', 'forward', 'abe box forward <box> <port> [--json]', false],
      ['port', 'list', 'abe port list [--box <box>] [--json]', false],
      ['port', 'open', 'abe port open <box> <card> <port> [--json]', false],
      ['port', 'close', 'abe port close <box> <card> <port> [--json]', false],
      ['port', 'pipe', 'abe port pipe <port> [--json]', false],
      [
        'review',
        'show',
        'abe review show <pr> --path <path> [--unchecked <unchecked>] [--json]',
        false,
      ],
      ['review', 'drafts', 'abe review drafts <pr> --path <path> [--json]', false],
      [
        'review',
        'mark',
        'abe review mark <pr> --path <path> --file <file>… [--off] [--unchecked] [--json]',
        false,
      ],
      [
        'review',
        'draft',
        'abe review draft <pr> --path <path> --file <file> --side LEFT|RIGHT --line <line> [--start <start>] --body <body> --base <base> --head <head> [--now] [--json]',
        false,
      ],
      [
        'review',
        'edit-draft',
        'abe review edit-draft <pr> --path <path> --seq <seq> --body <body> [--json]',
        false,
      ],
      [
        'review',
        'drop-draft',
        'abe review drop-draft <pr> --path <path> [--seq <seq>] [--file <file>] [--json]',
        false,
      ],
      [
        'review',
        'submit',
        'abe review submit <pr> --path <path> --verdict approve|request-changes|comment [--body <body>] --read <read> [--json]',
        false,
      ],
      [
        'review',
        'reply',
        'abe review reply <pr> --path <path> --thread <thread> --body <body> [--json]',
        false,
      ],
      [
        'review',
        'resolve',
        'abe review resolve <pr> --path <path> --thread <thread> [--reopen] [--json]',
        false,
      ],
      ['review', 'prs', 'abe review prs --path <path> [--json]', false],
      ['review', 'pr', 'abe review pr <pr> --path <path> [--json]', false],
      ['review', 'open', 'abe review open <pr> --path <path> [--json]', false],
      ['review', 'ready', 'abe review ready <pr> --path <path> [--json]', false],
      ['review', 'say', 'abe review say <pr> --path <path> --body <body> [--json]', false],
      ['review', 'close', 'abe review close <pr> --path <path> [--json]', false],
      ['pr', 'draft-plan', 'abe pr draft-plan --path <path> [--json]', false],
      [
        'pr',
        'draft-create',
        'abe pr draft-create --path <path> --repo <repo> --branch <branch> --head <head> --base <base> --title <title> [--body <body>] [--push] [--reviewer <reviewer>…] [--json]',
        false,
      ],
    ];

    expect(sorted(data.commands.map((c) => [c.noun, c.verb, c.usage, c.inSession]))).toEqual(
      sorted(rows),
    );
    expect(data.globalFlags.map((f) => f.name)).toEqual(['json', 'no-start', 'help', 'on']);
  });

  test('help text lists every command', async () => {
    const out = await run(['help']);

    expect(out.exit).toBe(0);
    for (const id of commandIds()) expect(out.stdout).toContain(`  ${id} `);
  });

  test('help for one command prints its usage', async () => {
    const out = await run(['help', 'serve', 'stop']);

    expect(out.stdout).toStartWith('usage: abe serve stop [--json]\n');
    expect(out.stdout).toContain('not available from inside a session.');
  });

  test.each([[['factory']], [['factory', '--help']], [['help', 'factory']]])(
    'a noun with no command of its own (%j) lists its commands',
    async (argv) => {
      const out = await run(argv);
      const factory = commandIds().filter((id) => COMMANDS[id].noun === 'factory');

      expect(out.exit).toBe(0);
      for (const id of factory) expect(out.stdout).toContain(`  ${id} `);
      expect(out.stdout).not.toContain('  serve stop ');
    },
  );

  test('a noun --json lists its commands as data', async () => {
    const doc = envelope(HelpData).parse(JSON.parse((await run(['factory', '--json'])).stdout));

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.commands.map((c) => [c.noun, c.verb].join(' '))).toEqual(
      commandIds().filter((id) => COMMANDS[id].noun === 'factory'),
    );
  });

  test.each(['frob', 'toString'])('help for %s is a usage failure with the usage', async (name) => {
    const out = await run(['help', name, '--json']);

    expect(out.exit).toBe(2);
    expect(JSON.parse(out.stdout)).toEqual({
      ok: false,
      error: { code: 'unknown-command', message: `unknown command: ${name}` },
    });
    expect(out.stderr).toStartWith('usage: abe help [command…] [--json]\n');
  });
});

describe('dispatch prints one result', () => {
  test('--json prints exactly one ok document', async () => {
    const out = await run(['status', '--json']);

    expect(out).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ ok: true, data: STATUS })}\n`,
      stderr: '',
    });
  });

  test('text by default', async () => {
    const out = await run(['status']);

    expect(out.exit).toBe(0);
    expect(out.stdout).toStartWith(
      `abe serve 2.0.0-test, pid 42, started ${localWhen('2026-10-01T09:00:00.000Z')}\n`,
    );
  });

  test('an unknown flag prints the usage and exits 2', async () => {
    const text = await run(['status', '--frob']);

    expect(text.exit).toBe(2);
    expect(text.stdout).toBe('');
    expect(text.stderr).toStartWith('abe: unknown flag --frob\n\nusage: abe status [--json]\n');

    const json = await run(['status', '--frob', '--json']);

    expect(json.exit).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: { code: 'usage', message: 'unknown flag --frob' },
    });
    expect(json.stderr).toStartWith('usage: abe status [--json]\n');
  });

  test('a usage failure names the sibling verbs', async () => {
    const out = await run(['serve', 'frob']);

    expect(out.stderr).toContain('also: abe serve stop [--json]\n');
  });

  test('--help prints the usage and exits 0', async () => {
    const out = await run(['status', '--help']);

    expect(out.exit).toBe(0);
    expect(out.stdout).toStartWith('usage: abe status [--json]\n');
  });

  test('a refusal is exit 1 with its code', async () => {
    expect(await run(['serve', '--json'])).toEqual({
      exit: 1,
      stdout: '{"ok":false,"error":{"code":"serve-running","message":"running"}}\n',
      stderr: '',
    });
    expect(await run(['serve'])).toEqual({ exit: 1, stdout: '', stderr: 'abe: running\n' });
  });

  test('an answer that records a failure (abe install check) exits 1, its document still ok', async () => {
    const part = (state: 'pass' | 'fail' | 'warn') => ({
      repo: '/r',
      join: false,
      session: null,
      parts: [{ id: 'logins' as const, required: true, state, line: 'said', checkedAt: null }],
      done: false,
      files: [],
      checked: ['logins' as const],
    });
    const checked = (state: 'pass' | 'fail' | 'warn'): Partial<Handlers<null>> => ({
      'install check': () => Promise.resolve({ ok: true, data: part(state) }),
    });
    const failed = await dispatch(['install', 'check', 'logins', '--json'], checked('fail'), null);

    expect([failed.exit, JSON.parse(failed.stdout)]).toEqual([1, { ok: true, data: part('fail') }]);
    expect((await dispatch(['install', 'check', 'logins'], checked('fail'), null)).exit).toBe(1);
    expect((await dispatch(['install', 'check', 'logins'], checked('warn'), null)).exit).toBe(0);
    expect((await dispatch(['install', 'check', 'logins'], checked('pass'), null)).exit).toBe(0);
  });

  test('a command the table keeps out of sessions is refused there', async () => {
    const out = await run(['serve', 'stop', '--json'], 'session');

    expect(out.exit).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, error: { code: 'not-in-session' } });
    expect((await run(['status', '--json'], 'session')).exit).toBe(0);
  });

  test('an answer that breaks the contract is a failure, not a document', async () => {
    const broken: Partial<Handlers<null>> = {
      ...handlers,
      status: () => Promise.resolve({ ok: true, data: { ...STATUS, pid: -1 } }),
    };
    const out = await dispatch(['status', '--json'], broken, null);

    expect(out.exit).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, error: { code: 'bad-result' } });
  });

  test('a handler that throws is a failure', async () => {
    const throws: Partial<Handlers<null>> = {
      ...handlers,
      status: () => Promise.reject(new Error('boom')),
    };

    expect(await dispatch(['status'], throws, null)).toEqual({
      exit: 1,
      stdout: '',
      stderr: 'abe: boom\n',
    });
  });
});

describe("a session's permission rules: a Bash rule for every in-session command but hook", () => {
  test.each<[string, boolean]>([
    ['factory judge', true],
    ['factory stage-done', true],
    ['card show', true],
    // the person's, or the Abe chat's (which runs as the person)
    ['improve retro make', false],
    ['hook', false],
    ['factory run', false],
    ['pr merge', false],
  ])('abe %s: %p', (id, allowed) => {
    expect(inSessionRules().includes(`Bash(abe ${id}:*)`)).toBe(allowed);
  });

  test('one rule per in-session row', () => {
    expect(inSessionRules()).toHaveLength(
      Object.values(COMMANDS).filter((c) => c.inSession).length - 1,
    );
  });
});
