/**
 * `abe sheet`: Sheets kept in your environment (this `serve`'s state directory: the session's box
 * when `serve` runs there, else this Mac), attached to a card through the org store and the
 * Board, and served with no network by the `SheetHost`. The rules are core's (`sheets.ts`).
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type Clock,
  findYours,
  type Handlers,
  type Journal,
  listOrder,
  notSelfContainedMessage,
  type OrgStore,
  type Outcome,
  parseCardId,
  parseSheetRef,
  planSave,
  rankSheets,
  refused,
  selfContainedProblems,
  sheetAddress,
  type SheetContext,
  SHEET_CSP,
  SHEET_HEADERS,
  type SheetHost,
  sheetInfoKey,
  sheetKey,
  type SheetAttachData,
  sheetHostKey,
  type SheetMeta,
  type SheetOpenData,
  summaryOf,
  titleProblem,
  withAttached,
  type Commands,
  type Handler,
} from '@abe/core';
import { type LocalSheets, localSheets } from '@abe/ports';
import { type BoardCtx, withCard, withOwnCard } from '../board/board';
import { ownPath } from '../session/own';
import { cardSheets, readOrgSheet } from './org';
import { orgAt } from '../local-mode/local-mode';
import { requestCard, type WorkspaceCtx } from '../box/workspace';

export type SheetsOptions = {
  /** Where your Sheets are kept: `sheets` in `serve`'s state directory. */
  dir: string;
  host: SheetHost;
  /** Where an attach copies a Sheet; without one, attach is refused. */
  org?: OrgStore | undefined;
};

export type Sheets = {
  local: LocalSheets;
  host: SheetHost;
  /** Runs saves and attaches one at a time, so two never write the same Sheet at once. */
  serial: <T>(run: () => Promise<T>) => Promise<T>;
};

export const openSheets = (o: SheetsOptions): Sheets => {
  let queue: Promise<unknown> = Promise.resolve();

  return {
    local: localSheets(o.dir),
    host: o.host,
    serial: <T>(run: () => Promise<T>) => {
      const next = queue.then(run, run);

      queue = next.catch(() => undefined);

      return next;
    },
  };
};

export type SheetsCtx = BoardCtx &
  WorkspaceCtx & {
    serve: {
      sheets: Sheets | undefined;
      clock: Clock;
      emit: Journal['emit'];
    };
  };

const usage = (message: string) => refused('usage', message, 2);

const NO_SHEETS = refused('no-sheets', 'this abe serve keeps no Sheets');

const NO_ORG_STORE = refused(
  'no-org-store',
  'no org store to attach to: ABE_ORG_STORE names none (file://<dir> or s3://<bucket>)',
);

const text = new TextDecoder();
const bytes = new TextEncoder();

const withSheets = <T>(ctx: SheetsCtx, then: (s: Sheets) => Promise<Outcome<T>>) =>
  ctx.serve.sheets === undefined ? Promise.resolve<Outcome<T>>(NO_SHEETS) : then(ctx.serve.sheets);

/** A `--card` given, as a number; `undefined` when none was; a usage refusal when it is no id. */
const cardFlag = (card: string | undefined): Outcome<number | null> => {
  if (card === undefined) return { ok: true, data: null };
  const id = parseCardId(card);

  return id === undefined ? usage(`not a card id (4, AB#4): ${card}`) : { ok: true, data: id };
};

/** The context `list` and `find` put first: the flags, else the box's workspace card. */
const contextOf = (
  args: { card?: string; session?: string },
  ctx: SheetsCtx,
): Outcome<SheetContext> => {
  const card = cardFlag(args.card);

  if (!card.ok) return card;
  // On a box, the card whose workspace (or session) asked (ADR 0022: one workspace per card).
  const asking = card.data === null && ctx.serve.box !== undefined ? requestCard(ctx) : undefined;

  return {
    ok: true,
    data: {
      card: card.data ?? (asking === undefined ? null : (parseCardId(asking) ?? null)),
      session: args.session ?? null,
    },
  };
};

/** Yours, by id or title, at `version` (default the newest). */
const yours = async (
  s: Sheets,
  ref: string,
  version: number | undefined,
): Promise<Outcome<{ meta: SheetMeta; version: number }>> => {
  const parsed = parseSheetRef(ref);

  if (parsed === undefined) return usage(`not a Sheet (an id, a title or <card>/<id>): ${ref}`);
  if (parsed.kind === 'card')
    return refused(
      'not-yours',
      `${ref} is attached to AB#${parsed.card}, not one of yours: abe sheet open ${ref} opens it`,
    );
  const meta = findYours(await s.local.all(), parsed.id);

  if (meta === undefined) return refused('not-found', `no Sheet of yours is ${parsed.id}`);
  const n = version ?? meta.versions.at(-1)?.n ?? 1;

  return meta.versions.some((v) => v.n === n)
    ? { ok: true, data: { meta, version: n } }
    : refused('not-found', `${meta.id} has no v${n} (it has v1 to v${meta.versions.length})`);
};

const opened = async (
  s: Sheets,
  page: Omit<SheetOpenData, 'url' | 'csp'>,
  html: Uint8Array,
): Promise<Outcome<SheetOpenData>> => {
  const key = sheetHostKey(page.card, page.id, page.version);
  const { url } = await s.host.open({ key, html, headers: SHEET_HEADERS });

  return { ok: true, data: { ...page, url, csp: SHEET_CSP } };
};

/** `abe card show`: the card, with the Sheets attached to it. */
export const cardShow: Handler<Commands['card show'], BoardCtx> = (args, ctx) =>
  withCard(ctx, args.id, async (board, id) => {
    const card = await ctx.ports.board.show(board, id);

    return card.ok
      ? { ok: true, data: { ...card.data, sheets: await cardSheets(orgAt(ctx, ctx.cwd), id) } }
      : card;
  });

export const sheetsHandlers = <C extends SheetsCtx>() =>
  ({
    'card show': cardShow,
    'sheet save': (args, ctx) =>
      withSheets(ctx, async (s) => {
        const problem = titleProblem(args.title);

        if (problem !== undefined) return usage(problem);
        const card = cardFlag(args.card);

        if (!card.ok) return card;
        const own = await ownPath(ctx, args.file);

        if (!own.ok) return own;
        const path = own.data;
        let html: Uint8Array;

        try {
          html = new Uint8Array(await readFile(path));
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);

          return refused('unreadable-file', `cannot read the page ${path}: ${why}`);
        }
        const page = text.decode(html);

        if (page.trim() === '') return refused('empty-sheet', `the page ${path} is empty`);
        const problems = selfContainedProblems(page);

        if (problems.length > 0)
          return refused('sheet-not-self-contained', notSelfContainedMessage(problems));
        const session = args.session ?? null;
        const saved = await s.serial(async () => {
          const plan = planSave(await s.local.all(), {
            title: args.title,
            card: card.data,
            session,
            at: new Date(ctx.serve.clock.now()).toISOString(),
            bytes: html.byteLength,
            suffix: randomBytes(3).toString('hex'),
          });

          await s.local.write(plan.meta, plan.version, html);

          return plan;
        });
        const { meta } = saved;

        ctx.serve.emit('sheet.saved', {
          id: meta.id,
          title: meta.title,
          version: saved.version,
          card: meta.card,
          session: meta.session,
        });

        return {
          ok: true,
          data: {
            id: meta.id,
            title: meta.title,
            version: saved.version,
            card: meta.card,
            session: meta.session,
            path: s.local.path(meta.id, saved.version),
            address: sheetAddress(meta.id),
          },
        };
      }),
    'sheet list': (args, ctx) =>
      withSheets(ctx, async (s) => {
        const context = contextOf(args, ctx);

        if (!context.ok) return context;
        const sheets = (await s.local.all()).map(summaryOf);

        return { ok: true, data: { ...context.data, sheets: listOrder(sheets, context.data) } };
      }),
    'sheet find': (args, ctx) =>
      withSheets(ctx, async (s) => {
        const context = contextOf(args, ctx);

        if (!context.ok) return context;
        const query = args.name.join(' ');
        const sheets = (await s.local.all()).map(summaryOf);

        return {
          ok: true,
          data: { ...context.data, query, sheets: rankSheets(sheets, query, context.data) },
        };
      }),
    'sheet show': (args, ctx) =>
      withSheets(ctx, async (s) => {
        const found = await yours(s, args.id, args.version);

        if (!found.ok) return found;
        const { meta, version } = found.data;

        return {
          ok: true,
          data: {
            ...meta,
            version,
            path: s.local.path(meta.id, version),
            address: sheetAddress(meta.id),
          },
        };
      }),
    'sheet attach': (args, ctx) =>
      withSheets(ctx, async (s) => {
        // Local mode (#24): attached on this Mac, never to the org's store.
        const org = orgAt(ctx, ctx.cwd);

        if (org === undefined) return NO_ORG_STORE;
        const found = await yours(s, args.id, undefined);

        if (!found.ok) return found;
        const { meta, version } = found.data;

        return withOwnCard(ctx, args.card, (board, card) =>
          // One at a time: two attaches at once would each write `sheet.json` without the other's.
          s.serial(async (): Promise<Outcome<SheetAttachData>> => {
            // The card first: nothing goes to the store for a card that is not there.
            const shown = await ctx.ports.board.show(board, card);

            if (!shown.ok) return shown;
            const html = await s.local.read(meta.id, version);

            if (html === undefined)
              return refused(
                'not-found',
                `${meta.id} v${version}'s page is gone from ${s.local.dir}`,
              );
            const key = sheetKey(card, meta.id, version);
            const put = await org.put(key, html, 'text/html; charset=utf-8');

            if (!put.ok) return put;
            const at = new Date(ctx.serve.clock.now()).toISOString();
            const before = await readOrgSheet(org, card, meta.id);

            if (!before.ok) return before;
            // Nothing written on the card (`NOT_COMMENTED`): `card show` lists it from the store.
            const info = withAttached(before.data, { id: meta.id, title: meta.title, version, at });
            const infoPut = await org.put(
              sheetInfoKey(card, meta.id),
              bytes.encode(`${JSON.stringify(info, null, 2)}\n`),
              'application/json',
            );

            if (!infoPut.ok) return infoPut;
            const now = findYours(await s.local.all(), meta.id) ?? meta;

            await s.local.update({
              ...now,
              attached: [
                ...now.attached.filter((a) => a.card !== card || a.version !== version),
                { card, version, at, key },
              ],
            });
            ctx.serve.emit('sheet.attached', {
              id: meta.id,
              title: meta.title,
              version,
              card,
              key,
            });

            return {
              ok: true,
              data: {
                id: meta.id,
                title: meta.title,
                version,
                card,
                key,
                address: sheetAddress(meta.id, card),
              },
            };
          }),
        );
      }),
    'sheet open': (args, ctx) =>
      withSheets(ctx, async (s) => {
        const ref = parseSheetRef(args.id);

        if (ref?.kind === 'card') {
          const org = orgAt(ctx, ctx.cwd);

          if (org === undefined) return NO_ORG_STORE;
          const info = await readOrgSheet(org, ref.card, ref.id);

          if (!info.ok) return info;
          if (info.data === undefined)
            return refused('not-found', `no Sheet ${ref.id} is attached to AB#${ref.card}`);
          const n = args.version ?? info.data.versions.at(-1)?.n ?? 1;

          if (!info.data.versions.some((v) => v.n === n))
            return refused('not-found', `${ref.id} v${n} is not attached to AB#${ref.card}`);
          const html = await org.get(sheetKey(ref.card, ref.id, n));

          if (!html.ok) return html;

          return opened(
            s,
            {
              id: ref.id,
              title: info.data.title,
              version: n,
              card: ref.card,
              address: sheetAddress(ref.id, ref.card),
            },
            html.data,
          );
        }
        const found = await yours(s, args.id, args.version);

        if (!found.ok) return found;
        const { meta, version } = found.data;
        const html = await s.local.read(meta.id, version);

        if (html === undefined)
          return refused('not-found', `${meta.id} v${version}'s page is gone from ${s.local.dir}`);

        return opened(
          s,
          { id: meta.id, title: meta.title, version, card: null, address: sheetAddress(meta.id) },
          html,
        );
      }),
  }) satisfies Partial<Handlers<C>>;
