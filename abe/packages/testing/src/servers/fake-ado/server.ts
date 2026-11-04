#!/usr/bin/env bun
/**
 * A fake Azure DevOps for the Board's tests and for trying cards without a real org. It answers
 * the requests the Board port sends from demo data seeded from a JSON file. Those are who the
 * token is, a team's areas and members, WIQL, work items one by one and in batches, comments,
 * JSON Patch writes, uploaded attachments and the seed's attachments as bytes. Writes change the
 * state, so the next read sees them. A restart starts over. It accepts any organization. The
 * project and team are the seed's.
 *
 *   bun server.ts [--port 0] [--seed seed.json] [--log requests.log] [--expired <token>]… [--now <ms>]
 *
 * Its clock is the machine's. A test passes `--now` (ms since the epoch) to start the clock there.
 * It then moves on one millisecond each time it is read, so no date depends on when the test runs.
 *
 * The first line on stdout says where it listens. After that it logs one line per request, never
 * a token, to stdout or to `--log`, before it answers. Every request needs a bearer token. A token
 * named by `--expired` gets 401, as Azure DevOps answers a token that ran out. It exits when its
 * stdin closes, so a test's fake ends with the test.
 *
 * `X-Fake-As: <member>` on a write makes that member the writer. It sets `System.ChangedBy`, a new
 * card's `System.CreatedBy` and a comment's author. The member is a seed member's email, display
 * name or email's local part, such as `sam`. Only tests send it, for a teammate's change in
 * `qarig teammate`. An unknown name gets 400.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  compare,
  type FieldValue,
  type Fields,
  type Identity,
  parseWiql,
  plain,
  WiqlError,
} from './wiql';

const Member = z.object({ id: z.string(), displayName: z.string(), uniqueName: z.string() });
const Seed = z.object({
  project: z.string(),
  team: z.object({ id: z.string(), name: z.string() }),
  me: z.string(),
  members: z.array(Member).min(1),
  areas: z.array(z.string()).min(1),
  /** Iterations by name. An item's `sprint` is its index here. `current` spans today. */
  sprints: z.array(z.object({ name: z.string(), current: z.boolean().optional() })),
  /**
   * Files at `<org>/<project>/_apis/wit/attachments/<id>`, such as pictures in the cards' text.
   * Bytes in base64, served with `contentType`. Azure DevOps sends `application/octet-stream`.
   */
  attachments: z
    .array(z.object({ id: z.string(), contentType: z.string(), base64: z.string() }))
    .optional(),
  items: z.array(
    z.looseObject({
      id: z.number().int().positive(),
      type: z.string(),
      title: z.string(),
      state: z.string(),
      area: z.string().optional(),
      sprint: z.number().int().optional(),
      parent: z.number().int().optional(),
      assignedTo: z.string().optional(),
      /** Its swimlane on the board (`System.BoardLane`); none: the default lane. */
      lane: z.string().optional(),
      tags: z.string().optional(),
      priority: z.number().optional(),
      points: z.number().optional(),
      description: z.string().optional(),
      reproSteps: z.string().optional(),
      acceptanceCriteria: z.string().optional(),
      /** Long fields kept as markdown, by reference name (`System.Description`). */
      markdown: z.array(z.string()).optional(),
      comments: z
        .array(z.object({ by: z.string(), text: z.string(), daysAgo: z.number() }))
        .optional(),
    }),
  ),
});
type Seed = z.infer<typeof Seed>;

const STATES: Record<string, readonly string[]> = {
  Epic: ['New', 'Active', 'Resolved', 'Closed', 'Removed'],
  Feature: ['New', 'Active', 'Resolved', 'Closed', 'Removed'],
  'User Story': ['New', 'Active', 'Resolved', 'Closed', 'Removed'],
  Bug: ['New', 'Active', 'Resolved', 'Closed', 'Removed'],
  Task: ['New', 'Active', 'Closed', 'Removed'],
};

const DAY = 86_400_000;

/** The machine's clock, or one that starts at `start` and moves a millisecond each reading. */
const clockFrom = (start: number | undefined): (() => number) => {
  if (start === undefined) return () => Date.now();
  let at = start;

  return () => {
    at += 1;

    return at - 1;
  };
};

type Comment = {
  workItemId: number;
  id: number;
  version: number;
  text: string;
  format: 'html' | 'markdown';
  createdBy: Identity;
  createdDate: string;
  modifiedBy: Identity;
  modifiedDate: string;
};
type Item = {
  id: number;
  rev: number;
  fields: Fields;
  formats: Record<string, string>;
  comments: Comment[];
  /** Its links. Each is an attached file (`AttachedFile`) and what it is. */
  relations?: { rel: string; url: string; attributes?: unknown }[];
};

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The seed's items, comments and people, as writes change them. */
const world = (seed: Seed, now: () => number) => {
  const project = seed.project;
  const sprints = seed.sprints.map((s) => ({ path: `${project}\\${s.name}` }));
  const identity = (m: z.infer<typeof Member>): Identity => ({
    displayName: m.displayName,
    uniqueName: m.uniqueName,
    id: m.id,
    imageUrl: '',
  });
  const [first] = seed.members;

  if (first === undefined) throw new Error('a seed needs a member');
  const me = identity(seed.members.find((m) => m.uniqueName === seed.me) ?? first);
  /** An email, a name or `Name <email>`. Unknown ones stay as they are. Nobody is `undefined`. */
  const identityOf = (text: string): Identity | undefined => {
    const t = text.trim();

    if (t === '') return undefined;
    const email = (/<([^>]+)>/.exec(t)?.[1] ?? t).toLowerCase();
    const m = seed.members.find(
      (x) =>
        x.uniqueName.toLowerCase() === email || x.displayName.toLowerCase() === t.toLowerCase(),
    );

    return m === undefined ? { displayName: t, uniqueName: t, id: '', imageUrl: '' } : identity(m);
  };
  /** The member `X-Fake-As` names by email, display name or email's local part, or undefined. */
  const memberOf = (text: string): Identity | undefined => {
    const t = text.trim().toLowerCase();
    const m = seed.members.find(
      (x) =>
        x.uniqueName.toLowerCase() === t ||
        x.displayName.toLowerCase() === t ||
        x.uniqueName.toLowerCase().split('@')[0] === t,
    );

    return m === undefined ? undefined : identity(m);
  };
  const items = new Map<number, Item>();
  let nextComment = 1;
  const addComment = (
    item: Item,
    text: string,
    format: Comment['format'],
    by: Identity,
    at: number,
  ) => {
    const date = new Date(at).toISOString();
    const comment: Comment = {
      workItemId: item.id,
      id: nextComment,
      version: 1,
      text,
      format,
      createdBy: by,
      createdDate: date,
      modifiedBy: by,
      modifiedDate: date,
    };

    nextComment += 1;
    item.comments.push(comment);
    item.fields['System.CommentCount'] = item.comments.length;

    return comment;
  };

  // One moment for every seeded item, so ChangedDate ties and the board's order is the seed's.
  const start = now();
  const created = new Date(start - 14 * DAY).toISOString();

  for (const s of seed.items) {
    const sprint = s.sprint === undefined ? undefined : sprints[s.sprint];
    const fields: Fields = {
      'System.Id': s.id,
      'System.AreaPath': s.area ?? project,
      'System.TeamProject': project,
      'System.IterationPath': sprint?.path ?? project,
      'System.WorkItemType': s.type,
      'System.State': s.state,
      'System.Reason': s.state,
      'System.CreatedDate': created,
      'System.CreatedBy': me,
      'System.ChangedDate': created,
      'System.ChangedBy': me,
      'System.Title': s.title,
      'Microsoft.VSTS.Common.StackRank': s.id * 1000,
    };
    const optional: Record<string, FieldValue | undefined> = {
      'System.AssignedTo': s.assignedTo === undefined ? undefined : identityOf(s.assignedTo),
      'System.Parent': s.parent,
      'System.Tags': s.tags,
      'System.BoardLane': s.lane,
      'System.Description': s.description,
      'Microsoft.VSTS.TCM.ReproSteps': s.reproSteps,
      'Microsoft.VSTS.Common.AcceptanceCriteria': s.acceptanceCriteria,
      'Microsoft.VSTS.Common.Priority': s.priority,
      'Microsoft.VSTS.Scheduling.StoryPoints': s.points,
    };

    for (const [k, v] of Object.entries(optional)) if (v !== undefined) fields[k] = v;
    const item: Item = {
      id: s.id,
      rev: 1,
      fields,
      formats: Object.fromEntries((s.markdown ?? []).map((ref) => [ref, 'markdown'])),
      comments: [],
    };

    for (const c of s.comments ?? [])
      addComment(item, c.text, 'html', identityOf(c.by) ?? me, start - c.daysAgo * DAY);
    items.set(s.id, item);
  }

  const nowIso = () => new Date(now()).toISOString();
  /** Files uploaded with `POST _apis/wit/attachments`, by id. */
  const attachments = new Map<string, { name: string; bytes: Uint8Array }>();

  return { seed, project, me, items, identityOf, memberOf, addComment, now, nowIso, attachments };
};
type World = ReturnType<typeof world>;

const PatchOp = z.object({
  op: z.enum(['add', 'replace', 'remove', 'test', 'copy', 'move']),
  path: z.string(),
  value: z.unknown().optional(),
});
const Relation = z.object({ rel: z.string(), url: z.string(), attributes: z.unknown().optional() });
const Patch = z.array(PatchOp, { error: 'A JSON Patch document is an array of operations.' });
const Scalar = z.union([z.string(), z.number()]);

const setField = (w: World, item: Item, name: string, value: unknown) => {
  if (name === 'System.AssignedTo') {
    const who = w.identityOf(typeof value === 'string' ? value : '');

    if (who === undefined) Reflect.deleteProperty(item.fields, name);
    else item.fields[name] = who;

    return;
  }
  const v = Scalar.safeParse(value);

  if (!v.success) throw new Refused(400, `The fake keeps ${name} as text or a number.`);
  if (name === 'System.State') {
    const type = plain(item.fields['System.WorkItemType']);

    if (!(STATES[type] ?? []).includes(String(v.data)))
      throw new Refused(
        400,
        `TF401320: Rule Error for field State. Error code: Required, HasValues, LimitedToValues. '${String(v.data)}' is not a state of a ${type}.`,
      );
    item.fields['System.Reason'] = v.data;
  }
  item.fields[name] = v.data;
};

const applyOps = (w: World, item: Item, body: unknown) => {
  const ops = Patch.safeParse(body);

  if (!ops.success) throw new Refused(400, 'A JSON Patch document is an array of operations.');
  for (const op of ops.data)
    if (op.op === 'test' && op.path === '/rev' && Number(op.value) !== item.rev)
      throw new Refused(
        412,
        `TF26071: This work item has been changed by someone else since you opened it. (rev ${item.rev}, not ${String(op.value)})`,
      );
  for (const op of ops.data) {
    if (op.op === 'test') continue;
    if (op.path.startsWith('/fields/')) {
      const name = op.path.slice('/fields/'.length);

      if (op.op === 'remove') Reflect.deleteProperty(item.fields, name);
      else setField(w, item, name, op.value);
    } else if (op.path.startsWith('/multilineFieldsFormat/')) {
      item.formats[op.path.slice('/multilineFieldsFormat/'.length)] = String(op.value);
    } else if (op.path === '/relations/-' && op.op === 'add') {
      const r = Relation.safeParse(op.value);

      if (!r.success) throw new Refused(400, 'A relation has a rel and a url.');
      item.relations = [...(item.relations ?? []), r.data];
    }
  }
};

const touched = (w: World, item: Item, by: Identity) => {
  item.rev += 1;
  item.fields['System.Rev'] = item.rev;
  item.fields['System.ChangedDate'] = w.nowIso();
  item.fields['System.ChangedBy'] = by;
};

const orgUrl = (org: string) => `https://dev.azure.com/${encodeURIComponent(org)}`;

const itemJson = (item: Item, org: string, fields?: readonly string[]) => {
  const f: Fields = {};

  for (const [name, value] of Object.entries(item.fields))
    if (fields === undefined || fields.includes(name)) f[name] = value;

  return {
    id: item.id,
    rev: item.rev,
    fields: f,
    ...(Object.keys(item.formats).length === 0 ? {} : { multilineFieldsFormat: item.formats }),
    ...(item.relations === undefined ? {} : { relations: item.relations }),
    url: `${orgUrl(org)}/_apis/wit/workItems/${item.id}`,
  };
};

const runWiql = (w: World, text: string) => {
  const { where, order } = parseWiql(text, {
    project: w.project,
    me: w.me,
    today: w.nowIso().slice(0, 10),
  });

  return [...w.items.values()]
    .filter((it) => it.fields['System.State'] !== 'Removed' || text.includes('Removed'))
    .filter((it) => where(it.fields))
    .sort((a, b) => {
      for (const { name, desc } of order) {
        const c = compare(a.fields[name], b.fields[name]);

        if (c !== 0) return desc ? -c : c;
      }

      return a.id - b.id;
    });
};

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const list = <T>(value: T[]) => ({ count: value.length, value });

const Wiql = z.object({ query: z.string() });
const Batch = z.object({
  ids: z.array(z.coerce.number()),
  fields: z.array(z.string()).optional(),
  errorPolicy: z.string().optional(),
});
const NewComment = z.object({ text: z.string() });

type Answer = { status: number; json: unknown };

/** The answer to one request, or `undefined` for a route the fake does not have. */
const route = (w: World, method: string, url: URL, body: unknown, by: Identity): unknown => {
  const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [org, project, third, ...rest] = segs;

  // `<org>/_apis/connectionData` says who the token is, the seed's `me`.
  if (
    method === 'GET' &&
    same(project, '_apis') &&
    same(third, 'connectionData') &&
    rest.length === 0
  )
    return {
      authenticatedUser: {
        id: w.me.id,
        providerDisplayName: w.me.displayName,
        isActive: true,
        properties: { Account: { $type: 'System.String', $value: w.me.uniqueName } },
      },
      instanceId: 'fake-instance',
    };
  // `<org>/_apis/projects/<project>/teams/<team>/members` lists the seed's members as identities.
  if (method === 'GET' && same(project, '_apis') && same(third, 'projects')) {
    const [p, teams, team, members, ...more] = rest;

    if (!same(teams, 'teams') || !same(members, 'members') || more.length > 0) return undefined;
    if (!same(p, w.project))
      throw new Refused(404, `TF200016: The fake has project ${w.project} only, not ${p ?? ''}.`);
    if (!same(team, w.seed.team.id) && !same(team, w.seed.team.name))
      throw new Refused(404, `The fake has team ${w.seed.team.name} only, not ${team ?? ''}.`);

    return list(w.seed.members.map((m) => ({ identity: w.identityOf(m.uniqueName) })));
  }
  if (org === undefined || project === undefined) return undefined;
  if (!same(project, w.project))
    throw new Refused(404, `TF200016: The fake has project ${w.project} only, not ${project}.`);
  // `<org>/<project>/<team>/_apis/work/teamsettings/teamfieldvalues`
  if (third !== '_apis' && rest[0] === '_apis') {
    if (!same(third, w.seed.team.id) && !same(third, w.seed.team.name))
      throw new Refused(404, `The fake has team ${w.seed.team.name} only, not ${third ?? ''}.`);
    // `$timeframe=current` asks for the iteration the seed marks current, if any.
    if (method === 'GET' && rest.slice(1).join('/') === 'work/teamsettings/iterations') {
      const current = same(url.searchParams.get('$timeframe') ?? '', 'current');
      const sprints = w.seed.sprints.filter((s) => !current || s.current === true);

      return list(
        sprints.map((s) => ({
          id: `iteration-${s.name}`,
          name: s.name,
          path: `${w.project}\\${s.name}`,
          attributes: { timeFrame: s.current === true ? 'current' : 'future' },
        })),
      );
    }
    if (method === 'GET' && rest.slice(1).join('/') === 'work/teamsettings/teamfieldvalues') {
      const [top] = w.seed.areas;

      return {
        field: { referenceName: 'System.AreaPath' },
        defaultValue: top,
        values: [{ value: top, includeChildren: true }],
      };
    }

    return undefined;
  }
  if (third !== '_apis' || rest[0] !== 'wit') return undefined;
  const [, what, id, sub] = rest;

  // `POST attachments?fileName=` keeps a file and answers its url to link from a work item.
  if (same(what, 'attachments') && id === undefined && method === 'POST') {
    if (!(body instanceof Uint8Array) || body.length === 0)
      throw new Refused(400, 'VS403432: The attachment has no content.');
    const name = url.searchParams.get('fileName') ?? '';

    if (name === '') throw new Refused(400, 'VS403433: The attachment needs a fileName.');
    const key = `${String(w.attachments.size + 1).padStart(8, '0')}-0000-0000-0000-000000000000`;

    w.attachments.set(key, { name, bytes: body });

    return {
      id: key,
      url: `${orgUrl(org)}/${encodeURIComponent(w.project)}/_apis/wit/attachments/${key}?fileName=${encodeURIComponent(name)}`,
    };
  }

  // `workitemtypes/<type>/states` lists the type's states in order.
  if (same(what, 'workitemtypes') && id !== undefined && same(sub, 'states') && method === 'GET') {
    const states = STATES[id];

    if (states === undefined) throw new Refused(404, `TF401326: Invalid work item type ${id}.`);

    return list(states.map((name) => ({ name, color: '007acc', category: name })));
  }

  if (same(what, 'wiql') && method === 'POST') {
    const q = Wiql.safeParse(body);

    if (!q.success) throw new Refused(400, 'TF51005: The query is missing.');
    const top = Number(url.searchParams.get('$top') ?? 20_000);
    const found = runWiql(w, q.data.query).slice(0, top);

    return {
      queryType: 'flat',
      queryResultType: 'workItem',
      asOf: w.nowIso(),
      columns: [{ referenceName: 'System.Id', name: 'ID' }],
      workItems: found.map((it) => ({
        id: it.id,
        url: `${orgUrl(org)}/_apis/wit/workItems/${it.id}`,
      })),
    };
  }
  if (same(what, 'workitemsbatch') && method === 'POST') {
    const b = Batch.safeParse(body);

    if (!b.success) throw new Refused(400, 'VS403474: ids are needed.');
    if (b.data.ids.length > 200)
      throw new Refused(400, 'VS403474: Too many work items requested (more than 200).');

    return list(
      b.data.ids.map((n) => {
        const it = w.items.get(n);

        if (it === undefined) {
          if (b.data.errorPolicy === 'Omit') return null;
          throw new Refused(404, `TF401232: Work item ${n} does not exist.`);
        }

        return itemJson(it, org, b.data.fields);
      }),
    );
  }
  // `POST workitems/$<type>` makes a work item from a JSON Patch of its fields (Make card).
  if (same(what, 'workitems') && id?.startsWith('$') === true && method === 'POST') {
    const type = id.slice(1);

    if (STATES[type] === undefined)
      throw new Refused(400, `TF401326: Invalid work item type ${type}.`);
    const n = Math.max(0, ...w.items.keys()) + 1;
    const at = w.nowIso();
    const item: Item = {
      id: n,
      rev: 0,
      fields: {
        'System.Id': n,
        'System.AreaPath': w.project,
        'System.TeamProject': w.project,
        'System.IterationPath': w.project,
        'System.WorkItemType': type,
        'System.State': 'New',
        'System.Reason': 'New',
        'System.CreatedDate': at,
        'System.CreatedBy': by,
        'Microsoft.VSTS.Common.StackRank': n * 1000,
      },
      formats: {},
      comments: [],
    };

    applyOps(w, item, body);
    if (plain(item.fields['System.Title']) === '')
      throw new Refused(400, 'TF401320: Rule Error for field Title. Error code: Required.');
    touched(w, item, by);
    w.items.set(n, item);

    return itemJson(item, org);
  }
  if (!same(what, 'workitems') || id === undefined) return undefined;
  const item = w.items.get(Number(id));

  if (item === undefined)
    throw new Refused(
      404,
      `TF401232: Work item ${id} does not exist, or you do not have permissions to read it.`,
    );
  if (same(sub, 'comments')) {
    if (method === 'POST') {
      const c = NewComment.safeParse(body);

      if (!c.success) throw new Refused(400, 'The comment has no text.');
      const format = same(url.searchParams.get('format') ?? '', 'markdown') ? 'markdown' : 'html';
      const comment = w.addComment(item, c.data.text, format, by, w.now());

      touched(w, item, by);

      return comment;
    }
    if (method === 'GET') {
      const comments = [...item.comments].sort((a, b) =>
        a.createdDate.localeCompare(b.createdDate),
      );

      if (same(url.searchParams.get('order') ?? 'asc', 'desc')) comments.reverse();

      return { totalCount: comments.length, count: comments.length, comments };
    }

    return undefined;
  }
  if (sub !== undefined) return undefined;
  if (method === 'GET') return itemJson(item, org);
  if (method === 'PATCH') {
    const copy = structuredClone(item);

    applyOps(w, copy, body);
    touched(w, copy, by);
    w.items.set(item.id, copy);

    return itemJson(copy, org);
  }

  return undefined;
};

const ATTACHMENT = /^\/[^/]+(?:\/[^/]+)?\/_apis\/wit\/attachments\/([^/]+)$/i;

/** `GET …/_apis/wit/attachments/<id>` answers the seed's file as bytes, or undefined for no route. */
const attachment = (w: World, method: string, url: URL): Response | undefined => {
  const id = ATTACHMENT.exec(url.pathname)?.[1];

  if (method !== 'GET' || id === undefined) return undefined;
  const file = (w.seed.attachments ?? []).find((a) => same(a.id, decodeURIComponent(id)));

  if (file === undefined)
    return Response.json(
      { message: `VS800006: The attachment ${id} does not exist.` },
      { status: 404 },
    );

  return new Response(Buffer.from(file.base64, 'base64'), {
    headers: { 'Content-Type': file.contentType },
  });
};

const answer = (w: World, method: string, url: URL, body: unknown, as?: string): Answer => {
  try {
    const by = as === undefined ? w.me : w.memberOf(as);

    if (by === undefined)
      throw new Refused(400, `X-Fake-As: ${as ?? ''} is no member of the fake's team.`);
    const json = route(w, method, url, body, by);

    return json === undefined
      ? { status: 404, json: { message: `The fake has no ${method} ${url.pathname}.` } }
      : { status: 200, json };
  } catch (e) {
    if (e instanceof Refused) return { status: e.status, json: { message: e.message } };
    if (e instanceof WiqlError) return { status: 400, json: { message: e.message } };
    throw e;
  }
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);

  return at >= 0 ? args[at + 1] : undefined;
};
const expired = new Set(args.flatMap((a, i) => (args[i - 1] === '--expired' ? [a] : [])));
const log = flag('--log');
const seedPath = flag('--seed') ?? join(import.meta.dir, 'seed.json');
const startAt = flag('--now');
const w = world(
  Seed.parse(JSON.parse(readFileSync(seedPath, 'utf8'))),
  clockFrom(startAt === undefined ? undefined : Number(startAt)),
);

const readBody = async (req: Request): Promise<unknown> => {
  // An attachment goes out as the bytes that came in. Anything else is JSON.
  if (req.headers.get('content-type') === 'application/octet-stream')
    return new Uint8Array(await req.arrayBuffer());
  const text = await req.text();

  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Refused(400, 'The fake could not read the request: its body is not JSON.');
  }
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(flag('--port') ?? 0),
  fetch: async (req) => {
    const url = new URL(req.url);
    const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    const as = req.headers.get('x-fake-as') ?? undefined;
    let out: Answer;
    const file =
      bearer === undefined || expired.has(bearer) ? undefined : attachment(w, req.method, url);

    if (file !== undefined) {
      const line = `${req.method} ${decodeURIComponent(url.pathname)}${decodeURIComponent(url.search)} → ${file.status}`;

      if (log === undefined) console.log(line);
      else appendFileSync(log, `${line}\n`);

      return file;
    }
    if (bearer === undefined)
      out = { status: 401, json: { message: 'TF400813: No access token was sent.' } };
    else if (expired.has(bearer))
      out = { status: 401, json: { message: 'TF400813: The access token has expired.' } };
    else {
      try {
        out = answer(w, req.method, url, await readBody(req), as);
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        out = { status: e.status, json: { message: e.message } };
      }
    }
    const said = out.status >= 300 ? ` ${JSON.stringify(out.json)}` : '';

    const line = `${req.method} ${decodeURIComponent(url.pathname)}${decodeURIComponent(url.search)} → ${out.status}${said}${as === undefined ? '' : ` (as ${as})`}`;

    // Written before the answer goes, so a test reading `--log` after a call sees the call.
    if (log === undefined) console.log(line);
    else appendFileSync(log, `${line}\n`);

    return Response.json(out.json, { status: out.status });
  },
});

console.log(
  `fake Azure DevOps on http://127.0.0.1:${server.port} (project ${w.project}, team ${w.seed.team.name}, ${w.items.size} work items)`,
);

// Ends with its stdin, so a test's fake goes when the test does, however it ends.
process.stdin.on('end', () => {
  void server.stop(true).then(() => process.exit(0));
});
process.stdin.resume();
