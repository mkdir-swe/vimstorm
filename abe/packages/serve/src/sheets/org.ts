/**
 * What `serve` reads of the org store: a Sheet attached to a card, a card's attached Sheets, and
 * a card's prototype (#82): its record, or a version copied as a run's reference.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type Answered,
  cardSheetOf,
  type CardSheet,
  cardSheetsPrefix,
  newestAttachFirst,
  orgKeyProblem,
  OrgPrototype,
  OrgPrototypeVersion,
  OrgSheet,
  type OrgStore,
  prototypeIndexKey,
  prototypeReadme,
  REFERENCE_README,
  sheetInfoKey,
  sheetOfInfoKey,
  type Upload,
  versionPrefix,
  withUploaded,
} from '@abe/core';
import { type z } from 'zod';

const text = new TextDecoder();
const bytes = new TextEncoder();

/** The card's `sheet.json` for the Sheet, `undefined` when it is not attached there. */
export const readOrgSheet = async (
  org: OrgStore,
  card: number,
  id: string,
): Promise<Answered<OrgSheet | undefined>> => {
  const key = sheetInfoKey(card, id);
  const got = await org.get(key);

  if (!got.ok) return got.error.code === 'not-found' ? { ok: true, data: undefined } : got;
  try {
    const info = OrgSheet.safeParse(JSON.parse(text.decode(got.data)));

    if (info.success) return { ok: true, data: info.data };
  } catch {
    // Read as broken below.
  }

  return { ok: false, error: { code: 'store-failed', message: `${key} does not read` } };
};

/**
 * The card's attached Sheets, newest attach first. A store that cannot be read gives none: the
 * card itself still shows.
 */
export const cardSheets = async (org: OrgStore | undefined, card: number): Promise<CardSheet[]> => {
  if (org === undefined) return [];
  const listed = await org.list(cardSheetsPrefix(card));

  if (!listed.ok) return [];
  const ids = listed.data.flatMap((o) => {
    const id = sheetOfInfoKey(card, o.key);

    return id === undefined ? [] : [id];
  });
  const read = await Promise.all(ids.map((id) => readOrgSheet(org, card, id)));

  return newestAttachFirst(
    read.flatMap((r) => (r.ok && r.data !== undefined ? [cardSheetOf(card, r.data)] : [])),
  );
};

/** A JSON record of the store at `key` read with `schema`; `undefined` when there is none. */
const readRecord = async <T extends z.ZodType>(
  org: OrgStore,
  key: string,
  schema: T,
): Promise<Answered<z.output<T> | undefined>> => {
  const got = await org.get(key);

  if (!got.ok) return got.error.code === 'not-found' ? { ok: true, data: undefined } : got;
  try {
    const read = schema.safeParse(JSON.parse(text.decode(got.data)));

    if (read.success) return { ok: true, data: read.data };
  } catch {
    // Read as broken below.
  }

  return { ok: false, error: { code: 'store-failed', message: `${key} does not read` } };
};

/** The card's prototype record (`prototype.json`) for the repo; `undefined` when it has none. */
export const readOrgPrototype = (
  org: OrgStore,
  repo: string,
  card: number,
): Promise<Answered<OrgPrototype | undefined>> =>
  readRecord(org, prototypeIndexKey(repo, card), OrgPrototype);

/**
 * Every file of a version copied from the store into `dir` (`meta.json`, `changes/`, `mocks/`,
 * `screenshots/`, a developer's `prototype.diff`), then `PROTOTYPE.md` beside them (#351), as a
 * Factory run's reference: its `meta.json`, or why not. Where the run runs reads it (the Mac for
 * a local run, the box's serve for a cloud one).
 */
export const downloadVersion = async (
  org: OrgStore,
  repo: string,
  card: number,
  n: number,
  dir: string,
): Promise<Answered<OrgPrototypeVersion>> => {
  const base = versionPrefix(repo, card, n);
  const listed = await org.list(base);

  if (!listed.ok) return listed;
  let meta: OrgPrototypeVersion | undefined;

  for (const o of listed.data) {
    const rel = o.key.slice(base.length);

    // A key that is no plain path (an S3 key may hold `..`) never lands outside `dir`.
    if (orgKeyProblem(rel) !== undefined) continue;
    const got = await org.get(o.key);

    if (!got.ok) return got;
    try {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), got.data);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);

      return { ok: false, error: { code: 'store-failed', message: `cannot write ${dir}: ${why}` } };
    }
    if (rel === 'meta.json') {
      try {
        const read = OrgPrototypeVersion.safeParse(JSON.parse(text.decode(got.data)));

        if (read.success) meta = read.data;
      } catch {
        // Not a version without its meta: said below.
      }
    }
  }

  if (meta === undefined)
    return {
      ok: false,
      error: { code: 'store-failed', message: `${base}meta.json does not read` },
    };
  try {
    await writeFile(join(dir, REFERENCE_README), prototypeReadme(meta));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);

    return { ok: false, error: { code: 'store-failed', message: `cannot write ${dir}: ${why}` } };
  }

  return { ok: true, data: meta };
};

/**
 * What a Factory run on `card` is handed (#351, ADR 0023): its prototype's newest version in the
 * store, a question for every stage to read (no spec issue needed); `undefined` when it has none.
 */
export const cardReference = async (
  org: OrgStore,
  repo: string,
  card: number,
): Promise<Answered<{ meta: OrgPrototypeVersion } | undefined>> => {
  const index = await readOrgPrototype(org, repo, card);

  if (!index.ok) return index;
  const newest = index.data?.versions.at(-1);

  if (newest === undefined) return { ok: true, data: undefined };
  const meta = await readRecord(
    org,
    `${versionPrefix(repo, card, newest.n)}meta.json`,
    OrgPrototypeVersion,
  );

  if (!meta.ok) return meta;

  return { ok: true, data: meta.data === undefined ? undefined : { meta: meta.data } };
};

/**
 * A version's upload put whole (each object, `meta.json` last), then the card's `prototype.json`
 * with it: Make card's (#82) and To the Factory's (#83). `screenshot` reads one of the prototype's
 * PNGs by file; one that is gone puts no `meta.json`.
 */
export const putVersion = async (
  org: OrgStore,
  plan: { meta: OrgPrototypeVersion; uploads: readonly Upload[] },
  screenshot: (file: string) => Promise<Uint8Array | undefined>,
): Promise<Answered<null>> => {
  for (const u of plan.uploads) {
    let body: Uint8Array;

    if ('text' in u) body = bytes.encode(u.text);
    else {
      const png = await screenshot(u.screenshot);

      if (png === undefined)
        return {
          ok: false,
          error: {
            code: 'not-found',
            message: `${plan.meta.prototype}'s screenshot ${u.screenshot} is gone`,
          },
        };
      body = png;
    }
    const put = await org.put(u.key, body, u.contentType);

    if (!put.ok) return put;
  }
  const before = await readOrgPrototype(org, plan.meta.repo, plan.meta.card);

  if (!before.ok) return before;
  const index = await org.put(
    prototypeIndexKey(plan.meta.repo, plan.meta.card),
    bytes.encode(`${JSON.stringify(withUploaded(before.data, plan.meta), null, 2)}\n`),
    'application/json',
  );

  return index.ok ? { ok: true, data: null } : index;
};
