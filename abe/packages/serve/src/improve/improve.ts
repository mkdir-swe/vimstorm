/**
 * `abe improve` (ticket #84): an agent proposes changes to your personal Layer. `improve <wish>`
 * asks one one-shot with core's improve skill and keeps its proposal (nothing written), or files a
 * wish that needs VimStorm's code as a VimStorm issue; `apply` writes a proposal and keeps the
 * state before it; `undo` puts back the last one (up to 20); `suggest` asks for one change by itself, opted in, once a
 * day. The rules are core's (`core/src/improve/improve.ts`). `makePersonalProposal` is the one way a
 * proposal is made, also for retro's personal findings (#86).
 */
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  applyEntryDiff,
  changedFiles,
  checkPaths,
  type Clock,
  commandNouns,
  entryDiff,
  type EntryDiff,
  type FileChange,
  fileChange,
  IMPROVE_SKILL,
  type ImproveApplyData,
  type ImproveData,
  improvePrompt,
  type ImproveProposal,
  type ImproveSuggestData,
  type ImproveUndoData,
  individualFile,
  placesOf,
  type SettingKey,
  isSettingKey,
  LAYER_FILE,
  localFile,
  LOCAL_PATH,
  settingKeys,
  SETTINGS,
  type Journal,
  type LayerPulls,
  maySuggest,
  needsCodeBody,
  type Outcome,
  parseRepo,
  type PersonalKind,
  personalKindOf,
  PERSONAL_TOP_FILES,
  NVIM_DIR,
  SKILLS_DIR,
  mapFileProblem,
  ownSettingsProblems,
  readKeysText,
  type DocRead,
  type ProposalShown,
  shownFile,
  PROPOSAL_ID,
  ProposalRecord,
  pushUndo,
  readImprove,
  refused,
  staleFiles,
  SUGGEST_EVERY_MS,
  SuggestStamp,
  type Tracking,
  UndoStack,
  type Handlers,
} from '@abe/core';
import {
  keepUnreadableImprove,
  mainCheckout,
  listLayerFiles,
  newProposalId,
  parseYaml,
  readLayerFile,
  readProposal,
  readSuggested,
  readUndo,
  readYamlFile,
  repoRoot,
  staysInLayer,
  writeLayerFile,
  writeProposal,
  writeSuggested,
  writeUndo,
  yamlText,
} from '@abe/ports';
import { askOneShot, type OneShotCtx } from '../layer/one-shot';
import { loadSettings, noLayerPulls } from '../layer/settings';

export { noLayerPulls };

export type ImproveCtx = OneShotCtx & {
  ports: {
    tracking: Tracking;
    /** A Layer's repo on GitHub, where retro's `make` opens pull requests. */
    layerPulls: LayerPulls | undefined;
  };
  serve: {
    emit: Journal['emit'];
    clock: Clock;
    /** Where Improve keeps its proposals, undo stack and last suggestion (serve's state directory). */
    improveDir: string | undefined;
    /** The commands this `serve` ran lately, newest last (for a suggestion). */
    recentCommands: () => string[];
  };
};

/** Your personal Layer: its folder. */
type Layer = { dir: string };

const layerOf = (ctx: ImproveCtx): Outcome<Layer> => {
  if (ctx.settings === undefined)
    return refused('no-settings', 'this abe serve was started without its settings');
  const dir = ctx.settings.places.configDir;

  return { ok: true, data: { dir } };
};

const stateOf = (ctx: ImproveCtx): Outcome<string> =>
  ctx.serve.improveDir === undefined
    ? refused('no-improve', 'this abe serve was started without a state directory for Improve')
    : { ok: true, data: ctx.serve.improveDir };

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Yours for a repo (ADR 0030), its main checkout's `.abe/settings.local.yaml`: the one file a
 * proposal names outside the Layer's folder, by its full path. Only Improve puts it there.
 */
const isLocalPath = (path: string) => isAbsolute(path) && path.endsWith(`/${LOCAL_PATH}`);

/** A proposal path's file on disk. */
const fileAt = (dir: string, path: string) => (isLocalPath(path) ? path : join(dir, path));

const readAt = (dir: string, path: string) =>
  isLocalPath(path) ? readLayerFile(dirname(path), basename(path)) : readLayerFile(dir, path);

const writeAt = (dir: string, path: string, text: string | null) => {
  if (isLocalPath(path)) writeLayerFile(dirname(path), basename(path), text);
  else writeLayerFile(dir, path, text);
};

/** Each path's text now (null: none). */
const currentOf = (dir: string, paths: readonly string[]) =>
  Object.fromEntries(paths.map((p) => [p, readAt(dir, p)] as const));

/** A settings entry's key: an Override's (`['overrides', key]`) or the top one. */
const keyOf = (path: readonly string[]) => (path[0] === 'overrides' ? path[1] : path[0]);

/** Read from yours for a repo and never from this Mac's file (ADR 0030): a factory setting. */
const repoOnly = (key: SettingKey) =>
  placesOf(key).includes('local') && !placesOf(key).includes('machine');

/** A factory setting, or a group (`models:`) of factory settings only. */
const isFactoryKey = (key: string | undefined): boolean => {
  if (key === undefined) return false;
  if (isSettingKey(key)) return repoOnly(key);
  const inGroup = settingKeys().filter((k) => k.startsWith(`${key}.`));

  return inGroup.length > 0 && inGroup.every(repoOnly);
};

const docOrUndefined = (text: string | null): unknown => {
  if (text === null) return undefined;
  const read = parseYaml(text);

  return 'doc' in read ? read.doc : undefined;
};

/**
 * A change to your `settings.yaml` with its factory settings moved (ADR 0030): a factory setting
 * there is not read, so the ones it sets go to yours for this repo (the main checkout's
 * `.abe/settings.local.yaml`); editor preferences and your environment stay. A removal stays in
 * `settings.yaml`: the agent never saw the repo's file. Outside a checkout a factory setting is
 * refused.
 */
const routedSettings = (
  ctx: ImproveCtx,
  layer: Layer,
  files: readonly FileChange[],
): Outcome<FileChange[]> => {
  const change = files.find((f) => f.path === LAYER_FILE);

  if (change?.after === null || change === undefined) return { ok: true, data: [...files] };
  const after = parseYaml(change.after);

  if ('error' in after) return { ok: true, data: [...files] };
  const beforeText = readLayerFile(layer.dir, LAYER_FILE);
  const before = docOrUndefined(beforeText);
  const diff = entryDiff(before, after.doc);
  const factory = diff.set.filter(([path]) => isFactoryKey(keyOf(path)));

  if (factory.length === 0) return { ok: true, data: [...files] };
  const top = repoRoot(ctx.cwd);
  const main = top === undefined ? undefined : (mainCheckout(top) ?? top);

  if (main === undefined)
    return refused(
      'invalid-proposal',
      `${factory.map(([path]) => keyOf(path)).join(', ')}: set for a repo, in its ${LOCAL_PATH}; ask Improve in that repo's checkout`,
    );
  const local = localFile(main);
  const localText = readAt(layer.dir, local);
  const machine: EntryDiff = {
    set: diff.set.filter(([path]) => !isFactoryKey(keyOf(path))),
    removed: diff.removed,
  };
  const others = files.filter((f) => f !== change);
  const mine = {
    path: local,
    after: yamlText(
      localText ?? undefined,
      applyEntryDiff(docOrUndefined(localText), { set: factory, removed: [] }),
    ),
  };

  return {
    ok: true,
    data:
      machine.set.length === 0 && machine.removed.length === 0
        ? [...others, mine]
        : [
            ...others,
            {
              path: LAYER_FILE,
              after: yamlText(beforeText ?? undefined, applyEntryDiff(before, machine)),
            },
            mine,
          ],
  };
};

/** A personal map file's text as a document: JSON for keys, YAML for the rest. */
const readText = (kind: PersonalKind | undefined, text: string): DocRead =>
  kind === 'keys' ? readKeysText(text) : parseYaml(text);

/**
 * Why a file's new text is refused, if it is: core's rules for keys and commands, and settings
 * merged with the Layers above as they stand where you asked (an Override's reason, a lowered value).
 */
const contentProblem = (
  ctx: ImproveCtx,
  layer: Layer,
  f: FileChange,
): { code: string; message: string } | undefined => {
  const kind = isLocalPath(f.path) ? 'settings' : personalKindOf(f.path);

  if (f.after === null || kind === undefined || kind === 'skill' || kind === 'nvim')
    return undefined;
  const read = readText(kind, f.after);
  const problem = mapFileProblem(kind, read, commandNouns());

  if (problem !== undefined || kind !== 'settings' || ctx.settings === undefined || 'error' in read)
    return problem === undefined ? undefined : { code: 'invalid-proposal', message: problem };
  const file = isLocalPath(f.path) ? f.path : individualFile(layer.dir);
  const merged = loadSettings(ctx.settings.places, repoRoot(ctx.cwd), (path) =>
    path === file ? read : readYamlFile(path),
  );
  const problems = ownSettingsProblems(merged.problems, file);

  if (problems.length === 0) return undefined;

  return {
    // a view tweak naming a node no screen has keeps its own code (#85)
    code: problems.some((p) => p.code === 'unknown-node') ? 'unknown-node' : 'invalid-proposal',
    message: `${basename(file)}: ${problems.map((p) => p.message).join('; ')}`,
  };
};

/** A settings file's text read for its cells: its document, or none when it does not read. */
const settingsDoc = (text: string | null): unknown => {
  if (text === null) return undefined;
  const read = parseYaml(text);

  return 'doc' in read ? read.doc : undefined;
};

/** A proposal's files as clients show them: each one's lines, a settings file's cells too. */
export const shownOf = (p: ImproveProposal): ProposalShown[] =>
  p.files.map((f) =>
    isLocalPath(f.path) || personalKindOf(f.path) === 'settings'
      ? shownFile(f, { before: settingsDoc(f.before), after: settingsDoc(f.after) })
      : shownFile(f),
  );

/**
 * Every path refused as outside the Layer when it is, or reaches out of it through a link; yours
 * for a repo (a factory setting moved there) is the one file outside it.
 */
const pathsRefused = (layer: Layer, all: readonly { path: string }[]): Outcome<null> => {
  const files = all.filter((f) => !isLocalPath(f.path));
  const checked = checkPaths(files.map((f) => ({ path: f.path, after: null })));

  if (!checked.ok) return refused(checked.code, checked.message);
  const linked = files.filter((f) => !staysInLayer(layer.dir, f.path)).map((f) => f.path);

  return linked.length === 0
    ? { ok: true, data: null }
    : refused(
        'outside-personal-layer',
        `outside your personal Layer: ${linked.join('; ')} (a link out of ${layer.dir})`,
      );
};

/**
 * A proposal to your personal Layer from whole files (`after` null: delete it): every path inside
 * the Layer (the Neovim config a developer's only), each file's before read now, a settings or
 * commands file that does not read refused (`invalid-proposal`), one that changes nothing refused
 * (`no-change`). Kept for `apply`; nothing is written to the Layer. Retro (#86) makes its
 * personal findings' proposals with it.
 */
export const makePersonalProposal = (
  ctx: ImproveCtx,
  o: {
    wish: string;
    summary: string;
    files: readonly FileChange[];
    /** What made it: `wish`, `suggest`, `retro`. */
    from: string;
    model: string | null;
  },
): Outcome<ImproveProposal> => {
  const layer = layerOf(ctx);

  if (!layer.ok) return layer;
  const state = stateOf(ctx);

  if (!state.ok) return state;
  const reached = pathsRefused(layer.data, o.files);

  if (!reached.ok) return reached;
  const routed = routedSettings(ctx, layer.data, o.files);

  if (!routed.ok) return routed;
  const problems = routed.data.flatMap((f) => contentProblem(ctx, layer.data, f) ?? []);

  if (problems.length > 0)
    return refused(
      problems.some((p) => p.code === 'unknown-node') ? 'unknown-node' : 'invalid-proposal',
      problems.map((p) => p.message).join('; '),
    );
  const files = changedFiles(
    routed.data,
    currentOf(
      layer.data.dir,
      routed.data.map((f) => f.path),
    ),
  );

  if (files.length === 0)
    return refused('no-change', 'the proposal leaves your personal Layer as it is');
  const proposal: ImproveProposal = {
    id: newProposalId(),
    wish: o.wish,
    files,
    summary: o.summary,
  };
  const record: ProposalRecord = {
    v: 1,
    ...proposal,
    at: iso(ctx.serve.clock.now()),
    from: o.from,
    model: o.model,
    applied: null,
  };

  writeProposal(state.data, proposal.id, record);

  return { ok: true, data: proposal };
};

/** The one-shot on your Layer as it is: the agent's answer and its model. */
const askImprove = async (
  ctx: ImproveCtx,
  q: { wish: string; recent?: string[]; again?: ImproveProposal },
): Promise<
  Outcome<{
    answer: Extract<ReturnType<typeof readImprove>, { ok: true }>['answer'];
    model: string;
  }>
> => {
  const layer = layerOf(ctx);

  if (!layer.ok) return layer;
  const state = stateOf(ctx);

  if (!state.ok) return state;
  const listed = listLayerFiles(layer.data.dir, {
    top: PERSONAL_TOP_FILES,
    skills: SKILLS_DIR,
    nvim: NVIM_DIR,
  });
  const shown = (paths: readonly string[]) =>
    paths.map((path) => ({ path, text: readLayerFile(layer.data.dir, path) ?? '' }));
  const asked = await askOneShot(ctx, {
    // Its answer is written to your Layer as it comes: the writer's model, not a reader's.
    role: 'writer',
    cwd: ctx.cwd,
    // A one-shot runs no tools: Improve needs no Reach.
    reach: {},
    system: IMPROVE_SKILL,
    prompt: improvePrompt({
      wish: q.wish,
      files: shown(listed.files),
      nvim: shown(listed.nvim),
      ...(q.recent === undefined ? {} : { recent: q.recent }),
      ...(q.again === undefined
        ? {}
        : { again: { summary: q.again.summary, files: q.again.files } }),
    }),
  });

  if (!asked.ok) return asked;
  const read = readImprove(asked.data.text);

  if (!read.ok)
    return refused(
      'improve-unreadable',
      `the one-shot's answer is no proposal (${read.message}); kept as it came in ${keepUnreadableImprove(state.data, asked.data.text, ctx.serve.clock.now())}`,
    );

  return { ok: true, data: { answer: read.answer, model: asked.data.model } };
};

/** The proposal kept as `id`, or why there is none. */
export const recordOf = (ctx: ImproveCtx, id: string): Outcome<ProposalRecord> => {
  const state = stateOf(ctx);

  if (!state.ok) return state;
  const doc = PROPOSAL_ID.test(id)
    ? ProposalRecord.safeParse(readProposal(state.data, id))
    : undefined;

  return doc?.success === true
    ? { ok: true, data: doc.data }
    : refused('no-proposal', `no proposal ${id}: abe improve <wish> makes one`);
};

const undoStackOf = (state: string) => {
  const doc = UndoStack.safeParse(readUndo(state));

  return doc.success ? doc.data.entries : [];
};

/** Tells watchers the Layer's files moved: settings keys through the watcher, the files here. */
const changed = (ctx: ImproveCtx, paths: readonly string[]) => {
  ctx.settings?.poll();
  ctx.serve.emit('settings.changed', { keys: [], repo: null, files: [...paths] });
};

/** The commands a `serve`'s journal shows run lately, newest last (`abe <noun> [verb]`, at most 30). */
export const recentCommandsOf =
  (events: Journal): (() => string[]) =>
  () => {
    const seen: string[] = [];
    const stop = events.watch(0, (e) => {
      if (e.type === 'command.ran')
        seen.push(`abe ${e.data.verb === null ? e.data.noun : `${e.data.noun} ${e.data.verb}`}`);
    });

    stop();

    return seen.slice(-30);
  };

/** Where Abe's own issues go (`improve.issueRepo`), said with every `abe improve` answer. */
const abeIssuesOf = (ctx: ImproveCtx): string =>
  ctx.settings?.at(ctx.cwd).values['improve.issueRepo'] ?? SETTINGS['improve.issueRepo'].default;

export const improveHandlers = <Ctx extends ImproveCtx>() =>
  ({
    improve: async (args, ctx): Promise<Outcome<ImproveData>> => {
      const wish = args.wish.join(' ').trim();

      if (wish === '') return refused('usage', 'say what you want: abe improve <wish>', 2);
      const again = args.again === undefined ? undefined : recordOf(ctx, args.again);

      if (again?.ok === false) return again;
      const asked = await askImprove(ctx, {
        wish,
        ...(again === undefined ? {} : { again: again.data }),
      });

      if (!asked.ok) return asked;
      const { answer, model } = asked.data;
      const issues = abeIssuesOf(ctx);

      if (answer.kind === 'nothing')
        return { ok: true, data: { kind: 'nothing', wish, reason: answer.reason, model, issues } };
      if (answer.kind === 'needs-code') {
        const repo = parseRepo(issues);

        if (repo === undefined)
          return refused('invalid-setting', 'improve.issueRepo names no <owner/repo>');
        // Send to Abe: a draft the person reads first; `abe issue create` files it.
        return {
          ok: true,
          data: {
            kind: 'needs-code',
            wish,
            draft: {
              repo,
              title: answer.title,
              body: needsCodeBody({ wish, body: answer.body }),
            },
            model,
            issues: repo,
          },
        };
      }
      const made = makePersonalProposal(ctx, {
        wish,
        summary: answer.summary,
        files: answer.files,
        from: 'wish',
        model,
      });

      if (!made.ok)
        return made.error.code === 'no-change'
          ? {
              ok: true,
              data: { kind: 'nothing', wish, reason: made.error.message, model, issues },
            }
          : made;

      return {
        ok: true,
        data: { kind: 'proposal', proposal: made.data, model, shown: shownOf(made.data), issues },
      };
    },
    'improve apply': (args, ctx): Promise<Outcome<ImproveApplyData>> => {
      const record = recordOf(ctx, args.id);

      if (!record.ok) return Promise.resolve(record);
      const layer = layerOf(ctx);
      const state = stateOf(ctx);

      if (!layer.ok) return Promise.resolve(layer);
      if (!state.ok) return Promise.resolve(state);
      const p = record.data;

      if (p.applied !== null)
        return Promise.resolve(
          refused(
            'already-applied',
            `${p.id} was applied at ${p.applied}: abe improve undo takes it back`,
          ),
        );
      // Checked again: a link may reach out of the Layer since it was proposed.
      const reached = pathsRefused(layer.data, p.files);

      if (!reached.ok) return Promise.resolve(reached);
      const stale = staleFiles(
        p.files,
        currentOf(
          layer.data.dir,
          p.files.map((f) => f.path),
        ),
      );

      if (stale.length > 0)
        return Promise.resolve(
          refused(
            'stale-proposal',
            `changed since ${p.id} was proposed: ${stale.join(', ')}; ask again with abe improve`,
          ),
        );
      const at = iso(ctx.serve.clock.now());
      const entries = pushUndo(undoStackOf(state.data), {
        id: p.id,
        at,
        files: p.files.map((f) => ({ path: f.path, before: f.before, after: f.after })),
      });

      // The state before is kept first: a write that fails half-way is still undone.
      writeUndo(state.data, { v: 1, entries } satisfies UndoStack);
      for (const f of p.files) writeAt(layer.data.dir, f.path, f.after);
      writeProposal(state.data, p.id, { ...p, applied: at } satisfies ProposalRecord);
      changed(
        ctx,
        p.files.map((f) => f.path),
      );

      return Promise.resolve({
        ok: true,
        data: {
          id: p.id,
          files: p.files.map((f) => ({
            path: f.path,
            file: fileAt(layer.data.dir, f.path),
            change: fileChange(f.before, f.after),
          })),
          undo: entries.length,
        },
      });
    },
    'improve undo': (args, ctx): Promise<Outcome<ImproveUndoData>> => {
      const layer = layerOf(ctx);
      const state = stateOf(ctx);

      if (!layer.ok) return Promise.resolve(layer);
      if (!state.ok) return Promise.resolve(state);
      const entries = undoStackOf(state.data);
      const last = entries.at(-1);

      if (last === undefined)
        return Promise.resolve(refused('nothing-to-undo', 'no applied change is left to undo'));
      const linked = last.files
        .filter((f) => !isLocalPath(f.path) && !staysInLayer(layer.data.dir, f.path))
        .map((f) => f.path);

      if (linked.length > 0)
        return Promise.resolve(
          refused(
            'outside-personal-layer',
            `outside your personal Layer now: ${linked.join('; ')}`,
          ),
        );
      // Stale when a file no longer reads as the apply left it.
      const since = staleFiles(
        last.files.map((f) => ({ path: f.path, before: f.after, after: f.before })),
        currentOf(
          layer.data.dir,
          last.files.map((f) => f.path),
        ),
      );

      if (since.length > 0 && !args.force)
        return Promise.resolve(
          refused(
            'stale-undo',
            `changed since ${last.id} was applied: ${since.join(', ')}; abe improve undo --force puts them back anyway`,
          ),
        );
      const files = last.files.map((f) => {
        const now = readAt(layer.data.dir, f.path);

        writeAt(layer.data.dir, f.path, f.before);

        return {
          path: f.path,
          file: fileAt(layer.data.dir, f.path),
          change: fileChange(now, f.before),
        };
      });

      writeUndo(state.data, { v: 1, entries: entries.slice(0, -1) } satisfies UndoStack);
      const record = recordOf(ctx, last.id);

      if (record.ok) writeProposal(state.data, last.id, { ...record.data, applied: null });
      changed(
        ctx,
        last.files.map((f) => f.path),
      );

      return Promise.resolve({
        ok: true,
        data: {
          id: last.id,
          summary: record.ok ? record.data.summary : null,
          files,
          left: entries.length - 1,
        },
      });
    },
    'improve suggest': async (_, ctx): Promise<Outcome<ImproveSuggestData>> => {
      const state = stateOf(ctx);

      if (!state.ok) return state;
      if (ctx.settings === undefined)
        return refused('no-settings', 'this abe serve was started without its settings');
      const stamp = SuggestStamp.safeParse(readSuggested(state.data));
      const now = ctx.serve.clock.now();
      const may = maySuggest({
        enabled: ctx.settings.at(ctx.cwd).values['improve.suggest'],
        last: stamp.success ? Date.parse(stamp.data.at) : undefined,
        now,
      });

      if (!may.ok) return refused(may.code, may.message);
      const asked = await askImprove(ctx, { wish: '', recent: ctx.serve.recentCommands() });

      if (!asked.ok) return asked;
      // Counted once the agent answered: a one-shot that never ran leaves the day open.
      writeSuggested(state.data, { v: 1, at: iso(now) });
      const next = iso(now + SUGGEST_EVERY_MS);
      const { answer, model } = asked.data;
      const issues = abeIssuesOf(ctx);
      const nothing = (reason: string): Outcome<ImproveSuggestData> => ({
        ok: true,
        data: { next, suggestion: { kind: 'nothing', wish: '', reason, model, issues } },
      });

      if (answer.kind === 'nothing') return nothing(answer.reason);
      // A suggestion never files an issue by itself.
      if (answer.kind === 'needs-code')
        return nothing(`it would need VimStorm's code: ${answer.title}`);
      const made = makePersonalProposal(ctx, {
        wish: `(suggested) ${answer.summary}`,
        summary: answer.summary,
        files: answer.files,
        from: 'suggest',
        model,
      });

      if (!made.ok) return made.error.code === 'no-change' ? nothing(made.error.message) : made;

      return {
        ok: true,
        data: {
          next,
          suggestion: {
            kind: 'proposal',
            proposal: made.data,
            model,
            shown: shownOf(made.data),
            issues,
          },
        },
      };
    },
  }) satisfies Partial<Handlers<Ctx>>;
