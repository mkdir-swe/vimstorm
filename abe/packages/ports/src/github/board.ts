/**
 * The Board on the repo's GitHub Issues (`board.provider: github`), through `gh api` on the gh
 * login the checkout names (`logins.gh`, else gh's active one): cards are its issues (never its
 * pull requests), a card's id its number. GitHub's answers are read with zod here; what they mean
 * is core's (`githubCardState`, `githubStateWrite`, `splitIssueBody`, `retag` …). What GitHub has
 * nothing like (sprints, image reads, attachments) is `unsupported`, never dropped.
 */
import {
  type AssignTo,
  type Board,
  type Boarded,
  type BoardError,
  type BoardErrorCode,
  type BoardRef,
  carriesTag,
  type CardData,
  type DoneCards,
  DONE_DAYS,
  GITHUB_BUG_LABEL,
  GITHUB_STATES,
  githubCardState,
  githubCardTags,
  githubCardType,
  githubStateOf,
  githubStateWrite,
  isStateLabel,
  issueBody,
  type Person,
  retag,
  splitIssueBody,
  type TrackingError,
} from '@abe/core';
import { z } from 'zod';
import { type Gh, ghRunner, ghTokens, readGh } from './gh';
import { type Env } from '../mac/locations';

const User = z.object({ login: z.string() });

const RestIssue = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullish(),
  html_url: z.string(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  assignees: z.array(User).nullish(),
  user: User.nullable(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  /** Set when the number is a pull request's: the issues endpoints answer for those too. */
  pull_request: z.unknown().optional(),
});
type RestIssue = z.infer<typeof RestIssue>;

const RestComment = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user: User.nullable(),
  created_at: z.string(),
});

/** One page of a list: GitHub's most. */
const PAGE = 100;
/** A list reads at most this many pages (1 000 issues). */
const PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (code: BoardErrorCode, message: string) =>
  ({ ok: false, error: { code, message } }) as const;

/** A `gh` failure as the Board says it. */
const boardError = (e: TrackingError): BoardError => {
  if (e.code === 'auth' || e.code === 'not-found') return { code: e.code, message: e.message };
  if (/HTTP 422|HTTP 400|Validation Failed/i.test(e.message))
    return { code: 'rejected', message: e.message };
  if (/HTTP 409/i.test(e.message)) return { code: 'conflict', message: e.message };
  if (/error connecting|could not resolve host|timeout|no answer/i.test(e.message))
    return { code: 'offline', message: e.message };

  return { code: 'gh-failed', message: e.message };
};

const person = (login: string): Person => ({ name: login, email: login });

const labelsOf = (i: RestIssue): string[] =>
  i.labels.map((l) => (typeof l === 'string' ? l : l.name));

const cardOf = (i: RestIssue): CardData => {
  const labels = labelsOf(i);
  const [assignee] = i.assignees ?? [];

  return {
    id: i.number,
    title: i.title,
    state: githubCardState({ state: i.state, stateReason: i.state_reason ?? null, labels }),
    type: githubCardType(labels),
    tags: githubCardTags(labels),
    assignee: assignee === undefined ? null : person(assignee.login),
    ...splitIssueBody(i.body),
    url: i.html_url,
    points: null,
    createdBy: i.user === null ? null : person(i.user.login),
  };
};

/** Whether an issue is a card of the board: of its types, with its tag, without its notTag. */
const onBoard = (b: BoardRef, i: RestIssue): boolean => {
  const labels = labelsOf(i);

  return (
    i.pull_request === undefined &&
    b.types.includes(githubCardType(labels)) &&
    (b.tag === undefined || carriesTag(labels, b.tag)) &&
    (b.notTag === undefined || !carriesTag(labels, b.notTag))
  );
};

/** Open, or closed as completed within the last `days` (`card list --closed`). */
const shows = (i: RestIssue, done: DoneCards | undefined, now: number): boolean => {
  if (i.state === 'open') return true;
  if (done === undefined || !('days' in done)) return false;
  const closed = Date.parse(i.closed_at ?? i.updated_at);

  return (
    githubCardState({ state: i.state, stateReason: i.state_reason ?? null, labels: [] }) ===
      'Closed' && closed >= now - done.days * DAY_MS
  );
};

const newestFirst = (issues: readonly RestIssue[]) =>
  issues.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at) || b.number - a.number);

const assigned = (i: RestIssue, login: string) =>
  (i.assignees ?? []).some((a) => a.login.toLowerCase() === login.toLowerCase());

/** The repo a GitHub board names, or why it has none. */
const repoOf = (b: BoardRef): Boarded<string> =>
  b.repo === undefined
    ? fail('no-board', 'the board names no GitHub repo (board.repo, or a GitHub origin)')
    : { ok: true, data: b.repo };

/** The Board on GitHub Issues, each call through `ghAs(<the board's gh login>)`. */
export const githubBoard = (o: {
  ghAs: (account: string | null) => Gh;
  now?: () => number;
}): Board => {
  const now = o.now ?? Date.now;
  const logins = new Map<string, string>();

  const call = async <T extends z.ZodType>(
    b: BoardRef,
    schema: T,
    args: readonly string[],
    input?: unknown,
  ): Promise<Boarded<z.output<T>>> => {
    const gh = o.ghAs(b.githubAccount ?? null);
    const out = await gh(args, input === undefined ? undefined : JSON.stringify(input));

    if (!out.ok) return { ok: false, error: boardError(out.error) };
    const read = readGh(schema, out.stdout);

    return read.ok ? read : { ok: false, error: boardError(read.error) };
  };
  const api = <T extends z.ZodType>(b: BoardRef, schema: T, path: string) =>
    call(b, schema, ['api', path]);
  const send = <T extends z.ZodType>(
    b: BoardRef,
    schema: T,
    method: string,
    path: string,
    input: unknown,
  ) => call(b, schema, ['api', '-X', method, path, '--input', '-'], input);

  /** Every page of `GET repos/<repo>/issues?<query>`, pull requests included (callers drop them). */
  const issues = async (b: BoardRef, query: string): Promise<Boarded<RestIssue[]>> => {
    const repo = repoOf(b);

    if (!repo.ok) return repo;
    const all: RestIssue[] = [];

    for (let page = 1; page <= PAGES; page++) {
      const read = await api(
        b,
        z.array(RestIssue),
        `repos/${repo.data}/issues?${query}&per_page=${PAGE}&page=${page}`,
      );

      if (!read.ok) return read;
      all.push(...read.data);
      if (read.data.length < PAGE) break;
    }

    return { ok: true, data: all };
  };

  const issue = async (b: BoardRef, id: number): Promise<Boarded<RestIssue>> => {
    const repo = repoOf(b);

    if (!repo.ok) return repo;
    const read = await api(b, RestIssue, `repos/${repo.data}/issues/${id}`);

    if (!read.ok) return read;

    return read.data.pull_request === undefined
      ? read
      : fail('not-found', `#${id} is a pull request on ${repo.data}, not an issue`);
  };

  const patch = async (b: BoardRef, id: number, input: unknown): Promise<Boarded<RestIssue>> => {
    const repo = repoOf(b);

    return repo.ok ? send(b, RestIssue, 'PATCH', `repos/${repo.data}/issues/${id}`, input) : repo;
  };

  /** Your gh login on GitHub, once per gh login asked. */
  const login = async (b: BoardRef): Promise<Boarded<string>> => {
    const key = b.githubAccount ?? '';
    const kept = logins.get(key);

    if (kept !== undefined) return { ok: true, data: kept };
    const read = await api(b, User, 'user');

    if (read.ok) logins.set(key, read.data.login);

    return read.ok ? { ok: true, data: read.data.login } : read;
  };

  const loginOf = async (b: BoardRef, who: AssignTo): Promise<Boarded<string[]>> => {
    if (who.kind === 'none') return { ok: true, data: [] };
    if (who.kind === 'member') return { ok: true, data: [who.login] };
    const me = await login(b);

    return me.ok ? { ok: true, data: [me.data] } : me;
  };

  const unsupported = (what: string) =>
    Promise.resolve(fail('unsupported', `a GitHub board has no ${what}`));

  const stateList = GITHUB_STATES.join(', ');

  const board: Board = {
    list: async (b, { mine, iteration, done }) => {
      // GitHub has no sprints: no card is in one
      if (iteration !== undefined) return { ok: true, data: [] };
      const me = mine ? await login(b) : undefined;

      if (me?.ok === false) return me;
      const by = me === undefined ? '' : `&assignee=${encodeURIComponent(me.data)}`;
      const open = await issues(b, `state=open&sort=updated&direction=desc${by}`);

      if (!open.ok) return open;
      // the done ones of the last days: closed since then, so changed since then too
      const closed =
        done !== undefined && 'days' in done
          ? await issues(
              b,
              `state=closed&since=${new Date(now() - done.days * DAY_MS).toISOString()}&sort=updated&direction=desc${by}`,
            )
          : { ok: true as const, data: [] };

      if (!closed.ok) return closed;
      const found = [...open.data, ...closed.data].filter(
        (i) => onBoard(b, i) && shows(i, done, now()),
      );

      return { ok: true, data: newestFirst(found).map(cardOf) };
    },
    currentSprint: () => Promise.resolve({ ok: true, data: null }),
    changes: async (b, since) => {
      if (since === null)
        return { ok: true, data: { at: new Date(now()).toISOString(), cards: [], gone: [] } };
      const changed = await issues(b, `state=all&since=${since}&sort=updated&direction=asc`);

      if (!changed.ok) return changed;
      const ones = changed.data.filter((i) => i.pull_request === undefined);
      // `since` takes the second it names too: the next look starts a second after the last change
      const last = ones.reduce((t, i) => Math.max(t, Date.parse(i.updated_at)), Date.parse(since));
      const at = ones.length === 0 ? since : new Date(last + 1000).toISOString();
      const days: DoneCards = { days: DONE_DAYS };
      const listed = ones.filter((i) => onBoard(b, i) && shows(i, days, now()));
      const me = listed.length === 0 ? undefined : await login(b);

      if (me?.ok === false) return me;

      return {
        ok: true,
        data: {
          at,
          cards: newestFirst(listed).map((i) => ({
            card: cardOf(i),
            mine: me !== undefined && assigned(i, me.data),
          })),
          gone: ones.filter((i) => !listed.includes(i)).map((i) => i.number),
        },
      };
    },
    show: async (b, id) => {
      const read = await issue(b, id);

      if (!read.ok) return read;
      const comments = await api(
        b,
        z.array(RestComment),
        `repos/${b.repo ?? ''}/issues/${id}/comments?per_page=${PAGE}`,
      );

      if (!comments.ok) return comments;

      return {
        ok: true,
        data: {
          ...cardOf(read.data),
          comments: comments.data.map((c) => ({
            id: c.id,
            text: c.body ?? '',
            by: c.user?.login ?? '',
            at: c.created_at,
          })),
        },
      };
    },
    image: () => unsupported('image reads: open the issue on GitHub'),
    comment: async (b, id, markdown) => {
      const read = await issue(b, id);

      if (!read.ok) return read;
      const made = await send(
        b,
        RestComment,
        'POST',
        `repos/${b.repo ?? ''}/issues/${id}/comments`,
        { body: markdown },
      );

      return made.ok
        ? {
            ok: true,
            data: {
              card: id,
              id: made.data.id,
              text: made.data.body ?? markdown,
              by: made.data.user?.login ?? '',
              at: made.data.created_at,
            },
          }
        : made;
    },
    tag: async (b, id, change) => {
      const columns = [...change.add, ...change.remove].filter(isStateLabel);

      if (columns.length > 0)
        return fail(
          'rejected',
          `${columns.join(', ')}: a GitHub board's column label; move the card instead (abe card move)`,
        );
      const read = await issue(b, id);

      if (!read.ok) return read;
      const labels = labelsOf(read.data);
      const tags = githubCardTags(labels);
      const next = retag(tags, change);

      if (JSON.stringify(next) === JSON.stringify(tags))
        return { ok: true, data: cardOf(read.data) };
      const written = await patch(b, id, { labels: [...labels.filter(isStateLabel), ...next] });

      return written.ok ? { ok: true, data: cardOf(written.data) } : written;
    },
    move: async (b, id, state) => {
      const to = githubStateOf(state);

      if (to === undefined)
        return fail('rejected', `'${state}' is not a state of a GitHub board's card: ${stateList}`);
      const read = await issue(b, id);

      if (!read.ok) return read;
      const w = githubStateWrite(to, { state: read.data.state, labels: labelsOf(read.data) });
      const written = await patch(b, id, {
        state: w.state,
        ...(w.stateReason === null ? {} : { state_reason: w.stateReason }),
        labels: w.labels,
      });

      return written.ok ? { ok: true, data: cardOf(written.data) } : written;
    },
    assign: async (b, id, who) => {
      const to = await loginOf(b, who);

      if (!to.ok) return to;
      const read = await issue(b, id);

      if (!read.ok) return read;
      const written = await patch(b, id, { assignees: to.data });

      if (!written.ok) return written;
      // GitHub leaves out an assignee it can't take (no access to the repo) without a word
      const left = to.data.filter((l) => !assigned(written.data, l));

      return left.length === 0
        ? { ok: true, data: cardOf(written.data) }
        : fail(
            'rejected',
            `GitHub did not assign #${id} to ${left.join(', ')}: not someone who can be assigned on ${b.repo ?? ''} (abe card members)`,
          );
    },
    members: async (b) => {
      const repo = repoOf(b);

      if (!repo.ok) return repo;
      const [me, people] = await Promise.all([
        login(b),
        api(b, z.array(User), `repos/${repo.data}/assignees?per_page=${PAGE}`),
      ]);

      if (!me.ok) return me;
      if (!people.ok) return people;

      return {
        ok: true,
        data: people.data.map((p) => ({
          ...person(p.login),
          you: p.login.toLowerCase() === me.data.toLowerCase(),
        })),
      };
    },
    me: async (b) => {
      const me = await login(b);

      return me.ok ? { ok: true, data: person(me.data) } : me;
    },
    create: async (b, card) => {
      const repo = repoOf(b);

      if (!repo.ok) return repo;
      const type = card.type ?? b.types[0];

      if (type === undefined) return fail('rejected', 'the board names no card type to create');
      if (!b.types.includes(type))
        return fail('rejected', `'${type}' is not a type of this board: ${b.types.join(', ')}`);
      const state = card.state === undefined ? 'New' : githubStateOf(card.state);

      if (state === undefined)
        return fail(
          'rejected',
          `'${card.state ?? ''}' is not a state of a GitHub issue: ${stateList}`,
        );
      const assignees = card.assignee === 'me' ? await loginOf(b, { kind: 'me' }) : undefined;

      if (assignees?.ok === false) return assignees;
      const w = githubStateWrite(state, {
        state: 'open',
        labels: [...(card.tags ?? []), ...(type === 'Bug' ? [GITHUB_BUG_LABEL] : [])],
      });
      const made = await send(b, RestIssue, 'POST', `repos/${repo.data}/issues`, {
        title: card.title,
        body: issueBody(card),
        labels: [...new Set(w.labels)],
        ...(assignees === undefined ? {} : { assignees: assignees.data }),
      });

      if (!made.ok) return made;
      const closed =
        w.state === 'closed'
          ? await patch(b, made.data.number, { state: 'closed', state_reason: w.stateReason })
          : made;

      if (!closed.ok) return closed;
      if (card.parent !== undefined) {
        const linked = await send(
          b,
          z.unknown(),
          'POST',
          `repos/${repo.data}/issues/${card.parent}/sub_issues`,
          { sub_issue_id: made.data.id },
        );

        if (!linked.ok)
          return fail(
            linked.error.code,
            `#${made.data.number} is made, but not as a sub-issue of #${card.parent}: ${linked.error.message}`,
          );
      }

      return { ok: true, data: cardOf(closed.data) };
    },
    attach: () => unsupported('attachments: GitHub takes files only in its web page'),
    write: async (b, id, text) => {
      const read = await issue(b, id);

      if (!read.ok) return read;
      const was = splitIssueBody(read.data.body);
      const body =
        text.description === undefined && text.acceptanceCriteria === undefined
          ? undefined
          : issueBody({
              description: text.description ?? was.description,
              acceptanceCriteria: text.acceptanceCriteria ?? was.acceptanceCriteria,
            });
      const written = await patch(b, id, {
        ...(text.title === undefined ? {} : { title: text.title }),
        ...(body === undefined ? {} : { body }),
      });

      return written.ok ? { ok: true, data: cardOf(written.data) } : written;
    },
  };

  return board;
};

/** The GitHub board from `env`'s gh: each gh login (`logins.gh`) on its own token, gh's active one else. */
export const githubBoardFrom = (env: Env): Board => {
  const tokenOf = ghTokens(env);
  const made = new Map<string, Gh>();

  return githubBoard({
    ghAs: (account) => {
      const key = account ?? '';
      const was = made.get(key);

      if (was !== undefined) return was;
      const gh = account === null ? ghRunner(env) : ghRunner(env, undefined, tokenOf(account));

      made.set(key, gh);

      return gh;
    },
  });
};
