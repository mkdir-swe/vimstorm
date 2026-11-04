/** Local mode's rules (#24): which checkout a folder is in, and the held ports (every write recorded, none sent). */
import { describe, expect, test } from 'bun:test';
import {
  type Board,
  type CardDetail,
  cardName,
  type Git,
  heldBoard,
  heldGit,
  heldLayerPulls,
  heldOrgStore,
  heldReview,
  type LayerPulls,
  type OrgStore,
  type ReviewPort,
  heldPipelines,
  type HeldStore,
  heldTracking,
  type HeldWrite,
  type HoldInput,
  localCards,
  localCheckoutOf,
  localName,
  localNumber,
  type LocalPr,
  parseCardId,
  parseLocalName,
  type Pipelines,
  type Repo,
  type Tracking,
} from '@abe/core';
import { card, fakeBoard, fakePipelines, fakeReview, refusingTracking } from '@abe/testing';

/** `port` with each call's method name kept in `calls`, passed on unchanged. */
const recorded = <T extends object>(port: T, calls: string[]): T =>
  new Proxy(port, {
    get: (target, key, receiver) => {
      const value: unknown = Reflect.get(target, key, receiver);

      return typeof value === 'function'
        ? (...args: unknown[]) => {
            calls.push(String(key));

            const out: unknown = Reflect.apply(value, target, args);

            return out;
          }
        : value;
    },
  });

/** An in-memory store: what a held port recorded. */
const memoryStore = () => {
  const held: HeldWrite[] = [];
  const prs: LocalPr[] = [];
  let made: CardDetail[] = [];
  const store: HeldStore = {
    record: (w: HoldInput) => {
      const one: HeldWrite = {
        seq: held.length + 1,
        at: '2026-10-26T09:00:00.000Z',
        checkout: '/w/demo',
        kind: w.kind,
        what: w.what,
        where: w.where,
        card: w.card ?? null,
        to: w.to ?? null,
        open: w.open ?? null,
        ...(w.tags === undefined ? {} : { tags: w.tags }),
        ...(w.text === undefined ? {} : { text: w.text }),
        ...(w.fields === undefined ? {} : { fields: w.fields }),
      };

      held.push(one);

      return Promise.resolve(one);
    },
    issueCreate: (i) =>
      Promise.resolve({
        ...i,
        labels: [...i.labels],
        number: localNumber(1),
        checkout: '/w/demo',
        file: '/f',
      }),
    issue: () => Promise.resolve(undefined),
    prFind: () => Promise.resolve(undefined),
    pr: (n) => Promise.resolve(prs.find((p) => p.number === n)),
    prOpen: (i) => {
      const p: LocalPr = {
        ...i,
        number: localNumber(prs.length + 1),
        name: localName(localNumber(prs.length + 1)),
        checkout: '/w/demo',
        card: null,
        headSha: 'abc',
        file: '/f',
        state: 'open',
        openedAt: '2026-10-26T09:00:00.000Z',
        updatedAt: '2026-10-26T09:00:00.000Z',
        mergeCommit: null,
        baseSha: '',
        files: [],
        commits: [],
      };

      prs.push(p);

      return Promise.resolve(p);
    },
    prUpdate: (n, change) => {
      const p = prs.find((x) => x.number === n);

      return Promise.resolve(p === undefined ? undefined : { ...p, ...change });
    },
    prMerge: (n) => {
      const p = prs.find((x) => x.number === n);

      return Promise.resolve(
        p === undefined
          ? { ok: false, error: { code: 'not-found', message: 'none' } }
          : { ok: true, data: { ...p, state: 'merged', mergeCommit: 'def' } },
      );
    },
    writes: () => Promise.resolve([...held]),
    cardCreate: (c) => {
      const one: CardDetail = {
        ...c,
        id: localNumber(made.length + 1),
        url: `local:LC${made.length + 1}`,
        comments: [],
      };

      made = [...made, one];

      return Promise.resolve(one);
    },
    card: (id) => Promise.resolve(made.find((c) => c.id === id)),
    cardChange: (id, change) => {
      const was = made.find((c) => c.id === id);

      if (was === undefined) return Promise.resolve(undefined);
      const now = change(was);

      made = made.map((c) => (c.id === id ? now : c));

      return Promise.resolve(now);
    },
    cards: () => Promise.resolve([...made].reverse()),
  };

  return { store, held };
};

const REPO = 'acme/demo' as Repo; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- a fixed test name
const B = { organization: 'https://dev.azure.com/o', project: 'Shop', team: 'Web', types: ['Bug'] };
const SRC = { provider: 'github-actions', repo: REPO } as const;
const GATE = {
  id: 'g',
  kind: 'environment',
  environment: 'prod',
  since: null,
  canApprove: true,
} as const;

/** The writing ports' methods: each one's call, and what it records. */
const WRITES: readonly [
  string,
  (p: {
    tracking: Tracking;
    board: Board;
    git: Git;
    pipelines: Pipelines;
    review: ReviewPort;
    layerPulls: LayerPulls;
  }) => Promise<unknown>,
  HeldWrite['kind'],
][] = [
  ['card move', (p) => p.board.move(B, 7, 'Active'), 'card-move'],
  ['card assign', (p) => p.board.assign(B, 7, { kind: 'none' }), 'card-assign'],
  ['card tag', (p) => p.board.tag(B, 7, { add: ['x'], remove: [] }), 'card-tag'],
  ['card write', (p) => p.board.write(B, 7, { title: 'New title' }), 'card-write'],
  ['card comment', (p) => p.board.comment(B, 7, 'hi'), 'card-comment'],
  [
    'card create',
    (p) => p.board.create(B, { title: 't', description: '', acceptanceCriteria: '' }),
    'card-create',
  ],
  [
    'card attach',
    (p) => p.board.attach(B, 7, { name: 'a.png', bytes: new Uint8Array([1]) }),
    'card-attach',
  ],
  [
    'issue create',
    (p) => p.tracking.issueCreate({ repo: REPO, title: 'Spec', body: 'b', labels: ['spec'] }),
    'issue-create',
  ],
  [
    'issue comment',
    (p) => p.tracking.issueComment({ repo: REPO, number: 3 }, 'hi'),
    'issue-comment',
  ],
  [
    'pr create',
    (p) =>
      p.tracking.prCreate({
        repo: REPO,
        head: 'f',
        base: 'main',
        title: 't',
        body: 'b',
        draft: false,
      }),
    'pr-create',
  ],
  [
    'pr update on GitHub',
    (p) => p.tracking.prUpdate({ repo: REPO, number: 3 }, { body: 'b' }),
    'pr-update',
  ],
  [
    'pr merge on GitHub',
    (p) => p.tracking.prMerge({ repo: REPO, number: 3 }, { method: 'squash' }),
    'pr-merge',
  ],
  ['push', (p) => p.git.push('/w/demo-wt/7', 'f'), 'push'],
  ['pipeline rerun', (p) => p.pipelines.control(SRC, '1', 1, 'rerun'), 'pipeline-control'],
  ['pipeline approve', (p) => p.pipelines.approve(SRC, '1', GATE), 'pipeline-approve'],
  [
    'pipeline run',
    (p) => p.pipelines.dispatch(SRC, 'deploy.yml', 'main', { env: 'dev' }),
    'pipeline-run',
  ],
  [
    'review submit',
    (p) =>
      p.review.submit(REPO, {
        submission: 's',
        reconcileOnly: false,
        pr: 3,
        commit: 'abc',
        verdict: 'Comment',
        comments: [],
      }),
    'review-submit',
  ],
  [
    'review inline comment',
    (p) =>
      p.review.postComment({
        repo: REPO,
        number: 3,
        head: 'abc',
        submission: 's',
        reconcileOnly: false,
        comment: { path: 'a.ts', line: 1, side: 'RIGHT', body: 'hm' },
      }),
    'review-comment',
  ],
  [
    'review reply',
    (p) =>
      p.review.reply({
        repo: REPO,
        number: 3,
        commentId: 1,
        submission: 's',
        reconcileOnly: false,
        body: 'ok',
      }),
    'review-reply',
  ],
  ['review resolve', (p) => p.review.resolve('T_1', true), 'review-resolve'],
  ['review request', (p) => p.review.requestReviewers(REPO, 3, ['ann']), 'review-request'],
  ['pr ready', (p) => p.review.ready(REPO, 3), 'pr-ready'],
  ['pr close', (p) => p.review.close(REPO, 3), 'pr-close'],
  ['pr say', (p) => p.review.say(REPO, 3, 'Looks good'), 'review-comment'],
  [
    'draft pr',
    (p) =>
      p.review.draftCreate({
        plan: {
          root: '/w/demo',
          repo: REPO,
          branch: 'f',
          head: 'abc',
          base: 'main',
          origin: 'x',
          title: 't',
          body: 'b',
          commits: 1,
          files: 1,
          uncommitted: [],
          published: false,
          existing: null,
          branches: ['main'],
          reviewers: [],
        },
        title: 't',
        body: 'b',
        base: 'main',
        push: true,
      }),
    'pr-draft',
  ],
  [
    'layer proposal',
    (p) =>
      p.layerPulls.propose({
        repo: REPO,
        base: { branch: 'main', sha: 'abc' },
        branch: 'abe/propose',
        title: 't',
        body: 'b',
        message: 'm',
        label: null,
        files: [{ path: 'settings.yaml', content: 'a: 1\n' }],
      }),
    'layer-propose',
  ],
];

/** The calls that would have written: every method but the reads. */
const WRITE_NAMES = new Set([
  'move',
  'assign',
  'tag',
  'write',
  'comment',
  'create',
  'attach',
  'issueCreate',
  'issueComment',
  'prCreate',
  'prUpdate',
  'prMerge',
  'push',
  'control',
  'approve',
  'submit',
  'postComment',
  'reply',
  'resolve',
  'requestReviewers',
  'ready',
  'close',
  'draftCreate',
  'propose',
]);

describe('held ports: every write recorded, none sent', () => {
  for (const [name, call, kind] of WRITES)
    test(name, async () => {
      const calls: string[] = [];
      const { store, held } = memoryStore();
      const git: Git = {
        origin: () => Promise.resolve({ ok: true, data: { url: 'x', defaultBranch: 'main' } }),
        push: () => Promise.resolve({ ok: true, data: null }),
        fetchOrigin: () => Promise.resolve({ ok: true, data: null }),
        onOrigin: () => Promise.resolve({ ok: true, data: true }),
        startAt: () => Promise.resolve({ ok: true, data: { moved: false } }),
        work: () => Promise.resolve({ ok: true, data: null }),
        remove: () => Promise.resolve({ ok: true, data: null }),
        tidyWriters: () => Promise.resolve({ ok: true, data: { removed: [], deleted: [] } }),
      };
      const nothing = { ok: false, error: { code: 'gh-failed', message: 'no GitHub' } } as const;
      const layerPulls: LayerPulls = {
        base: () => Promise.resolve(nothing),
        show: () => Promise.resolve(nothing),
        propose: () => Promise.resolve(nothing),
        open: () => Promise.resolve(nothing),
      };
      const ports = {
        tracking: heldTracking(recorded(refusingTracking(), calls), store),
        board: heldBoard(recorded(fakeBoard([card(7, 'Sign in')]), calls), store),
        git: heldGit(recorded(git, calls), store),
        pipelines: heldPipelines(recorded(fakePipelines(), calls), store),
        review: heldReview(recorded(fakeReview(), calls), store),
        layerPulls: heldLayerPulls(recorded(layerPulls, calls), store),
      };

      await call(ports);
      expect(calls.filter((c) => WRITE_NAMES.has(c))).toEqual([]);
      expect(held.map((w) => w.kind)).toEqual([kind]);
    });

  test('the org store: written here, read here first, listed from both', async () => {
    const memory = (seed: Record<string, string>): OrgStore & { keys: () => string[] } => {
      const objects = new Map<string, Uint8Array>(
        Object.entries(seed).map(([k, v]) => [k, new TextEncoder().encode(v)]),
      );

      return {
        keys: () => [...objects.keys()].sort(),
        put: (key, body) => {
          objects.set(key, body);

          return Promise.resolve({ ok: true, data: { key, size: body.length } });
        },
        get: (key) => {
          const body = objects.get(key);

          return Promise.resolve(
            body === undefined
              ? { ok: false, error: { code: 'not-found', message: key } }
              : { ok: true, data: body },
          );
        },
        list: (prefix) =>
          Promise.resolve({
            ok: true,
            data: [...objects.entries()]
              .filter(([k]) => k.startsWith(prefix))
              .map(([key, b]) => ({ key, size: b.length })),
          }),
      };
    };
    const org = memory({
      'prototypes/shop/4/v1/meta.json': 'org',
      'prototypes/shop/4/v2/meta.json': 'org',
    });
    const here = memory({});
    const store = heldOrgStore(org, here);
    const text = async (key: string) => {
      const got = await store.get(key);

      return got.ok ? new TextDecoder().decode(got.data) : got.error.code;
    };

    await store.put(
      'prototypes/shop/4/v2/meta.json',
      new TextEncoder().encode('here'),
      'text/plain',
    );
    expect(org.keys()).toEqual([
      'prototypes/shop/4/v1/meta.json',
      'prototypes/shop/4/v2/meta.json',
    ]);
    expect(await text('prototypes/shop/4/v1/meta.json')).toBe('org');
    expect(await text('prototypes/shop/4/v2/meta.json')).toBe('here');
    expect(await text('prototypes/shop/5/v1/meta.json')).toBe('not-found');
    const listed = await store.list('prototypes/shop/4/');

    expect(listed.ok ? listed.data.map((o) => o.key) : []).toEqual([
      'prototypes/shop/4/v1/meta.json',
      'prototypes/shop/4/v2/meta.json',
    ]);
    expect(await heldOrgStore(undefined, here).get('prototypes/shop/4/v1/meta.json')).toMatchObject(
      {
        ok: false,
      },
    );
  });

  test('a local pull request reads back, merged here', async () => {
    const { store } = memoryStore();
    const t = heldTracking(refusingTracking(), store);
    const made = await t.prCreate({
      repo: REPO,
      head: 'f',
      base: 'main',
      title: 't',
      body: 'b',
      draft: false,
    });
    const number = made.ok ? made.data.number : 0;

    expect(await t.prFind({ repo: REPO, head: 'f' })).toMatchObject({ ok: true, data: null });
    expect(await t.prMerge({ repo: REPO, number }, { method: 'squash' })).toMatchObject({
      ok: true,
      data: { merged: true, sha: 'def' },
    });
    expect(localName(number)).toBe('L1');
  });
});

const NEW_CARD = { title: 'Gift wrap', description: '', acceptanceCriteria: '' };

describe("the held board: a new card is held here, held changes show over the board's", () => {
  const NEW = { title: 'Gift wrap', description: '', acceptanceCriteria: '', tags: ['prototype'] };
  /** What each row does on a board of AB#7 held, and what the board then reads. */
  const ROWS: readonly [
    string,
    (b: Board) => Promise<unknown>,
    (b: Board) => Promise<unknown>,
    unknown,
  ][] = [
    [
      'a new card: a held card LC1, listed first, read back',
      (b) => b.create(B, NEW),
      async (b) => {
        const listed = await b.list(B, { mine: false });

        return listed.ok ? listed.data.map((c) => [cardName(c.id), c.tags, c.url]) : listed;
      },
      [
        ['LC1', ['prototype'], 'local:LC1'],
        ['7', [], 'https://dev.azure.com/demo-org/Shop/_workitems/edit/7'],
      ],
    ],
    [
      'a held card moved and commented: its own state and comments',
      async (b) => {
        await b.create(B, NEW);
        await b.move(B, localNumber(1), 'Active');
        await b.comment(B, localNumber(1), 'hi');
      },
      async (b) => {
        const shown = await b.show(B, localNumber(1));

        return shown.ok ? [shown.data.state, shown.data.comments.map((c) => c.text)] : shown;
      },
      ['Active', ['hi']],
    ],
    [
      'a held card tagged off: its own tags',
      async (b) => {
        await b.create(B, NEW);
        await b.tag(B, localNumber(1), { add: ['x'], remove: ['prototype'] });
      },
      async (b) => {
        const shown = await b.show(B, localNumber(1));

        return shown.ok ? shown.data.tags : shown;
      },
      ['x'],
    ],
    [
      "a held tag on the board's card: on it as listed and shown",
      (b) => b.tag(B, 7, { add: ['prototype'], remove: [] }),
      async (b) => {
        const listed = await b.list(B, { mine: false });
        const shown = await b.show(B, 7);

        return [listed.ok ? listed.data.map((c) => c.tags) : listed, shown.ok && shown.data.tags];
      },
      [[['prototype']], ['prototype']],
    ],
    [
      "a held comment on the board's card: after the board's, said as held here",
      (b) => b.comment(B, 7, 'looks right'),
      async (b) => {
        const shown = await b.show(B, 7);

        return shown.ok ? shown.data.comments.map((c) => [c.text, c.by]) : shown;
      },
      [['looks right', 'you (held here)']],
    ],
    [
      "a held edit on the board's card: on it as listed and shown, the later one over the earlier",
      async (b) => {
        await b.write(B, 7, { title: 'Sign in fast', description: 'd1' });
        await b.write(B, 7, { description: 'd2' });
      },
      async (b) => {
        const listed = await b.list(B, { mine: false });
        const shown = await b.show(B, 7);

        return [
          listed.ok ? listed.data.map((c) => c.title) : listed,
          shown.ok && [shown.data.title, shown.data.description],
        ];
      },
      [['Sign in fast'], ['Sign in fast', 'd2']],
    ],
    [
      'a held card done or removed: not among the open ones',
      async (b) => {
        await b.create(B, NEW);
        await b.move(B, localNumber(1), 'Removed');
      },
      async (b) => {
        const listed = await b.list(B, { mine: false });

        return listed.ok ? listed.data.map((c) => c.id) : listed;
      },
      [7],
    ],
    [
      'a held card no one has: not found',
      () => Promise.resolve(),
      async (b) => {
        const shown = await b.show(B, localNumber(9));

        return shown.ok || shown.error.code;
      },
      'not-found',
    ],
  ];

  for (const [name, write, read, want] of ROWS)
    test(name, async () => {
      const calls: string[] = [];
      const { store } = memoryStore();
      const b = heldBoard(recorded(fakeBoard([card(7, 'Sign in')]), calls), store);

      await write(b);
      expect(await read(b)).toEqual(want);
      expect(calls.filter((c) => WRITE_NAMES.has(c))).toEqual([]);
    });
});

test('a board On this Mac is not held: its writes are its own, none recorded', async () => {
  const calls: string[] = [];
  const { store, held } = memoryStore();
  const mac = { ...B, provider: 'local' as const, organization: 'this machine' };
  const b = heldBoard(recorded(fakeBoard([card(7, 'Sign in')]), calls), store);

  await b.move(mac, 7, 'Active');
  await b.comment(mac, 7, 'hi');
  await b.create(mac, NEW_CARD);
  expect(calls.filter((c) => WRITE_NAMES.has(c))).toEqual(['move', 'comment', 'create']);
  expect(held).toEqual([]);
});

describe("each card's local state from its held writes", () => {
  const W = (seq: number, kind: HeldWrite['kind'], o: Partial<HeldWrite> = {}): HeldWrite => ({
    seq,
    at: `2026-10-26T09:0${seq}:00.000Z`,
    checkout: '/w/demo',
    kind,
    what: kind,
    where: 'x',
    card: 7,
    to: null,
    open: null,
    ...o,
  });
  const ROWS: readonly [string, HeldWrite[], Record<string, unknown> | undefined][] = [
    [
      'a move and an assignment',
      [W(1, 'card-move', { to: 'Active' }), W(2, 'card-assign', { to: 'me' })],
      { state: 'Active', assignee: 'me', added: [], removed: [] },
    ],
    [
      'a tag on',
      [W(1, 'card-tag', { tags: { add: ['prototype'], remove: [] } })],
      { state: null, added: ['prototype'], removed: [] },
    ],
    [
      'a tag on, then off',
      [
        W(1, 'card-tag', { tags: { add: ['prototype'], remove: [] } }),
        W(2, 'card-tag', { tags: { add: [], remove: ['prototype'] } }),
      ],
      { added: [], removed: ['prototype'] },
    ],
    [
      'comments: counted, no state',
      [W(1, 'card-comment', { text: 'a' }), W(2, 'card-comment', { text: 'b' })],
      { state: null, comments: 2 },
    ],
    [
      'field edits: each field once',
      [
        W(1, 'card-write', { fields: { title: 'A' } }),
        W(2, 'card-write', { fields: { title: 'B', description: 'd' } }),
      ],
      { state: null, edited: ['title', 'description'] },
    ],
    ['an attachment: nothing on the card', [W(1, 'card-attach')], undefined],
  ];

  for (const [name, held, want] of ROWS)
    test(name, () => {
      const [one] = localCards(held);

      if (want === undefined) expect(one).toBeUndefined();
      else expect(one).toMatchObject(want);
    });
});

describe('the checkout a folder is in, in local mode', () => {
  const ROWS: readonly [string, readonly string[], string, string | undefined][] = [
    ['the checkout itself', ['/w/demo'], '/w/demo', '/w/demo'],
    ['a folder in it', ['/w/demo'], '/w/demo/src/a', '/w/demo'],
    ["a card's worktree beside it", ['/w/demo'], '/w/demo-wt/7-sign-in', '/w/demo'],
    ['a sibling with the same start', ['/w/demo'], '/w/demo2', undefined],
    ['none listed', [], '/w/demo', undefined],
    ['the nearest of two', ['/w', '/w/demo/'], '/w/demo/x', '/w/demo'],
  ];

  for (const [name, list, dir, checkout] of ROWS)
    test(name, () => {
      expect(localCheckoutOf(list, dir)).toBe(checkout);
    });

  test("a held card's id: LC<n>", () => {
    expect(['LC3', '#LC3', 'AB#lc3', '3'].map(parseCardId)).toEqual([
      localNumber(3),
      localNumber(3),
      localNumber(3),
      3,
    ]);
    expect([localNumber(3), 1240].map(cardName)).toEqual(['LC3', '1240']);
  });

  test('L<n> names', () => {
    expect(['L3', '#L3', 'l3', '3', 'L0'].map(parseLocalName)).toEqual([
      localNumber(3),
      localNumber(3),
      localNumber(3),
      undefined,
      undefined,
    ]);
  });
});
