/**
 * `abe improve retro` (ticket #86, ADR 0019): Improve looking back. `improve retro me`
 * lists the scope's prefixes in the log store (and nothing else), reads each session that moved
 * since the scope's last retro, adds the retro's own sources (each run's pull request comments
 * through `gh`, the Overrides in force) and the pull requests earlier retros opened (by their
 * label), and asks one one-shot with core's retro skill. It keeps the findings and emits
 * `improve.retro`; it writes nothing else. `improve retro make <n>` writes a repo fix into the
 * checkout uncommitted (`--pr`: opens the finding's one pull request instead), files a Send to
 * Abe finding's issue on `improve.issueRepo`, or hands a personal fix to `abe improve`. The rules are core's (`core/src/improve/retro.ts`).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type EarlierPull,
  findFinding,
  inPrefixes,
  type Journal,
  LAYERS_SESSION,
  layerRepoPath,
  logSessions,
  type LogStore,
  type Made,
  movedSince,
  type Outcome,
  parseRepo,
  RETRO_LABEL,
  RETRO_LABEL_DESCRIPTION,
  RETRO_SKILL,
  retroBranch,
  retroCommitMessage,
  type RetroData,
  retroPrBody,
  retroPrefixes,
  retroPrompt,
  retroPrTitle,
  type RetroPulls,
  RetroRecord,
  retroScopeKey,
  type RetroSession,
  type RetroSource,
  readRetro,
  redactText,
  refused,
  type Repo,
  scopeTimeAfter,
  sessionsToRead,
  settingKeys,
  showRef,
  StoredMeta,
  StoredRun,
  type PullComment,
  type Handlers,
  LAYER_FILE,
  REPO_PATH,
  REPO_SKILLS_DIR,
  REPO_WORKFLOWS_DIR,
} from '@abe/core';
import {
  keepRetroSource,
  keepUnreadableRetro,
  newRetroId,
  originRepo,
  readLayerFiles,
  readRetroRecord,
  readRetroScopes,
  repoRoot,
  writeRetroRecord,
  writeRetroScope,
} from '@abe/ports';
import { type LogsCtx } from './logs';

/**
 * The repo Layer's files as a fix sees them (ADR 0031, `layerRepoPath`): its abe.yaml as
 * `settings.yaml`, its `abe/workflows/` as `workflows/`, its `.claude/skills/` as `skills/`.
 * Never `.abe/`: yours alone, secrets in it.
 */
const repoLayerFiles = (checkout: string): { path: string; text: string }[] => [
  ...(existsSync(join(checkout, REPO_PATH))
    ? [{ path: LAYER_FILE, text: readFileSync(join(checkout, REPO_PATH), 'utf8') }]
    : []),
  ...readLayerFiles(join(checkout, REPO_WORKFLOWS_DIR)).map((f) => ({
    ...f,
    path: `workflows/${f.path}`,
  })),
  ...readLayerFiles(join(checkout, REPO_SKILLS_DIR)).map((f) => ({
    ...f,
    path: `skills/${f.path}`,
  })),
];
import { askOneShot, type OneShotCtx } from '../layer/one-shot';
import { type ReachCtx, sessionReach } from '../layer/reach';
import { type ImproveCtx, makePersonalProposal, noLayerPulls } from './improve';
import { type BoardCtx } from '../board/board';
import { notVisible } from '../board/tracking';

export type RetroCtx = ReachCtx &
  OneShotCtx &
  LogsCtx & {
    ports: { retroPulls: RetroPulls | undefined };
    /** The session whose socket the request came in on; undefined on `serve`'s own socket. */
    session: string | undefined;
    serve: {
      emit: Journal['emit'];
      /** Where retros are kept (serve's state directory); without it a retro is refused. */
      retroDir: string | undefined;
    };
  } & ImproveCtx &
  Pick<BoardCtx, 'ports'> & { serve: Pick<BoardCtx['serve'], 'localMode'> };

const text = new TextDecoder();

const noState = () =>
  refused('no-state', 'this abe serve has no state directory for Improve retro');

const noStore = () =>
  refused(
    'no-log-store',
    "this abe serve has no log store, so no session's logs were kept to look back over (a local install sets none). Keep them on this machine: abe settings set stores.logs file://<a folder> (or s3://<bucket>; $ABE_LOG_STORE wins), then abe serve stop once no session is live: the sessions after that are kept",
  );

const noPulls = () =>
  refused('no-github', 'this abe serve was started without GitHub for Improve retro');

/** The stored file's text, or `undefined` when it cannot be read. */
const getText = async (store: LogStore, key: string): Promise<string | undefined> => {
  const got = await store.get(key);

  return got.ok ? text.decode(got.data) : undefined;
};

const json = (raw: string | undefined): unknown => {
  if (raw === undefined) return undefined;
  try {
    const doc: unknown = JSON.parse(raw);

    return doc;
  } catch {
    return undefined;
  }
};

const pullCommentsText = (ref: string, comments: readonly PullComment[]) =>
  `${[
    `# What people said on ${ref}`,
    '',
    ...comments.flatMap((c) => [
      `- ${c.at} ${c.author} ${c.kind}${c.state === null ? '' : ` ${c.state}`}${c.path === null ? '' : ` on ${c.path}`}:`,
      ...(c.body.trim() === ''
        ? ['  (no words)']
        : c.body
            .trim()
            .split('\n')
            .map((l) => `  ${l}`)),
    ]),
  ].join('\n')}\n`;

/** The Overrides in force in the checkout, one line each with its Layer, value and reason. */
const overridesText = (ctx: RetroCtx, checkout: string): string | undefined => {
  if (ctx.settings === undefined) return undefined;
  const merged = ctx.settings.at(checkout);
  const lines = settingKeys().flatMap((key) =>
    merged
      .explain(key)
      .layers.filter((step) => step.entry === 'override')
      .map(
        (step) =>
          `- ${step.layer} · ${key} = ${JSON.stringify(step.written)} · reason: ${step.reason ?? '(none)'} · ${step.applied ? 'in force' : 'refused'}${step.file === null ? '' : ` (${step.file})`}`,
      ),
  );

  return lines.length === 0 ? undefined : `# Overrides in force\n\n${lines.join('\n')}\n`;
};

/** The pull requests earlier retros opened in each Layer repo, merged: the fixes in force. */
const earlierFixes = async (
  pulls: RetroPulls,
  repos: readonly Repo[],
): Promise<Outcome<EarlierPull[]>> => {
  const found: EarlierPull[] = [];

  for (const repo of [...new Set(repos)]) {
    const listed = await pulls.labelled(repo, RETRO_LABEL);

    if (!listed.ok) return refused(listed.error.code, listed.error.message);
    for (const p of listed.data)
      if (p.state === 'merged' && p.mergedAt !== null)
        found.push({
          pr: showRef({ repo: p.repo, number: p.number }),
          url: p.url,
          title: p.title,
          mergedAt: new Date(p.mergedAt).toISOString(),
        });
  }

  return { ok: true, data: found };
};

/** The last retro, or why there is none. */
const lastRetro = (ctx: RetroCtx): Outcome<{ record: RetroRecord; dir: string }> => {
  if (ctx.serve.retroDir === undefined) return noState();
  const doc = RetroRecord.safeParse(readRetroRecord(ctx.serve.retroDir));

  return doc.success
    ? { ok: true, data: { record: doc.data, dir: ctx.serve.retroDir } }
    : refused('no-retro', 'no Improve retro yet: run abe improve retro me first');
};

/** The retro `id` names (the last one when none), and whether it is the last. */
const retroNamed = (
  ctx: RetroCtx,
  id: string | undefined,
): Outcome<{ record: RetroRecord; dir: string; last: boolean }> => {
  const last = lastRetro(ctx);

  if (id === undefined || (last.ok && last.data.record.id === id))
    return last.ok ? { ok: true, data: { ...last.data, last: true } } : last;
  if (ctx.serve.retroDir === undefined) return noState();
  const doc = RetroRecord.safeParse(readRetroRecord(ctx.serve.retroDir, id));

  return doc.success
    ? { ok: true, data: { record: doc.data, dir: ctx.serve.retroDir, last: false } }
    : refused('no-retro', `no Improve retro ${id}`);
};

/** Who a retro in `checkout` reads for: its GitHub repo (your sessions' prefix) and your login. */
const retroWho = async (
  ctx: RetroCtx,
  checkout: string,
): Promise<Outcome<{ repo: Repo; login: string }>> => {
  const repo = await originRepo(checkout);

  if (repo === undefined)
    return refused(
      'no-origin',
      `${checkout} has no origin on GitHub: your sessions in the log store are under its repo`,
    );
  const me = await ctx.ports.tracking.me();

  return me.ok
    ? { ok: true, data: { repo, login: me.data.login } }
    : refused(me.error.code, `your GitHub login: ${me.error.message}`);
};

const isoOr = (given: string | undefined): Outcome<string | undefined> => {
  if (given === undefined) return { ok: true, data: undefined };
  const at = Date.parse(given);

  return Number.isNaN(at)
    ? refused('usage', `--since is no time: ${given}`, 2)
    : { ok: true, data: new Date(at).toISOString() };
};

const madeName = (m: Made) => {
  if (m.kind === 'pr') return m.pr;
  if (m.kind === 'issue') return m.issue;

  return m.kind === 'proposal' ? m.id : m.files.join(', ');
};

export const retroHandlers = <Ctx extends RetroCtx>() =>
  ({
    'improve retro': async (args, ctx): Promise<Outcome<RetroData>> => {
      if (ctx.serve.retroDir === undefined) return noState();
      const checkout = repoRoot(ctx.cwd) ?? ctx.cwd;
      // local mode (#24): the sessions kept on this Mac (`<state>/local/logs`), never the store's
      const store = ctx.serve.logs?.storeAt(checkout);

      if (store === undefined) return noStore();
      if (ctx.ports.retroPulls === undefined) return noPulls();
      const { retroDir } = ctx.serve;
      const pulls = ctx.ports.retroPulls;
      const asked = await retroWho(ctx, checkout);

      if (!asked.ok) return asked;
      const who = asked.data;
      const given = isoOr(args.since);

      if (!given.ok) return given;
      const scopeKey = retroScopeKey(args.scope, who);
      const since = given.data ?? readRetroScopes(retroDir)[scopeKey] ?? null;
      const prefixes = retroPrefixes(args.scope, who);
      // Only the scope's prefixes are listed, and every key read is checked against them again.
      const objects = [];

      for (const prefix of prefixes) {
        const listed = await store.list(prefix);

        if (!listed.ok) return refused(listed.error.code, listed.error.message);
        objects.push(...listed.data.filter((o) => inPrefixes(o.key, prefixes)));
      }
      const moved: RetroSession[] = [];
      const unread: RetroData['unread'] = [];

      for (const s of logSessions(objects)) {
        const prefix = `${s.repo}/${s.user}/${s.session}/`;
        const meta = StoredMeta.safeParse(json(await getText(store, `${prefix}meta.json`)));

        if (!meta.success || !movedSince(meta.data, since)) continue;
        // A moment names its session by id alone: two people's sessions with one id stay unread.
        const twin = moved.find((m) => m.session === s.session);

        if (twin !== undefined) {
          unread.push({
            source: prefix,
            why: `session id ${s.session} is ${twin.repo}/${twin.user}'s too`,
          });
          continue;
        }
        const files: RetroSession['files'] = [];

        for (const name of s.files) {
          const read = await getText(store, `${prefix}${name}`);

          if (read !== undefined) files.push({ name, text: read });
        }
        moved.push({
          session: s.session,
          repo: s.repo,
          user: s.user,
          card: meta.data.card,
          title: meta.data.title,
          since: meta.data.since,
          files,
        });
      }
      const { read, leftOut } = sessionsToRead(moved);
      const id = newRetroId(ctx.serve.clock.now());
      const at = new Date(ctx.serve.clock.now()).toISOString();
      // The retro's own sources: each run's pull request comments, the Overrides in force.
      const extra: RetroSource[] = [];

      for (const s of read) {
        const run = StoredRun.safeParse(json(s.files.find((f) => f.name === 'run.json')?.text));
        const pr = run.success ? run.data.pr : null;
        const repo = pr === null ? undefined : parseRepo(pr.repo);

        if (pr === null || repo === undefined) continue;
        const ref = { repo, number: pr.number };
        const said = await pulls.comments(ref);

        // A pull request this person cannot read (another org's repo) leaves the rest to read.
        if (!said.ok) {
          unread.push({
            source: `${s.session}/pr-comments.md`,
            why: `${showRef(ref)}: ${said.error.message}`,
          });
          continue;
        }
        extra.push({
          session: s.session,
          name: 'pr-comments.md',
          text: redactText(pullCommentsText(showRef(ref), said.data), []),
        });
      }
      const overrides = overridesText(ctx, checkout);

      if (overrides !== undefined)
        extra.push({ session: LAYERS_SESSION, name: 'overrides.md', text: overrides });
      const earlier = await earlierFixes(pulls, [who.repo]);

      if (!earlier.ok) return earlier;
      let data: RetroData = {
        id,
        at,
        scope: args.scope,
        repo: who.repo,
        login: who.login,
        since,
        prefixes,
        sessions: read.map((s) => ({
          session: s.session,
          repo: s.repo,
          user: s.user,
          card: s.card,
          title: s.title,
          since: s.since,
          files: s.files.length,
        })),
        leftOut: leftOut.length,
        unread,
        model: '',
        findings: [],
        earlier: [],
        dropped: [],
      };

      if (read.length > 0) {
        const layers = [
          { layer: 'repo' as const, repo: who.repo, files: repoLayerFiles(checkout) },
        ];
        const reach = await sessionReach(ctx, 'local');

        if (!reach.ok) return reach;
        const oneShot = await askOneShot(ctx, {
          // The fixes are written whole: a writer's model.
          role: 'writer',
          reach: reach.data.env,
          cwd: checkout,
          prompt: retroPrompt({
            scope: args.scope,
            who,
            sessions: read,
            extra,
            earlier: earlier.data,
            layers,
          }),
          system: RETRO_SKILL,
        });

        if (!oneShot.ok) return oneShot;
        const sources: RetroSource[] = [
          ...read.flatMap((s) => s.files.map((f) => ({ session: s.session, ...f }))),
          ...extra,
        ];
        const answer = readRetro(oneShot.data.text, { sources, earlier: earlier.data });

        if (!answer.ok)
          return refused(
            'retro-unreadable',
            `the one-shot's answer is no findings (${answer.message}); kept as it came in ${keepUnreadableRetro(retroDir, oneShot.data.text, ctx.serve.clock.now())}`,
          );
        data = {
          ...data,
          model: oneShot.data.model,
          findings: answer.findings,
          earlier: answer.earlier,
          dropped: answer.dropped,
        };
      }
      // A retro that read nothing keeps nothing: the last retro, and its scope's time, stand.
      if (read.length === 0) return { ok: true, data };
      for (const x of extra) keepRetroSource(retroDir, id, x);
      const kept: RetroRecord = { v: 1, checkout, ...data };

      writeRetroRecord(retroDir, kept, { last: true });
      // `--since` reads a window of its own: the scope's own time stays.
      if (given.data === undefined)
        writeRetroScope(retroDir, scopeKey, scopeTimeAfter(read, leftOut, at));
      ctx.serve.emit('improve.retro', {
        step: 'found',
        retro: id,
        scope: args.scope,
        repo: who.repo,
        sessions: read.length,
        findings: data.findings.length,
        dropped: data.dropped.length,
        removals: data.earlier.filter((e) => e.removal).length,
      });

      return { ok: true, data };
    },
    'improve retro make': async (args, ctx) => {
      // the person's (or the Abe chat's, which runs as them): never a session's
      if (ctx.session !== undefined)
        return refused(
          'not-your-session',
          `session ${ctx.session}: only a person or the Abe chat makes a finding`,
        );
      const named = retroNamed(ctx, args.retro);

      if (!named.ok) return named;
      const { record, dir: retroDir, last: isLast } = named.data;
      const finding = findFinding(record, args.finding);

      if (finding === undefined)
        return refused(
          'no-finding',
          `the Improve retro ${record.id} has no finding ${args.finding}: it has ${record.findings.length}`,
        );
      const answer = (
        result: 'opened' | 'proposed' | 'written' | 'filed' | 'already-made',
        made: Made,
      ) => {
        if (finding.made === null) {
          const kept: RetroRecord = {
            ...record,
            findings: record.findings.map((f) => (f.n === finding.n ? { ...f, made } : f)),
          };

          writeRetroRecord(retroDir, kept, { last: isLast });
        }
        if (result !== 'already-made')
          ctx.serve.emit('improve.retro', {
            step: 'made',
            retro: record.id,
            finding: finding.n,
            layer: finding.layer,
            made: madeName(made),
          });

        return {
          ok: true as const,
          data: {
            retro: record.id,
            finding: finding.n,
            title: finding.title,
            layer: finding.layer,
            result,
            made,
          },
        };
      };

      if (finding.made !== null) return answer('already-made', finding.made);
      if (finding.layer === 'individual') {
        // Your own Layer is written only by `abe improve apply`: the fix becomes its proposal.
        const proposed = makePersonalProposal(
          { ...ctx, cwd: record.checkout },
          {
            wish: `${finding.title} (improve retro ${record.id}, finding ${finding.n})`,
            summary: finding.fix.summary,
            files: finding.fix.files.map((f) => ({ path: f.path, after: f.content })),
            from: 'retro',
            model: record.model === '' ? null : record.model,
          },
        );

        return proposed.ok
          ? answer('proposed', {
              kind: 'proposal',
              id: proposed.data.id,
              files: finding.fix.files.map((f) => f.path),
            })
          : proposed;
      }
      if (finding.layer === 'abe') {
        const issue = finding.fix.issue;
        const repo = parseRepo(ctx.settings?.at(record.checkout).values['improve.issueRepo'] ?? '');

        if (issue === null) return refused('no-finding', `finding ${finding.n} drafts no issue`);
        // filed only on the person's File it, never on picking the finding
        if (!args.file)
          return refused(
            'not-confirmed',
            `finding ${finding.n} is Send to Abe: show its whole issue body in the chat, ask Don't file, Change it or File it, in that order (never File it first), and only on File it run abe improve retro make ${finding.n} --file`,
          );
        if (repo === undefined)
          return refused('invalid-setting', 'improve.issueRepo names no <owner/repo>');
        const filed = await ctx.ports.tracking.issueCreate({
          repo,
          title: issue.title,
          body: `${issue.body}\n\nFrom an Improve retro, a ${finding.severity} finding.`,
          labels: [],
        });

        return filed.ok
          ? answer('filed', {
              kind: 'issue',
              issue: showRef({ repo, number: filed.data.number }),
              url: filed.data.url,
            })
          : notVisible({ ...ctx, cwd: record.checkout }, repo, filed);
      }
      if (!args.pr) {
        // Fix here: the files land in the checkout uncommitted, for the person's own git diff.
        const root = repoRoot(record.checkout) ?? record.checkout;
        const paths = finding.fix.files.map((f) => {
          const path = layerRepoPath(f.path);
          const file = join(root, path);

          if (f.content === null) rmSync(file, { force: true });
          else {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, f.content);
          }

          return path;
        });

        return answer('written', { kind: 'written', files: paths });
      }
      if (ctx.ports.layerPulls === undefined) return noLayerPulls();
      // Local mode (#24) where the retro's checkout is, wherever it was typed: the proposal held.
      const layerPulls =
        ctx.serve.localMode?.layerPulls(ctx.ports.layerPulls, record.checkout) ??
        ctx.ports.layerPulls;
      const repo = await originRepo(record.checkout);

      if (repo === undefined)
        return refused(
          'no-layer-repo',
          `${record.checkout} has no origin on GitHub: the repo Layer has no pull requests`,
        );
      const branch = retroBranch(record.id, finding.n);
      const files = finding.fix.files.map((f) => ({
        path: layerRepoPath(f.path),
        content: f.content,
      }));
      // One pull request per finding: an open one on its branch (a make that answered no record) is it.
      const open = await ctx.ports.tracking.prFind({ repo, head: branch });

      if (!open.ok) return refused(open.error.code, open.error.message);
      const madeOf = (number: number, url: string): Made => ({
        kind: 'pr',
        pr: showRef({ repo, number }),
        url,
        branch,
        files: files.map((f) => f.path),
      });

      if (open.data !== null)
        return answer('already-made', madeOf(open.data.number, open.data.url));
      const base = await layerPulls.base(repo);

      if (!base.ok) return refused(base.error.code, base.error.message);
      const proposed = await layerPulls.propose({
        repo,
        base: base.data,
        branch,
        title: retroPrTitle(record, finding),
        body: retroPrBody(record, finding),
        message: retroCommitMessage(record, finding),
        label: { name: RETRO_LABEL, description: RETRO_LABEL_DESCRIPTION },
        files,
      });

      return proposed.ok
        ? answer('opened', madeOf(proposed.data.number, proposed.data.url))
        : refused(proposed.error.code, proposed.error.message);
    },
    'improve retro last': (_, ctx) => {
      const last = lastRetro(ctx);

      return Promise.resolve(last.ok ? { ok: true, data: last.data.record } : last);
    },
  }) satisfies Partial<Handlers<Ctx>>;
