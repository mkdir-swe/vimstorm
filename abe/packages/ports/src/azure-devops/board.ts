/**
 * The Board on Azure DevOps Boards: its REST API with an `az` token, renewed once on a 401.
 * Azure DevOps' answers are read with zod here; what they mean is core's (`adoErrorCode`,
 * `parseTags`, `tagsWrite`, `cardDescription`, `teamAreas`, `isMarkdownFormat`, `cardsQuery`).
 * `ABE_ADO_BASE_URL` sends every request to a fake Azure DevOps in place of https://dev.azure.com.
 * A card's images (#238) are read only from the board's own organization (`boardAttachment`) into
 * the `images` folder, each kept once read.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Area,
  boardAttachment,
  type Board,
  type Boarded,
  type BoardError,
  type BoardRef,
  cardDescription,
  type CardComment,
  type CardData,
  cardsQuery,
  changedQuery,
  doneCardsOf,
  isMarkdownFormat,
  parseTags,
  type Person,
  tagsField,
  tagsWrite,
  teamAreas,
} from '@abe/core';
import { z } from 'zod';
import { adoRest, type AdoOptions } from './ado-rest';
import { azTokens } from './az';
import { type Env } from '../mac/locations';
import { routedBoard } from '../mac/local-board';
import { decodeMarkdown, encodeMarkdown, htmlToMarkdown } from './markdown';

const API = '7.1';
const COMMENTS_API = '7.1-preview.4';
/** `connectionData` is a preview resource only: Azure DevOps refuses it a release api-version. */
const CONNECTION_API = '7.1-preview';
/** Work item reads take at most this many ids at a time; a list reads at most this many cards. */
const BATCH = 200;

/**
 * A shared board's cards that are this repo's (`board.area`, `board.tag`), less those it leaves
 * out (`board.excludeLanes`, `board.notTag`), as the query takes them: every list and look.
 */
const repoCards = (b: BoardRef) => ({
  ...(b.area === undefined ? {} : { area: b.area }),
  ...(b.tag === undefined ? {} : { tag: b.tag }),
  ...(b.excludeLanes === undefined ? {} : { excludeLanes: b.excludeLanes }),
  ...(b.notTag === undefined ? {} : { notTag: b.notTag }),
});

export { type AdoOptions } from './ado-rest';

/** An image's most bytes: a bigger attachment is not read. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const starts = (b: Uint8Array, magic: readonly number[]): boolean =>
  b.length >= magic.length && magic.every((x, i) => b[i] === x);

/**
 * The image kinds kept, told by their first bytes (Azure DevOps answers an attachment as
 * `application/octet-stream`), as their files' extension. No SVG: it can name other files.
 */
const IMAGE_KINDS: readonly { extension: string; is: (b: Uint8Array) => boolean }[] = [
  { extension: 'png', is: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { extension: 'jpg', is: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { extension: 'gif', is: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    extension: 'webp',
    is: (b) =>
      starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
  { extension: 'bmp', is: (b) => starts(b, [0x42, 0x4d]) },
];
const IMAGE_EXTENSIONS = IMAGE_KINDS.map((k) => k.extension);

const Identity = z.object({ displayName: z.string(), uniqueName: z.string().optional() });

const LONG = {
  description: 'System.Description',
  reproSteps: 'Microsoft.VSTS.TCM.ReproSteps',
  acceptanceCriteria: 'Microsoft.VSTS.Common.AcceptanceCriteria',
} as const;

const WorkItem = z.object({
  id: z.number(),
  rev: z.number(),
  fields: z.object({
    'System.Title': z.string(),
    'System.State': z.string(),
    'System.WorkItemType': z.string(),
    'System.AssignedTo': Identity.optional(),
    'System.CreatedBy': Identity.optional(),
    'System.Tags': z.string().optional(),
    /** The swimlane on the board of the team owning its area path; empty: the default lane. */
    'System.BoardLane': z.string().optional(),
    [LONG.description]: z.string().optional(),
    [LONG.reproSteps]: z.string().optional(),
    [LONG.acceptanceCriteria]: z.string().optional(),
    'Microsoft.VSTS.Scheduling.StoryPoints': z.number().optional(),
    'System.ChangedDate': z.string().optional(),
  }),
  /** How each long field is kept, by reference name: `html` or `markdown`. */
  multilineFieldsFormat: z.record(z.string(), z.string()).optional(),
});
type WorkItem = z.infer<typeof WorkItem>;

const Batch = z.object({ value: z.array(WorkItem.nullable()) });
const WiqlResult = z.object({
  /** When Azure DevOps ran the query, on its own clock. */
  asOf: z.string().optional(),
  workItems: z.array(z.object({ id: z.number() })),
});
const TeamAreas = z.object({
  field: z.object({ referenceName: z.string() }),
  /** Where the team's new cards go. */
  defaultValue: z.string().optional(),
  values: z.array(z.object({ value: z.string(), includeChildren: z.boolean() })),
});
/** `teamsettings/iterations?$timeframe=current`: the team's iteration spanning today, if any. */
const Iterations = z.object({ value: z.array(z.object({ name: z.string(), path: z.string() })) });
const Comment = z.object({
  id: z.number(),
  text: z.string(),
  format: z.string().optional(),
  createdBy: Identity,
  createdDate: z.string(),
});
const Comments = z.object({ comments: z.array(Comment) });
/** `_apis/wit/attachments`: where the file is kept. */
const Attachment = z.object({ url: z.string().min(1) });
/** `_apis/connectionData`: who the token is; `Account` holds the login (an email). */
const ConnectionData = z.object({
  authenticatedUser: z.object({
    providerDisplayName: z.string(),
    properties: z.object({ Account: z.object({ $value: z.string().min(1) }) }),
  }),
});

/** `_apis/projects/<project>/teams/<team>/members` (B2): the team's people (groups too). */
const TeamMembers = z.object({
  value: z.array(
    z.object({
      identity: z.object({
        displayName: z.string(),
        uniqueName: z.string(),
        isContainer: z.boolean().optional(),
        inactive: z.boolean().optional(),
      }),
    }),
  ),
});
/** A team's members read at once: more than a board's team has. */
const MEMBERS_TOP = 500;

type PatchOp =
  { op: 'add' | 'test'; path: string; value: unknown } | { op: 'remove'; path: string };

/** A long field as markdown: as it is kept, or converted from its html. */
const longField = (raw: WorkItem, ref: (typeof LONG)[keyof typeof LONG]): string => {
  const value = raw.fields[ref];

  if (value === undefined) return '';

  return isMarkdownFormat(raw.multilineFieldsFormat?.[ref])
    ? decodeMarkdown(value)
    : htmlToMarkdown(value);
};

const segment = encodeURIComponent;

/** `workitemtypes/<type>/states`: the states a card of that type can be moved to. */
const TypeStates = z.object({ value: z.array(z.object({ name: z.string() })) });

/** Azure DevOps' words for a work item that is not there, or not to be read with this login. */
const NO_ITEM = 'TF401232';

/** Its words for a state the card's type has not (`TF401320: Rule Error for field State`). */
const BAD_STATE = /TF401320[^.]*\bState\b/;

const fail = (code: BoardError['code'], message: string) =>
  ({ ok: false, error: { code, message } }) as const;

/** `images`: the folder a card's images are kept in once read (none: they are not read). */
export const adoBoard = (o: AdoOptions & { images?: string | undefined }): Board => {
  const { send, bytes } = adoRest(o, API);

  const projectUrl = (b: BoardRef) => `${b.organization}/${segment(b.project)}`;
  const witUrl = (b: BoardRef) => `${projectUrl(b)}/_apis/wit`;

  const person = (i: z.infer<typeof Identity> | undefined) =>
    i === undefined ? null : { name: i.displayName, email: i.uniqueName ?? '' };

  const toCard = (b: BoardRef, raw: WorkItem): CardData => {
    const f = raw.fields;
    const assigned = f['System.AssignedTo'];
    const lane = f['System.BoardLane']?.trim() ?? '';

    return {
      id: raw.id,
      title: f['System.Title'],
      state: f['System.State'],
      type: f['System.WorkItemType'],
      tags: parseTags(f['System.Tags']),
      assignee: person(assigned),
      description: cardDescription(
        longField(raw, LONG.description),
        longField(raw, LONG.reproSteps),
      ),
      acceptanceCriteria: longField(raw, LONG.acceptanceCriteria),
      url: `${projectUrl(b)}/_workitems/edit/${raw.id}`,
      points: f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? null,
      createdBy: person(f['System.CreatedBy']),
      ...(lane === '' ? {} : { lane }),
    };
  };

  const toComment = (c: z.infer<typeof Comment>): CardComment => ({
    id: c.id,
    text: isMarkdownFormat(c.format) ? decodeMarkdown(c.text) : htmlToMarkdown(c.text),
    by: c.createdBy.displayName,
    at: c.createdDate,
  });

  /** A card that is not there said as such (#187), never Azure DevOps' raw answer. */
  const there = <T>(b: BoardRef, id: number, got: Boarded<T>): Boarded<T> =>
    !got.ok && got.error.code === 'not-found' && got.error.message.includes(NO_ITEM)
      ? fail('not-found', `AB#${id} does not exist in ${b.project}, or you cannot see it`)
      : got;

  const item = async (b: BoardRef, id: number) =>
    there(b, id, await send(WorkItem, { method: 'GET', url: `${witUrl(b)}/workitems/${id}` }));

  const patch = async (b: BoardRef, id: number, ops: PatchOp[]): Promise<Boarded<CardData>> => {
    const written = there(
      b,
      id,
      await send(WorkItem, {
        method: 'PATCH',
        url: `${witUrl(b)}/workitems/${id}`,
        body: ops,
        contentType: 'application/json-patch+json',
      }),
    );

    return written.ok ? { ok: true, data: toCard(b, written.data) } : written;
  };

  /**
   * A move Azure DevOps refused for its state, said with the states the card's type has (#187);
   * its own answer when those cannot be read.
   */
  const badState = async (
    b: BoardRef,
    id: number,
    state: string,
    refused: Boarded<CardData>,
  ): Promise<Boarded<CardData>> => {
    if (refused.ok || refused.error.code !== 'rejected' || !BAD_STATE.test(refused.error.message))
      return refused;
    const raw = await item(b, id);

    if (!raw.ok) return refused;
    const type = raw.data.fields['System.WorkItemType'];
    const states = await send(TypeStates, {
      method: 'GET',
      url: `${witUrl(b)}/workitemtypes/${segment(type)}/states`,
    });

    return states.ok
      ? fail(
          'rejected',
          `'${state}' is not a state of AB#${id} (a ${type}): ${states.data.value.map((v) => v.name).join(', ')}`,
        )
      : refused;
  };

  /** The team's areas, when its board is cut by area (the usual team field). */
  const areas = async (b: BoardRef): Promise<Boarded<Area[]>> => {
    const read = await send(TeamAreas, {
      method: 'GET',
      url: `${projectUrl(b)}/${segment(b.team)}/_apis/work/teamsettings/teamfieldvalues`,
    });

    if (!read.ok) return read;

    return { ok: true, data: teamAreas(read.data.field.referenceName, read.data.values) };
  };

  /** One long field written as markdown (`<` and `>` as entities); none when not given. */
  const longOps = (field: keyof typeof LONG, text: string | undefined): PatchOp[] =>
    text === undefined
      ? []
      : [
          { op: 'add', path: `/fields/${LONG[field]}`, value: encodeMarkdown(text) },
          { op: 'add', path: `/multilineFieldsFormat/${LONG[field]}`, value: 'markdown' },
        ];
  /** The ops writing the long fields as markdown. */
  const textOps = (text: { description: string; acceptanceCriteria: string }): PatchOp[] => [
    ...longOps('description', text.description),
    ...longOps('acceptanceCriteria', text.acceptanceCriteria),
  ];

  /** Your login as Azure DevOps knows the token by (assign, a new card of yours). */
  const myLogin = async (b: BoardRef): Promise<Boarded<string>> => {
    const me = await send(ConnectionData, {
      method: 'GET',
      url: `${b.organization}/_apis/connectionData`,
      query: { 'api-version': CONNECTION_API },
    });

    return me.ok ? { ok: true, data: me.data.authenticatedUser.properties.Account.$value } : me;
  };

  const sprintOf = async (b: BoardRef): Promise<Boarded<{ name: string; path: string } | null>> => {
    const read = await send(Iterations, {
      method: 'GET',
      url: `${projectUrl(b)}/${segment(b.team)}/_apis/work/teamsettings/iterations`,
      query: { $timeframe: 'current' },
    });

    if (!read.ok) return read;
    const [current] = read.data.value;

    return {
      ok: true,
      data: current === undefined ? null : { name: current.name, path: current.path },
    };
  };

  /** Who the token is: `connectionData`'s name and login. */
  const whoAmI = async (b: BoardRef): Promise<Boarded<Person>> => {
    const me = await send(ConnectionData, {
      method: 'GET',
      url: `${b.organization}/_apis/connectionData`,
      query: { 'api-version': CONNECTION_API },
    });

    return me.ok
      ? {
          ok: true,
          data: {
            name: me.data.authenticatedUser.providerDisplayName,
            email: me.data.authenticatedUser.properties.Account.$value,
          },
        }
      : me;
  };

  /** The cards with these ids (at most `BATCH`), by id; one gone or not to be read is left out. */
  const itemsOf = async (
    b: BoardRef,
    ids: readonly number[],
  ): Promise<Boarded<Map<number, WorkItem>>> => {
    if (ids.length === 0) return { ok: true, data: new Map() };
    const batch = await send(Batch, {
      method: 'POST',
      url: `${witUrl(b)}/workitemsbatch`,
      body: { ids, errorPolicy: 'Omit' },
    });

    if (!batch.ok) return batch;

    return {
      ok: true,
      data: new Map(batch.data.value.flatMap((w) => (w === null ? [] : [[w.id, w] as const]))),
    };
  };

  /** The ids a WIQL query finds, at most `top`, and when it ran (Azure DevOps' clock). */
  const wiqlOf = async (
    b: BoardRef,
    query: string,
    top = BATCH,
  ): Promise<Boarded<{ ids: number[]; asOf: string | undefined }>> => {
    const found = await send(WiqlResult, {
      method: 'POST',
      url: `${witUrl(b)}/wiql`,
      // to the second and below (#236): without it Azure DevOps compares dates by the day
      query: { $top: String(top), timePrecision: 'true' },
      body: { query },
    });

    return found.ok
      ? {
          ok: true,
          data: {
            ids: found.data.workItems.map((w) => w.id).slice(0, top),
            asOf: found.data.asOf,
          },
        }
      : found;
  };
  const idsOf = async (b: BoardRef, query: string): Promise<Boarded<number[]>> => {
    const found = await wiqlOf(b, query);

    return found.ok ? { ok: true, data: found.data.ids } : found;
  };

  /** The earlier of two of Azure DevOps' times (its digits after the second vary: by time, not text). */
  const earlier = (a: string, b: string | undefined) =>
    b !== undefined && Date.parse(b) < Date.parse(a) ? b : a;

  return {
    changes: async (b, since) => {
      const changed = await wiqlOf(
        b,
        changedQuery({ types: b.types, ...(since === null ? {} : { since }) }),
        since === null ? 1 : BATCH,
      );

      if (!changed.ok) return changed;
      const { ids, asOf } = changed.data;

      // the next look starts where this query ran: a card changed while its cards are read is
      // found then (Azure DevOps' clock, never the Mac's)
      if (since === null || ids.length === 0)
        return { ok: true, data: { at: asOf ?? since, cards: [], gone: [] } };
      const [items, team, sprint] = await Promise.all([itemsOf(b, ids), areas(b), sprintOf(b)]);

      if (!items.ok) return items;
      if (!team.ok) return team;
      // more changed than one look reads (oldest first): the next starts just before the last
      // read, so the unread ones changed at that same moment are read then (read twice: the
      // Board puts a card in its place again)
      const last = ids.at(-1);
      const lastAt =
        last === undefined ? undefined : items.data.get(last)?.fields['System.ChangedDate'];
      const at =
        ids.length < BATCH || lastAt === undefined
          ? (asOf ?? lastAt ?? since)
          : earlier(new Date(Date.parse(lastAt) - 1).toISOString(), asOf);
      // as `card list --closed`: a sprint not read lists the done cards of the last days
      const done = doneCardsOf(sprint.ok ? sprint.data : null);
      const scoped = (mine: boolean) =>
        idsOf(
          b,
          cardsQuery({ types: b.types, areas: team.data, mine, done, ids, ...repoCards(b) }),
        );
      const [onTeam, onMine] = await Promise.all([scoped(false), scoped(true)]);

      if (!onTeam.ok) return onTeam;
      if (!onMine.ok) return onMine;
      const listed = new Set(onTeam.data);
      const mine = new Set(onMine.data);

      return {
        ok: true,
        data: {
          at,
          // newest change first, as the board lists them
          cards: ids.toReversed().flatMap((id) => {
            const raw = items.data.get(id);

            return raw === undefined || !listed.has(id)
              ? []
              : [{ card: toCard(b, raw), mine: mine.has(id) }];
          }),
          gone: ids.filter((id) => !listed.has(id)),
        },
      };
    },
    list: async (b, { mine, iteration, done }) => {
      const team = await areas(b);

      if (!team.ok) return team;
      const found = await send(WiqlResult, {
        method: 'POST',
        url: `${witUrl(b)}/wiql`,
        query: { $top: String(BATCH) },
        body: {
          query: cardsQuery({
            types: b.types,
            areas: team.data,
            mine,
            ...repoCards(b),
            ...(iteration === undefined ? {} : { iteration }),
            ...(done === undefined ? {} : { done }),
          }),
        },
      });

      if (!found.ok) return found;
      const ids = found.data.workItems.map((w) => w.id).slice(0, BATCH);
      const byId = await itemsOf(b, ids);

      if (!byId.ok) return byId;

      return {
        ok: true,
        data: ids.flatMap((id) => {
          const raw = byId.data.get(id);

          return raw === undefined ? [] : [toCard(b, raw)];
        }),
      };
    },
    currentSprint: sprintOf,
    show: async (b, id) => {
      const [raw, comments] = await Promise.all([
        item(b, id),
        send(Comments, {
          method: 'GET',
          url: `${witUrl(b)}/workItems/${id}/comments`,
          query: { 'api-version': COMMENTS_API, order: 'asc', $top: String(BATCH) },
        }),
      ]);

      if (!raw.ok) return raw;
      if (!comments.ok) return there(b, id, comments);

      return {
        ok: true,
        data: { ...toCard(b, raw.data), comments: comments.data.comments.map(toComment) },
      };
    },
    image: async (b, src) => {
      const url = boardAttachment(b.organization, src);

      if (url === undefined)
        return fail(
          'rejected',
          `not an attachment of ${b.organization}: Abe reads only the board's own images`,
        );
      const dir = o.images;

      if (dir === undefined) return fail('ado-failed', 'no folder to keep images in');
      // An attachment's address names one file for good: one read is kept.
      const key = createHash('sha256').update(url.toLowerCase()).digest('hex').slice(0, 32);
      const kept = IMAGE_EXTENSIONS.map((x) => join(dir, `${key}.${x}`)).find((f) => existsSync(f));

      if (kept !== undefined) return { ok: true, data: kept };
      const got = await bytes(url, IMAGE_MAX_BYTES);

      if (!got.ok) return got;
      const kind = IMAGE_KINDS.find((k) => k.is(got.data));

      if (kind === undefined)
        return fail(
          'rejected',
          `${url.split('?')[0] ?? url} is not an image Abe draws (png, jpg, gif, webp, bmp)`,
        );
      const file = join(dir, `${key}.${kind.extension}`);
      const part = `${file}.${process.pid}.part`;

      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(part, got.data, { mode: 0o600 });
        renameSync(part, file);
      } catch (err) {
        rmSync(part, { force: true });

        return fail('ado-failed', `the image could not be kept in ${dir}: ${String(err)}`);
      }

      return { ok: true, data: file };
    },
    comment: async (b, id, markdown) => {
      const posted = there(
        b,
        id,
        await send(Comment, {
          method: 'POST',
          url: `${witUrl(b)}/workItems/${id}/comments`,
          query: { 'api-version': COMMENTS_API, format: 'markdown' },
          body: { text: encodeMarkdown(markdown) },
        }),
      );

      return posted.ok ? { ok: true, data: { card: id, ...toComment(posted.data) } } : posted;
    },
    tag: async (b, id, change) => {
      const raw = await item(b, id);

      if (!raw.ok) return raw;
      const write = tagsWrite(raw.data.fields['System.Tags'], change);

      if (write.write === 'none') return { ok: true, data: toCard(b, raw.data) };

      return patch(b, id, [
        // Written only over the revision read, so a tag added meanwhile is not lost.
        { op: 'test', path: '/rev', value: raw.data.rev },
        write.write === 'clear'
          ? { op: 'remove', path: '/fields/System.Tags' }
          : { op: 'add', path: '/fields/System.Tags', value: write.field },
      ]);
    },
    move: async (b, id, state) =>
      badState(
        b,
        id,
        state,
        await patch(b, id, [{ op: 'add', path: '/fields/System.State', value: state }]),
      ),
    assign: async (b, id, who) => {
      // an empty AssignedTo is no one (Azure DevOps' own way to clear it)
      const login: Boarded<string> =
        who.kind === 'me'
          ? await myLogin(b)
          : { ok: true, data: who.kind === 'none' ? '' : who.login };

      if (!login.ok) return login;

      return patch(b, id, [{ op: 'add', path: '/fields/System.AssignedTo', value: login.data }]);
    },
    members: async (b) => {
      const [read, me] = await Promise.all([
        send(TeamMembers, {
          method: 'GET',
          url: `${b.organization}/_apis/projects/${segment(b.project)}/teams/${segment(b.team)}/members`,
          query: { $top: String(MEMBERS_TOP) },
        }),
        myLogin(b),
      ]);

      if (!read.ok) return read;
      if (!me.ok) return me;
      const you = me.data.toLowerCase();

      return {
        ok: true,
        data: read.data.value
          // a group or a disabled login is no one to assign
          .filter((m) => m.identity.isContainer !== true && m.identity.inactive !== true)
          .map((m) => ({
            name: m.identity.displayName,
            email: m.identity.uniqueName,
            you: m.identity.uniqueName.toLowerCase() === you,
          })),
      };
    },
    me: whoAmI,
    attach: async (b, id, file) => {
      const kept = await send(Attachment, {
        method: 'POST',
        url: `${witUrl(b)}/attachments`,
        query: { fileName: file.name },
        body: file.bytes,
        contentType: 'application/octet-stream',
      });

      if (!kept.ok) return kept;
      const linked = await patch(b, id, [
        {
          op: 'add',
          path: '/relations/-',
          value: { rel: 'AttachedFile', url: kept.data.url, attributes: { comment: file.name } },
        },
      ]);

      return linked.ok ? { ok: true, data: { url: kept.data.url } } : linked;
    },
    create: async (b, card) => {
      const type = card.type ?? b.types[0];

      if (type === undefined) return fail('rejected', 'the board names no card type to create');
      if (!b.types.includes(type))
        return fail('rejected', `'${type}' is not a type of this board: ${b.types.join(', ')}`);
      const none = { ok: true as const, data: null };
      const [team, sprint, login] = await Promise.all([
        send(TeamAreas, {
          method: 'GET',
          url: `${projectUrl(b)}/${segment(b.team)}/_apis/work/teamsettings/teamfieldvalues`,
        }),
        card.sprint === 'none' ? none : sprintOf(b),
        card.assignee === 'me' ? myLogin(b) : none,
      ]);

      if (!team.ok) return team;
      if (!sprint.ok) return sprint;
      if (!login.ok) return login;
      const field = team.data.field.referenceName;
      const area = team.data.defaultValue ?? team.data.values[0]?.value;
      const created = await send(WorkItem, {
        method: 'POST',
        url: `${witUrl(b)}/workitems/$${segment(type)}`,
        body: [
          { op: 'add', path: '/fields/System.Title', value: card.title },
          ...textOps(card),
          ...(card.tags === undefined || card.tags.length === 0
            ? []
            : [{ op: 'add', path: '/fields/System.Tags', value: tagsField(card.tags) }]),
          ...(area === undefined ? [] : [{ op: 'add', path: `/fields/${field}`, value: area }]),
          ...(sprint.data === null
            ? []
            : [{ op: 'add', path: '/fields/System.IterationPath', value: sprint.data.path }]),
          ...(card.state === undefined
            ? []
            : [{ op: 'add', path: '/fields/System.State', value: card.state }]),
          ...(login.data === null
            ? []
            : [{ op: 'add', path: '/fields/System.AssignedTo', value: login.data }]),
          ...(card.parent === undefined
            ? []
            : [
                {
                  op: 'add',
                  path: '/relations/-',
                  value: {
                    rel: 'System.LinkTypes.Hierarchy-Reverse',
                    url: `${witUrl(b)}/workItems/${card.parent}`,
                  },
                },
              ]),
        ],
        contentType: 'application/json-patch+json',
      });

      if (created.ok) return { ok: true, data: toCard(b, created.data) };
      if (
        card.state === undefined ||
        created.error.code !== 'rejected' ||
        !BAD_STATE.test(created.error.message)
      )
        return created;
      // said with the states the type has (#187), as a move is
      const states = await send(TypeStates, {
        method: 'GET',
        url: `${witUrl(b)}/workitemtypes/${segment(type)}/states`,
      });

      return states.ok
        ? fail(
            'rejected',
            `'${card.state}' is not a state of a ${type}: ${states.data.value.map((v) => v.name).join(', ')}`,
          )
        : created;
    },
    write: (b, id, text) =>
      patch(b, id, [
        ...(text.title === undefined
          ? []
          : [{ op: 'add' as const, path: '/fields/System.Title', value: text.title }]),
        ...longOps('description', text.description),
        ...longOps('acceptanceCriteria', text.acceptanceCriteria),
      ]),
  };
};

/**
 * The Board as the person: `az`'s login, or the fake at `ABE_ADO_BASE_URL` when set; a card's
 * images kept in `images`.
 */
export const adoBoardFrom = (env: Env, images?: string, o: { pinned?: boolean } = {}): Board => {
  const base = env.ABE_ADO_BASE_URL;
  const made = new Map<string, Board>();
  const home = env.HOME ?? '/';
  const homed = (dir: string) => {
    if (dir === '~') return home;

    return dir.startsWith('~/') ? `${home}${dir.slice(1)}` : dir;
  };
  /** The board as the az login in `dir`; `''`: az's login in `env` (`$AZURE_CONFIG_DIR` there). */
  const boardIn = (dir: string): Board => {
    const was = made.get(dir);

    if (was !== undefined) return was;
    const tokens = azTokens(dir === '' ? env : { ...env, AZURE_CONFIG_DIR: dir });
    const board = adoBoard({ tokens, base: base === '' ? undefined : base, images });

    made.set(dir, board);

    return board;
  };

  // Your az folder in force where the board was read (ADR 0025), unless serve's own environment
  // set $AZURE_CONFIG_DIR, which overrides the Layers (`pinned`).
  return routedBoard((b) =>
    boardIn(o.pinned === true || b.azureConfigDir === undefined ? '' : homed(b.azureConfigDir)),
  );
};
