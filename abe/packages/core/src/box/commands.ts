/** Boxes' rows of the command table: `abe box`, `workspace`, `port`, `run` and `session run`. */
import { CARD_ID, REPO } from '../board';
import { command } from '../command';
import { PROFILE_FLAG, SessionData, sessionText } from '../session';
import { BoxData, BoxKeepData, BoxListData, boxKeepText, boxListText, boxText } from './box';
import { BoxAttachData, BoxForwardData, boxForwardText } from './box-link';
import { BoxPlaceData, boxPlaceText } from './box-place';
import {
  PortClosed,
  PortForward,
  PortListData,
  PortPiped,
  WorkspacePortsList,
  WorkspaceRelay,
  portClosedText,
  portForwardText,
  portListText,
  workspacePortsText,
  workspaceRelayText,
} from './box-ports';
import { RunData, runText } from './box-session';
import { SessionSyncData } from './box-sync';
import { BoxResizeData, boxResizeText } from './cloud';
import {
  WorkspaceList,
  WorkspaceRemoved,
  WorkspaceUp,
  workspaceListText,
  workspaceRemovedText,
  workspaceUpText,
} from './workspace';

const BOX_NAME = {
  kind: 'positional',
  type: 'string',
  required: true,
  summary: "the box: its name, the card's `<repo>-<card>` (`demo-shop-4`)",
} as const;

export const BOX_COMMANDS = {
  'workspace up': command({
    noun: 'workspace',
    verb: 'up',
    summary:
      "on a box: make or bring back the card's workspace (its image, clone, database and container), or with --all every workspace on the box; safe to run again",
    inSession: false,
    args: {
      repo: { ...REPO, required: false },
      card: { kind: 'flag', type: 'string', summary: "the card's id" },
      title: {
        kind: 'flag',
        type: 'string',
        summary: "the card's title, for the branch card/<id>-<slug>",
      },
      branch: {
        kind: 'flag',
        type: 'string',
        summary:
          "instead of --title: the clone's branch (a prototype's proto/<id>-<slug>, its --card the prototype's id: no push leaves it)",
      },
      all: {
        kind: 'flag',
        type: 'boolean',
        summary:
          "every workspace on the box brought back (the box's start), in place of --repo and --card",
      },
    },
    result: WorkspaceUp,
    text: workspaceUpText,
  }),
  'workspace status': command({
    noun: 'workspace',
    verb: 'status',
    summary: "on a box: each workspace's repo, card, branch and state",
    inSession: false,
    args: {},
    result: WorkspaceList,
    text: workspaceListText,
  }),
  'workspace rm': command({
    noun: 'workspace',
    verb: 'rm',
    summary:
      "on a box: the card's workspace removed (its container, clone and database); refused while anything in it is unpushed or someone is in it",
    inSession: false,
    args: { card: { ...CARD_ID, summary: "the card's id" } },
    result: WorkspaceRemoved,
    text: workspaceRemovedText,
  }),
  'workspace ports': command({
    noun: 'workspace',
    verb: 'ports',
    summary:
      "on a box: the dev ports listening in each running workspace (1024 to 32767), and those its repo's auth callback fixes",
    inSession: false,
    args: { card: { kind: 'flag', type: 'string', summary: "only this card's workspace" } },
    result: WorkspacePortsList,
    text: workspacePortsText,
  }),
  'workspace relay': command({
    noun: 'workspace',
    verb: 'relay',
    summary:
      "on a box: a port on the box's own 127.0.0.1 reaching a port in the card's workspace (abe port pipe inside it), kept while the workspace runs",
    inSession: false,
    args: {
      card: { ...CARD_ID, summary: "the card's id" },
      port: { kind: 'positional', type: 'number', required: true, summary: "the workspace's port" },
    },
    result: WorkspaceRelay,
    text: workspaceRelayText,
  }),
  run: command({
    noun: 'run',
    summary:
      "from a session: run a hook point's script or a Verification pack script (by its role, or .claude/skills/run-app/scripts/<name> unless abe.yaml's hooks say) outside the sandbox, so the app it starts keeps running: in a box's workspace as its script user, in a local session's worktree on this machine with no token",
    inSession: true,
    inWorkspace: 'session',
    args: {
      script: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary:
          "the script: a role (start, stop, seed, db, query, prototype-start, prototype-stop), .claude/skills/run-app/scripts/<name> in the session's worktree (or just <name>), or by its absolute path there or in Before's worktree",
      },
      args: {
        kind: 'positional',
        type: 'string',
        repeats: true,
        summary: "the script's arguments (after `--` when one starts with -)",
      },
      env: {
        kind: 'flag',
        type: 'string',
        values: ['dev', 'test', 'prod'],
        summary:
          "the environment whose Abe env file (.abe/abe.<env>.env) and aws profile's short-lived keys the script gets: dev when none; prod is refused until the prod line holds",
      },
    },
    result: RunData,
    text: runText,
  }),
  compose: command({
    noun: 'compose',
    summary:
      "from a box's workspace (its docker shim): run docker compose on the box, in the card's own project from the workspace's compose file, the workspace joined to its network",
    inSession: true,
    inWorkspace: 'socket',
    args: {
      cwd: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: "the folder in the workspace's clone (or Before's) whose compose file it runs",
      },
      args: {
        kind: 'positional',
        type: 'string',
        repeats: true,
        summary: "compose's own arguments, after `--` (up -d, down, ps, logs)",
      },
    },
    result: RunData,
    text: runText,
  }),
  'session run': command({
    noun: 'session',
    verb: 'run',
    summary:
      "on a box: start claude in its workspace for the card it holds, or a prototype session in the prototype's workspace (the local serve sends it at launch)",
    inSession: false,
    args: {
      repo: { kind: 'flag', type: 'string', required: true, summary: 'the repo, `owner/repo`' },
      card: {
        kind: 'flag',
        type: 'string',
        summary: 'the card (`4`, `AB#4`); a prototype with no card: none',
      },
      prototype: {
        kind: 'flag',
        type: 'string',
        summary:
          'a prototype session as JSON {"id","card","words","branch","base","commit"}: its workspace is the one keyed by its id',
      },
      text: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary:
          'the card\'s words as JSON: {"title","description","acceptanceCriteria"} (one value, so no text is read as a flag)',
      },
      id: {
        kind: 'flag',
        type: 'string',
        summary: "the session's id, as the local serve named it",
      },
      resume: {
        kind: 'flag',
        type: 'string',
        summary: 'a moved session (Move to cloud): the Claude session `claude --resume` continues',
      },
      transcript: {
        kind: 'flag',
        type: 'string',
        summary: 'with --resume: its transcript, copied into the clone (relative to it)',
      },
      from: {
        kind: 'flag',
        type: 'string',
        summary: 'with --resume: the folder it ran in before, as the transcript names it',
      },
      factory: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'run it through its workflow, starting at its first step (`abe factory run` locally)',
      },
      reopen: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'with --id: Reopen that ended session (#343), its workspace and Claude Code conversation (`abe session reopen` locally)',
      },
      message: {
        kind: 'flag',
        type: 'string',
        summary: 'with --reopen: its first prompt (default: none; a run not over is told to go on)',
      },
      profile: PROFILE_FLAG(
        'the browser profile the local serve launched it with (default: default)',
      ),
      layer: {
        kind: 'flag',
        type: 'string',
        summary:
          "the launching person's settings as JSON (#222, ADR 0030): { machine, local }, the box's own and its checkout's from now on",
      },
      reference: {
        kind: 'flag',
        type: 'string',
        summary:
          'with --factory: the card\'s prototype reference as JSON {"run","prompt"} (#351); the local serve read it from the org store and copied its files into the clone first',
      },
      sync: {
        kind: 'flag',
        type: 'string',
        summary:
          'box parity (3.2.1): what the local serve synced into the clone first, as JSON {"repo","checked","envFiles"}: its abe.yaml (the checkout\'s from now on), the sources its install checked, the environments whose Abe env file is there; never a secret',
      },
    },
    result: SessionData,
    text: sessionText,
  }),
  'session sync': command({
    noun: 'session',
    verb: 'sync',
    summary:
      "on a box: a turn's box parity sync from the local serve (3.2.1): its abe.yaml the box checkout's now; the workspace's files came on stdin before it",
    inSession: false,
    args: {
      repo: { kind: 'flag', type: 'string', required: true, summary: 'the repo, `owner/repo`' },
      sync: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'as session run --sync: {"repo","checked","envFiles","locked"}, never a secret',
      },
    },
    result: SessionSyncData,
    text: (d) => `synced ${d.repo}\n`,
  }),
  'box list': command({
    noun: 'box',
    verb: 'list',
    summary:
      "your boxes on EC2 (tagged abe:owner with your login): each one's state, size, release, uptime, cost today and, while it runs, its workspace and idle stop (from its own abe status); then your placements Queued for a box",
    waits: 'EC2 for your boxes (the aws CLI)',
    inSession: false,
    args: {},
    result: BoxListData,
    text: boxListText,
  }),
  'box status': command({
    noun: 'box',
    verb: 'status',
    summary: 'one of your boxes: its state, size and, while it runs, its workspace',
    waits: 'EC2 for your boxes (the aws CLI)',
    inSession: false,
    args: { box: BOX_NAME },
    result: BoxData,
    text: boxText,
  }),
  'box up': command({
    noun: 'box',
    verb: 'up',
    summary:
      "make the card's box from the box launch template, or wake it; answers once its abe serve answers (box.state starting, then running)",
    inSession: false,
    args: {
      repo: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the repo its workspace works in (`mkdir-swe/demo-shop`)',
      },
      card: CARD_ID,
      title: {
        kind: 'flag',
        type: 'string',
        summary: "the card's title, for its workspace branch (default: none)",
      },
    },
    result: BoxData,
    text: boxText,
  }),
  'box place': command({
    noun: 'box',
    verb: 'place',
    summary:
      "where the card's Workspace goes: its box used or woken, else made, or Queued at the team's limits.maxBoxesPerPerson (running and starting boxes count); --apply does it",
    inSession: false,
    args: {
      card: CARD_ID,
      repo: {
        kind: 'flag',
        type: 'string',
        summary: "the repo its workspace works in (default: this checkout's GitHub origin)",
      },
      title: {
        kind: 'flag',
        type: 'string',
        summary: "the card's title, for a new box's workspace branch (default: none)",
      },
      apply: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'wake or make the box (box.state starting, then running), or hold it Queued in this abe serve until a box stops or is deleted, or the limit rises',
      },
    },
    result: BoxPlaceData,
    text: boxPlaceText,
  }),
  'box start': command({
    noun: 'box',
    verb: 'start',
    summary: 'wake a sleeping box by its name; answers once its abe serve answers',
    inSession: false,
    args: {
      box: BOX_NAME,
    },
    result: BoxData,
    text: boxText,
  }),
  'box stop': command({
    noun: 'box',
    verb: 'stop',
    summary:
      'put a box to sleep (its disk is kept); answers once it stopped. A session working there asks --yes first (#316)',
    inSession: false,
    args: {
      box: BOX_NAME,
      yes: {
        kind: 'flag',
        type: 'boolean',
        summary: 'yes, stop it though a session works there: that session ends mid-turn',
      },
    },
    result: BoxData,
    text: boxText,
  }),
  'box keep': command({
    noun: 'box',
    verb: 'keep',
    summary:
      "keep a box awake until you say (abe box sleep, or abe box stop): its idle stop waits; a sleeping box is woken first. Kept on the box's own abe serve, across its restarts",
    inSession: false,
    args: { box: BOX_NAME },
    result: BoxKeepData,
    text: boxKeepText,
  }),
  'box sleep': command({
    noun: 'box',
    verb: 'sleep',
    summary:
      'let a kept-awake box sleep again: its idle stop counts box.idleMinutes from now (the box is not stopped)',
    inSession: false,
    args: { box: BOX_NAME },
    result: BoxKeepData,
    text: boxKeepText,
  }),
  'box terminate': command({
    noun: 'box',
    verb: 'terminate',
    summary:
      'delete a box (EC2 TerminateInstances as you): its disk and workspace go, work not pushed is lost. IAM may leave it to your lead',
    inSession: false,
    risky: true,
    args: {
      box: BOX_NAME,
      yes: {
        kind: 'flag',
        type: 'boolean',
        summary: 'yes, delete it: without it nothing is deleted',
      },
    },
    result: BoxData,
    text: boxText,
  }),
  'box resize': command({
    noun: 'box',
    verb: 'resize',
    summary:
      "change a box's size (stop, change its instance type, start), within the team's limits.maxBoxSize",
    inSession: false,
    args: {
      box: BOX_NAME,
      size: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the instance type (`m8g.xlarge`)',
      },
      yes: {
        kind: 'flag',
        type: 'boolean',
        summary: 'resize even though sessions run on it (the stop ends them)',
      },
    },
    result: BoxResizeData,
    text: boxResizeText,
  }),
  'box attach': command({
    noun: 'box',
    verb: 'attach',
    summary:
      "this terminal on a box over SSH through the EC2 Instance Connect Endpoint, in a reconnect loop: a session's terminal (--session), a command (-- <argv>) or a login shell in a workspace (--card's, else the first running; the box's own while none runs there; -- bash -l asks for that one)",
    inSession: false,
    only: 'client',
    args: {
      box: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the box: its name (its abe:box tag) or instance id',
      },
      session: {
        kind: 'flag',
        type: 'string',
        summary: 'the session whose terminal to attach (its tmux on the box, kept across drops)',
      },
      card: {
        kind: 'flag',
        type: 'string',
        summary: "the card whose workspace's login shell to open (a box holds one per card)",
      },
      shared: {
        kind: 'flag',
        type: 'boolean',
        summary:
          "a command without a terminal over the box's one shared SSH connection (ControlMaster): a round trip, not a new connection",
      },
      command: {
        kind: 'positional',
        type: 'string',
        repeats: true,
        verbatim: true,
        summary: 'after --: the command to run on the box, word for word',
      },
    },
    result: BoxAttachData,
  }),
  'box forward': command({
    noun: 'box',
    verb: 'forward',
    summary: 'a port on this machine (127.0.0.1) that reaches a port on a box, until Ctrl-C',
    inSession: false,
    only: 'client',
    args: {
      box: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the box: its name (its abe:box tag) or instance id',
      },
      port: {
        kind: 'positional',
        type: 'number',
        required: true,
        summary: "the box's port (a dev server's)",
      },
    },
    result: BoxForwardData,
    text: boxForwardText,
  }),
  'port list': command({
    noun: 'port',
    verb: 'list',
    summary:
      "a dev server's ports on your running boxes, per workspace: each forward this machine holds and each port listening there, offered",
    inSession: false,
    args: { box: { kind: 'flag', type: 'string', summary: 'only this box' } },
    result: PortListData,
    text: portListText,
  }),
  'port open': command({
    noun: 'port',
    verb: 'open',
    summary:
      "a workspace's port on a box forwarded to this machine's localhost, held by abe serve: the same port when free, else the next one, said (a port the repo's auth callback fixes: that one only); ends when the box sleeps, back when it wakes",
    inSession: false,
    args: {
      box: BOX_NAME,
      card: { ...CARD_ID, summary: 'the card whose workspace on the box listens' },
      port: { kind: 'positional', type: 'number', required: true, summary: "the workspace's port" },
    },
    result: PortForward,
    text: portForwardText,
  }),
  'port close': command({
    noun: 'port',
    verb: 'close',
    summary:
      "a forward of a workspace's port let go of: this machine's localhost port is free again",
    inSession: false,
    args: {
      box: BOX_NAME,
      card: { ...CARD_ID, summary: "the card whose workspace's port is forwarded" },
      port: { kind: 'positional', type: 'number', required: true, summary: "the workspace's port" },
    },
    result: PortClosed,
    text: portClosedText,
  }),
  'port pipe': command({
    noun: 'port',
    verb: 'pipe',
    summary:
      "in a box workspace: stdin and stdout piped to 127.0.0.1:<port> there (what the box's relay runs per connection)",
    inSession: false,
    only: 'client',
    args: {
      port: { kind: 'positional', type: 'number', required: true, summary: 'the port to reach' },
    },
    result: PortPiped,
  }),
};
