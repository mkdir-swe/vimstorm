/**
 * Sessions on a box (#63): `abe session run`, which the Mac's `serve` sends once the box's
 * workspace is up, starts `claude` in the workspace container through the workspace runner with
 * the person's logins, the cloud Reach (AWS names as profiles) and the container's managed
 * settings. (A box stops itself when idle: #92; nothing here keeps it awake.)
 */
import { repoLoginsNeedsYou } from '../logins/logins';
import {
  awsConfigText,
  awsProfiles,
  HandedLayer,
  LOCAL_HEADER,
  localFile,
  boxSessionEnv,
  BOX_TREES,
  CardText,
  boxSessionSettings,
  cardOfSession,
  type Handlers,
  INHERITED,
  type Logins,
  managedSettings,
  MCP_CONFIG,
  movedPrompt,
  ClaudeSession,
  transcriptInScratch,
  inSessionRules,
  type Outcome,
  parseCardId,
  parseRepo,
  reachVars,
  refused,
  type SessionData,
  WORKSPACE_PERMISSION_MODE,
  DEFAULT_PROFILE,
  ProfileName,
  individualFile,
  reopenedInstructions,
  reopenedPrompt,
  codePrototypeInstructions,
  codePrototypePrompt,
  CODE_PROTOTYPE_PLUGIN,
  CODE_PROTOTYPE_DENY,
  referenceDir,
  runOver,
  RunReference,
  repoFile,
  SessionSync,
} from '@abe/core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { writeYamlFile } from '@abe/ports';
import { factoryLaunch, type FactoryCtx } from '../factory/factory';
import { runOverridesIn } from '../layer/settings';
import { launchWorkflow } from '../skills/workflows';
import { inForce, sessionReach } from '../layer/reach';
import { type LaunchExtras, launchSettings, type SessionCtx } from '../session/sessions';
import { type Box, type WorkspaceCtx } from './workspace';

export type BoxSessionCtx = SessionCtx &
  FactoryCtx &
  WorkspaceCtx & {
    serve: {
      /** Where the box reads its owner's logins; without them a session is refused. */
      logins: Logins | undefined;
    };
  };

const cardText = (json: string): CardText | undefined => {
  try {
    const read = CardText.safeParse(JSON.parse(json));

    return read.success ? read.data : undefined;
  } catch {
    return undefined;
  }
};

/** `--reference`'s JSON (#351): the run's record of the prototype and its prompt's words. */
const BoxReference = z.object({ run: RunReference, prompt: z.string().min(1) });

/** `--reference`'s JSON as a reference; `null` when it is none. */
const referenceOf = (json: string): z.infer<typeof BoxReference> | null => {
  try {
    const read = BoxReference.safeParse(JSON.parse(json));

    return read.success ? read.data : null;
  } catch {
    return null;
  }
};

/**
 * `--prototype`'s JSON: a prototype session's id (its workspace's key), card, words, and where its
 * `proto/…` branch was made from.
 */
const BoxPrototype = z.object({
  id: z.string().regex(/^proto-[0-9a-f]{6}$/),
  card: z.number().int().positive().nullable(),
  words: z.string(),
  branch: z.string(),
  base: z.string(),
  commit: z.string(),
});

/** `--prototype`'s JSON as a prototype; `null` when it is none. */
const prototypeOf = (json: string): z.infer<typeof BoxPrototype> | null => {
  try {
    const read = BoxPrototype.safeParse(JSON.parse(json));

    return read.success ? read.data : null;
  } catch {
    return null;
  }
};

/** `--sync`'s JSON (3.2.1): what the Mac synced into the clone; `null` when it is none. */
const syncOf = (json: string): SessionSync | null => {
  try {
    const read = SessionSync.safeParse(JSON.parse(json));

    return read.success ? read.data : null;
  } catch {
    return null;
  }
};

/** `--layer`'s JSON: yours on the Mac and yours for the repo (ADR 0030); `null` when it is none. */
const layerOf = (json: string): HandedLayer | null => {
  try {
    const read = HandedLayer.safeParse(JSON.parse(json));

    return read.success ? read.data : null;
  } catch {
    return null;
  }
};

const run = async (
  args: {
    repo: string;
    card?: string | undefined;
    prototype?: string | undefined;
    text: string;
    id?: string;
    factory: boolean;
    resume?: string;
    transcript?: string;
    from?: string;
    profile?: string;
    layer?: string;
    reference?: string;
    reopen?: boolean;
    message?: string;
    sync?: string;
  },
  ctx: BoxSessionCtx,
): Promise<Outcome<SessionData>> => {
  if (ctx.serve.box === undefined)
    return refused('not-a-box', 'abe session run is answered only by a box');
  if (ctx.serve.sessions === undefined)
    return refused('no-sessions', 'this box runs no sessions (no workspace runner)');
  const { factory } = ctx.serve;

  if (args.factory && factory === undefined)
    return refused('no-factory', 'this box runs no Factory (no workspace runner)');
  const repo = parseRepo(args.repo);
  const proto = args.prototype === undefined ? undefined : prototypeOf(args.prototype);

  if (proto === null)
    return refused('usage', '--prototype is not {"id","card","words","branch","base","commit"}', 2);
  // a prototype's card is its own (none: null); a card's session names it
  const named = args.card === undefined ? undefined : parseCardId(args.card);
  const card = proto === undefined ? named : proto.card;

  if (repo === undefined) return refused('usage', `not <owner>/<repo>: ${args.repo}`, 2);
  if (card === undefined)
    return refused('usage', `not a card id (4, AB#4): ${args.card ?? '(none)'}`, 2);
  if (proto !== undefined && args.factory)
    return refused('usage', '--prototype never goes with --factory: a prototype never ships', 2);
  // its workspace's key: the card's id, or the prototype's own
  const key = proto?.id ?? String(card);
  const text = cardText(args.text);
  const profile = args.profile ?? DEFAULT_PROFILE;

  if (profile !== DEFAULT_PROFILE && !ProfileName.safeParse(profile).success)
    return refused('usage', `--profile ${profile} is no browser profile name`, 2);

  if (text === undefined)
    return refused('usage', '--text is not {"title","description","acceptanceCriteria"}', 2);
  const layer = args.layer === undefined ? undefined : layerOf(args.layer);

  if (layer === null)
    return refused('usage', '--layer is not { machine, local } maps of settings (JSON)', 2);
  const sync = args.sync === undefined ? undefined : syncOf(args.sync);

  if (sync === null)
    return refused('usage', '--sync is not {"repo","checked","envFiles"} (JSON)', 2);
  const reference = args.reference === undefined ? undefined : referenceOf(args.reference);

  if (reference === null) return refused('usage', '--reference is not {"run","prompt"} (JSON)', 2);
  // Its files are in the clone already, at its own card's folder: never another path (#351).
  if (
    reference !== undefined &&
    (!args.factory || card === null || reference.run.dir !== referenceDir(card))
  )
    return refused('usage', "--reference goes with --factory, its dir its card's", 2);
  // A reopen (#343): the session the box keeps, by its id, never a new one or a moved one.
  if (args.reopen === true && (args.id === undefined || args.resume !== undefined))
    return refused('usage', '--reopen takes --id, and no --resume', 2);
  if (args.message !== undefined && args.reopen !== true)
    return refused('usage', '--message goes with --reopen', 2);
  // A moved session (#88, Move to cloud): its transcript is in the clone, its claude resumes it.
  if (args.resume !== undefined && (args.transcript === undefined || args.from === undefined))
    return refused('usage', '--resume takes --transcript and --from', 2);
  if (args.resume !== undefined && !ClaudeSession.safeParse(args.resume).success)
    return refused('usage', `--resume ${args.resume} is not a Claude session id`, 2);
  if (args.transcript !== undefined && !transcriptInScratch(args.transcript))
    return refused('usage', `--transcript ${args.transcript} is not a log under .scratch/`, 2);
  const resume =
    args.resume === undefined || args.transcript === undefined || args.from === undefined
      ? {}
      : {
          resume: { claudeSession: args.resume, transcript: args.transcript, from: args.from },
          prompt: movedPrompt('cloud'),
        };
  // The card's (or prototype's) own workspace on the repo's box (ADR 0022); its sessions' ids
  // name it.
  if (args.id !== undefined && cardOfSession(args.id) !== key)
    return refused('usage', `--id ${args.id} is not a session of ${key} (<${key}>-<4 hex>)`, 2);
  const w = await ctx.serve.box.get(key);

  if (w === undefined)
    return refused('no-workspace', `this box has no workspace for ${key} yet: abe workspace up`);
  if (w.state !== 'running')
    return refused('workspace-stopped', `${key}'s workspace is ${w.state}`);
  if (w.repo !== repo)
    return refused('other-workspace', `${key}'s workspace on this box holds ${w.repo}`);
  if (ctx.serve.logins === undefined)
    return refused('no-logins', 'this box was not told whose logins to restore (ABE_OWNER)');
  const logins = await ctx.serve.logins.read();

  if (!logins.ok) return refused('no-logins', logins.error.message);
  // The repo's settings are the box's checkout's (its default branch), never the clone's.
  const checkout = await ctx.serve.box.checkout(repo);

  if (!checkout.ok) return checkout;
  // The launching person's files are this box's from now on (#222, ADR 0030), before anything
  // reads them: yours on the Mac as the box's own, yours for the repo in its checkout.
  if (layer !== undefined) {
    if (ctx.settings === undefined)
      return refused('no-settings', "this box's serve was started without its settings");
    const local = localFile(checkout.data);

    writeYamlFile(individualFile(ctx.settings.places.configDir), layer.machine);
    if (!existsSync(local)) {
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, LOCAL_HEADER);
    }
    writeYamlFile(local, layer.local);
  }
  // The Mac's working copy of the team's file (3.2.1): the checkout's, so the box's settings,
  // sources and reach are the ones the person has locally (a turn's sync writes it again).
  if (sync !== undefined) await teamFileIn(ctx.serve.box, repo, checkout.data, sync);
  // what reads the settings next sees the files written now
  ctx.settings?.poll();
  const force = inForce({ ...ctx, cwd: checkout.data });

  if (!force.ok) return force;
  // Write names are given only here, and only those granted (an Override in the repo's file).
  const reach = await sessionReach({ ...ctx, cwd: checkout.data }, 'cloud');

  if (!reach.ok) return reach;
  const profiles = awsProfiles(reachVars(force.data.reach, 'cloud'));
  const inherited = await ctx.serve.box.inherited(key, INHERITED);
  const at = launchSettings(ctx, checkout.data);
  // Without the Mac's sync (an older one), every source defined here counts as checked: the box
  // has no install of its own.
  const checked =
    sync?.checked ?? (at.sources ?? []).flatMap((s) => (typeof s === 'string' ? [] : [s.name]));
  const sessions = ctx.serve.sessions;
  const words = card === null ? null : { id: card, ...text };
  // a prototype session's own: its skill, its pushes refused, its words (as on the Mac)
  const own: LaunchExtras =
    proto === undefined
      ? {}
      : {
          code: { of: { id: proto.id, card }, title: text.title },
          instructions: codePrototypeInstructions({
            id: proto.id,
            card,
            branch: w.branch,
            base: proto.base,
            commit: proto.commit,
            onBox: true,
          }),
          prompt: codePrototypePrompt({ card: words, words: proto.words }),
          plugin: CODE_PROTOTYPE_PLUGIN,
          deny: CODE_PROTOTYPE_DENY,
          permissionMode: WORKSPACE_PERMISSION_MODE,
        };
  const launch = (more: LaunchExtras) =>
    sessions.launch(words, repo, reach.data.env, at, {
      ...own,
      branch: w.branch,
      browserProfile: profile,
      ...(args.id === undefined ? {} : { id: args.id }),
      ...resume,
      env: (where) =>
        boxSessionEnv({
          ...where,
          reach: reach.data.env,
          inherited,
          claudeLogin: logins.data.claude,
          granted: force.data.reach.writes,
        }),
      settings: boxSessionSettings,
      // its rules on the container's paths: the box's checkout is not there (ADR 0029)
      trees: BOX_TREES,
      managed: (abe) =>
        managedSettings({
          abe,
          allowedModels: at.allowedModels,
          ...(at.models === undefined ? {} : { models: at.models }),
          allow: inSessionRules(),
          awsRegions: profiles.flatMap((p) => (p.region === null ? [] : [p.region])),
          // the team's files the Mac changed: no file tool writes them here
          locked: sync?.locked ?? [],
        }),
      mcpConfig: MCP_CONFIG,
      checkedSources: checked,
      // told only of the Abe env files the Mac synced into the clone (none without a sync)
      envFiles: sync?.envFiles ?? [],
      ...(profiles.length === 0
        ? {}
        : { files: [{ path: '.aws/config', text: awsConfigText(profiles) }] }),
      ...more,
    });

  // Your Launch note and the standing notes, as the Mac read them at launch (#347).
  const notes = { note: text.note, standing: text.standing };

  // a prototype's reopen: its conversation again, as its own (never a run's)
  if (args.reopen === true && proto !== undefined)
    return launch({
      id: args.id ?? '',
      reopen: true,
      branch: w.branch,
      prompt: args.message ?? '',
    });
  if (args.reopen === true) return reopenHere(args.id ?? '', args.message, launch, ctx);
  if (proto !== undefined || words === null) return launch({});
  if (!args.factory || factory === undefined) return launch(notes);
  // As a local run, its settings read in the box's checkout of the repo.
  // Nobody is at a Factory run's prompts here: its hook answers them (#67).
  const ran = await factoryLaunch(
    factory,
    words,
    checkout.data,
    // `factory`: its session says it is a run's (#332), as a local run's does
    (more) =>
      launch({
        ...more,
        permissionMode: WORKSPACE_PERMISSION_MODE,
        unattended: true,
        factory: true,
      }),
    runOverridesIn(ctx.settings, checkout.data),
    // The Mac read it from the org store and put its files in the clone (#351): the box has no store.
    reference,
    notes,
    // the workflow picked locally; from an older serve, the card's in the box's checkout by
    // the type and tags it sent.
    text.workflow ??
      launchWorkflow(ctx.settings, checkout.data, { type: text.type, tags: text.tags }),
    // the box's own logins, restored from your secret, against the repo's logins:
    await repoLoginsNeedsYou(ctx, checkout.data),
  );

  return ran.ok ? { ok: true, data: ran.data.session } : ran;
};

/**
 * The Mac's `abe.yaml` (`SessionSync.repo`) as the box checkout's (none there: left as it is), and
 * the hook points it handed (`SessionSync.hooks`, its committed `abe.yaml`'s) as what `abe run`
 * runs in the repo's workspaces (an older Mac's, none: the last ones handed stay).
 */
const teamFileIn = async (
  box: Pick<Box, 'handHooks'>,
  repo: string,
  checkout: string,
  sync: SessionSync,
) => {
  if (sync.repo !== null) writeFileSync(repoFile(checkout), sync.repo);
  if (sync.hooks !== undefined) await box.handHooks(repo, sync.hooks);
};

/**
 * `abe session sync` (3.2.1): a turn's sync from the Mac, its `abe.yaml` the box checkout's now,
 * as a launch's `--sync` does. The workspace's files came on stdin before it.
 */
const syncHere = async (
  args: { repo: string; sync: string },
  ctx: BoxSessionCtx,
): Promise<Outcome<{ repo: string }>> => {
  if (ctx.serve.box === undefined)
    return refused('not-a-box', 'abe session sync is answered only by a box');
  const repo = parseRepo(args.repo);
  const sync = syncOf(args.sync);

  if (repo === undefined) return refused('usage', `not <owner>/<repo>: ${args.repo}`, 2);
  if (sync === null)
    return refused('usage', '--sync is not {"repo","checked","envFiles"} (JSON)', 2);
  const checkout = await ctx.serve.box.checkout(repo);

  if (!checkout.ok) return checkout;
  await teamFileIn(ctx.serve.box, repo, checkout.data, sync);
  ctx.settings?.poll();

  return { ok: true, data: { repo } };
};

/**
 * A reopen on the box (#343): the ended session this serve keeps goes on in its workspace, its
 * Claude Code conversation resumed (`claude --resume`, the conversation on the volume); a run not
 * over goes on at its stage unattended, as it ran, its Needs you answered; a run over, or no run,
 * a plain conversation.
 */
const reopenHere = async (
  id: string,
  message: string | undefined,
  launch: (more: LaunchExtras) => Promise<Outcome<SessionData>>,
  ctx: BoxSessionCtx,
): Promise<Outcome<SessionData>> => {
  // read as settled first: one whose claude went with the box's stop reads ended now
  await ctx.serve.sessions?.list();
  const meta = ctx.serve.sessions?.metaOf(id);

  if (meta === undefined) return refused('no-session', `no session ${id} on this box`);
  const run = ctx.serve.factory?.get(id);
  const goesOn = run !== undefined && !runOver(run);
  const launched = await launch({
    id,
    reopen: true,
    branch: meta.branch,
    instructions: reopenedInstructions(run),
    prompt: reopenedPrompt(message, run),
    ...(goesOn
      ? { permissionMode: WORKSPACE_PERMISSION_MODE, unattended: true, factory: true }
      : {}),
  });

  if (launched.ok && goesOn && run.needsYou !== null)
    await ctx.serve.factory?.apply(id, { type: 'answered' }, 'reopen');

  return launched;
};

export const boxSessionHandlers = () =>
  ({
    'session run': (args, ctx) => run(args, ctx),
    'session sync': (args, ctx) => syncHere(args, ctx),
  }) satisfies Partial<Handlers<BoxSessionCtx>>;
