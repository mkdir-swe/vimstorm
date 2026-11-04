/**
 * The Run place's own components (design C, the run on the left): its bar (`Run #2 · demo-shop ·
 * Bug run`, `#2` the card, Linked ▾, expand), the steps (the run in time order, a quiet row per step
 * run: its mark, its name, at most one muted outcome word), the focus pane (the step the keys are
 * on: its header, its state above, then what it read on the left and what it made on the right,
 * its details folded under) and the spec's reader pane. Rust draws them (`app/src/factory/run.rs`);
 * the screen (`run.ts`) decides every word, hue and place.
 *
 * Clicks name: `run:card`, `run:linked`, `run:expand`, a row's `run:step:<id>`, Open in Chat
 * `run:chat:<id>`, a file's `run:file:<step>:<n>`, a detail's fold `run:detail:<step>:<kind>`, a
 * scratch file's `run:scratch:<step>:<n>`, a criterion's `run:proof:<n>`, a ticket's
 * `run:ticket:<step>:<id>`, a kit recording's play/pause `run:recording:<step>:<feature>:<part>`,
 * a kit shot's full size `run:shot:<step>:<feature>:<part>:<n>`, its page `run:url:…` the same,
 * the spec's page `run:spec:page`, the pane's actions (`run:review`, `run:pr`, `run:playbook`,
 * `run:spec`, `run:chat:<id>`).
 */
import { z } from 'zod';
import type { Hue } from '../runtime/components';

export const RUN_KINDS = ['RunBar', 'RunSteps', 'RunFocus', 'RunSpecPane'] as const;

/** The set's schemas, on the set's own primitives (`components.ts` calls this). */
export const runSchemas = (d: { nodeId: z.ZodString; hue: z.ZodType<Hue> }) => {
  const mark = z.strictObject({ glyph: z.string(), hue: d.hue });
  const criterion = z.strictObject({
    n: z.number().int().positive(),
    mark,
    text: z.string(),
    /** It has proof to jump to (`proof ↓`). */
    proof: z.boolean(),
  });
  // the verify kit's parts (core's `verify-html.ts`), paths absolute
  const where = {
    /** The page it shows (`http://localhost:5173/cart`); '' none (an older report). */
    url: z.string(),
    /** The URL's click: `run:url:<step>:<feature>:<part>:<n>`, opened in the browser. */
    urlId: d.nodeId,
    /** The account it was driven as (`buyer`); '' none. */
    account: z.string(),
  };
  const shot = z.strictObject({
    /** Its click: `run:shot:<step>:<feature>:<part>:<n>`, the image opened full size. */
    id: d.nodeId,
    path: z.string(),
    alt: z.string(),
    caption: z.string(),
    ...where,
  });
  const kitPart = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('pair'), before: shot, after: shot }),
    z.strictObject({ kind: z.literal('shot'), shot }),
    z.strictObject({
      kind: z.literal('recording'),
      /** Its control's click: `run:recording:<step>:<feature>:<part>`. */
      id: d.nodeId,
      /** The GIF played in place ('' none: the control opens `path` in the local player). */
      gif: z.string(),
      /** Its still while paused or not played in place ('' none). */
      still: z.string(),
      path: z.string(),
      playing: z.boolean(),
      /** `❚❚ Pause`, `▶ Play`, `▶ Open in player`. */
      control: z.string(),
      /** A click on it, and on `Open video`: the recording in the local player. */
      videoId: d.nodeId,
      /** Whether `Open video` is drawn by its GIF's control: the GIF plays a video of its own. */
      openVideo: z.boolean(),
      caption: z.string(),
      ...where,
    }),
    z.strictObject({ kind: z.literal('judged'), head: z.string(), text: z.string() }),
    z.strictObject({ kind: z.literal('not-driven'), head: z.string(), text: z.string() }),
    z.strictObject({
      kind: z.literal('transcript'),
      path: z.string(),
      caption: z.string(),
      lines: z.array(z.string()),
    }),
  ]);
  const kitFeature = z.strictObject({
    feature: z.string(),
    title: z.string(),
    /** `✓` good, `✗` bad, `○` dim (not driven). */
    mark,
    /** `Pass`, `Fail`, `Not driven`. */
    verdict: z.string(),
    /** `features/cart.md`. */
    file: z.string(),
    /** Where the app ran: `local`, `dev`, `test`; '' not said. */
    env: z.string(),
    parts: z.array(kitPart),
  });
  const file = z.strictObject({
    /** Its click: `run:file:<step>:<n>` shows its diff under the files. */
    id: d.nodeId,
    path: z.string(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    /** Its diff shown (a click on it): the hunks' lines, ` ` `-` `+` first. */
    lines: z.array(z.string()).optional(),
  });

  const decision = z.strictObject({ chose: z.string(), over: z.string(), why: z.string() });
  const command = z.strictObject({ mark, command: z.string(), result: z.string() });
  const proof = z.strictObject({
    n: z.number().int().positive(),
    mark,
    text: z.string(),
    how: z.string(),
    evidence: z.array(z.strictObject({ kind: z.enum(['output', 'screenshot']), text: z.string() })),
    /** `▶ 0:03`; empty for none. */
    chapter: z.string(),
  });
  /** A word in its hue (a tag, an axis, a finding's state, who takes a step). */
  const word = z.strictObject({ text: z.string(), hue: d.hue });
  /** A card on a lane: a ticket (its click `run:ticket:<step>:<id>` opens it) or a writer. */
  const laneCard = z.strictObject({
    /** Its click opens or shuts it; absent: always open (a writer's card). */
    id: d.nodeId.optional(),
    /** `#41 · T1`, `slice 1`. */
    ref: z.string(),
    title: z.string(),
    /** On its right, dim: `4 min`, `4 min so far`. */
    time: z.string(),
    /** Under its title, dim: what to build. */
    summary: z.string(),
    /** `starts now` (good), `after T1`, an area. */
    tags: z.array(word),
    /** Shown while open: `writer abe:writer · worktree 4-t1`, `commits a1f20c3 …`, `tests ✓ …`. */
    rows: z.array(z.strictObject({ label: z.string(), value: z.string(), mark: mark.optional() })),
    /** Shown while open, under the rows: `From the spec` chips (`Story 1`, `Decision 4: …`). */
    chips: z.array(z.string()),
    open: z.boolean(),
  });
  /**
   * One part of a block. The kinds: the card's head, words, a list, questions and answers, label
   * and value rows, commits, checks, review findings, lanes of cards (tickets by wave, writers
   * by wave, milestones between), the pull request's ladder, a document (markdown: the spec, a
   * report, the PR's body), the verify kit's features, a report's proof rows, criteria, files,
   * decisions, numbered steps (the Playbook's).
   */
  const part = z.discriminatedUnion('kind', [
    /** `AB#4 · story · Sprint 1` in accent, its title, its words quiet (markdown, drawn). */
    z.strictObject({
      kind: z.literal('card'),
      ref: z.string(),
      title: z.string(),
      text: z.string(),
    }),
    /** `quote`: in a quiet box (a judge's call, a decision taken). */
    z.strictObject({
      kind: z.literal('text'),
      text: z.string(),
      tone: z.enum(['plain', 'dim', 'quote']),
    }),
    /** Rows of words, each with a dim mono note under it; numbered or not; a mark before each. */
    z.strictObject({
      kind: z.literal('list'),
      numbered: z.boolean(),
      rows: z.array(z.strictObject({ mark: mark.optional(), text: z.string(), note: z.string() })),
    }),
    z.strictObject({
      kind: z.literal('qa'),
      rows: z.array(z.strictObject({ q: z.string(), a: z.string(), by: z.string() })),
    }),
    /** Label and value rows (`Head card/4 · 7 commits ahead`). */
    z.strictObject({
      kind: z.literal('facts'),
      rows: z.array(z.strictObject({ label: z.string(), value: z.string() })),
    }),
    /** A commit a row: its short sha in accent, its subject, a dim note (`T1`, `build #2`). */
    z.strictObject({
      kind: z.literal('commits'),
      rows: z.array(z.strictObject({ sha: z.string(), subject: z.string(), note: z.string() })),
    }),
    /** A check a row: its mark, name, time and exit, its command under; a red one's output tail. */
    z.strictObject({
      kind: z.literal('checks'),
      rows: z.array(
        z.strictObject({
          mark,
          name: z.string(),
          command: z.string(),
          /** `41 s`, `1 m 52 s`. */
          time: z.string(),
          /** `exit 0`, `exit 1`, `killed`; empty for a built-in. */
          exit: z.string(),
          /** The output's last lines (a red one's); empty for none. */
          output: z.array(z.string()),
          /** Under it, dim: `61 passed, 0 failed`, `full output in checks.md`. */
          more: z.string(),
          red: z.boolean(),
        }),
      ),
    }),
    /** A finding a row: its axis, `file:line`, its state on the right; what is wrong → its fix. */
    z.strictObject({
      kind: z.literal('findings'),
      rows: z.array(
        z.strictObject({
          /** `Standards` (accent), `Spec` (needs-you hue), `Noted` (dim). */
          axis: word,
          loc: z.string(),
          what: z.string(),
          fix: z.string(),
          /** `✓ fixed in build #2` (good), `open` (warn); absent for a noted one. */
          state: word.optional(),
        }),
      ),
    }),
    /** Lanes: each a label column (`Wave 1`, `2 writers at once`) and its cards; a milestone after. */
    z.strictObject({
      kind: z.literal('lanes'),
      lanes: z.array(
        z.strictObject({
          label: z.string(),
          note: z.string(),
          cards: z.array(laneCard),
          /** `◆ Milestone 1` in the needs-you hue, then its words; absent: none after it. */
          milestone: z.strictObject({ label: z.string(), text: z.string() }).optional(),
        }),
      ),
    }),
    /** The pull request's way: Pushed, Opened, Checks, Review, Merge, Done; the one now washed. */
    z.strictObject({
      kind: z.literal('ladder'),
      rungs: z.array(
        z.strictObject({ mark, label: z.string(), note: z.string(), on: z.boolean() }),
      ),
    }),
    /**
     * A document on a paper: a dim mono eyebrow (`Spec · issue #40 · from AB#4`), its title, a
     * dim line under it, then its markdown (headings, paragraphs, lists, quotes, fenced code).
     */
    z.strictObject({
      kind: z.literal('doc'),
      eyebrow: z.string(),
      title: z.string(),
      meta: z.string(),
      markdown: z.string(),
    }),
    /** The verify kit's features: verdict, shots, before/after pairs, recordings, how judged. */
    z.strictObject({ kind: z.literal('kit'), features: z.array(kitFeature) }),
    /** A report's numbered steps: how and what was seen, a screenshot drawn, an output, a chapter. */
    z.strictObject({
      kind: z.literal('proof'),
      rows: z.array(proof),
      /** The recording's line: `▶ 0:42`, its path, its chapters' numbers. */
      recording: z
        .strictObject({ length: z.string(), path: z.string(), chapters: z.array(z.string()) })
        .optional(),
    }),
    z.strictObject({ kind: z.literal('criteria'), rows: z.array(criterion) }),
    z.strictObject({ kind: z.literal('files'), rows: z.array(file) }),
    z.strictObject({ kind: z.literal('decisions'), rows: z.array(decision) }),
    /** Numbered steps (a Playbook's): its title, its words in their hues, its text, a command. */
    z.strictObject({
      kind: z.literal('steps'),
      rows: z.array(
        z.strictObject({
          n: z.number().int().positive(),
          title: z.string(),
          meta: z.array(word),
          text: z.string(),
          /** Mono, in a quiet box; empty for none. */
          command: z.string(),
        }),
      ),
    }),
  ]);
  /**
   * A block of a column: its caption (`ACCEPTANCE CRITERIA ON THE CARD`) and, boxed, a panel with
   * its title and verdict (`✓ green`, `● sent back`) on its head, then its parts.
   */
  const block = z.strictObject({
    title: z.string(),
    verdict: word.optional(),
    boxed: z.boolean(),
    parts: z.array(part),
  });
  /** A column: `READ` / `MADE`, a dim note after it, its blocks. */
  const column = z.strictObject({ note: z.string(), blocks: z.array(block) });

  /** A folded detail's head: its click `run:detail:<step>:<kind>` opens or shuts it. */
  const head = {
    id: d.nodeId,
    /** `Commands run`, `Verify report`, `Scratch files`, `Skills it pulled in`. */
    label: z.string(),
    /** Dim after it: `5 · 1 failed`, `3 features`. */
    note: z.string(),
    open: z.boolean(),
  };

  return [
    z.strictObject({
      kind: z.literal('RunBar'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        /** `#2`, its click `run:card` (⏎ with the keys on it) the full card; empty: no card. */
        card: z.string(),
        /** The card's title: `#2`'s tooltip. */
        title: z.string(),
        /** The keys are on `#2`. */
        on: z.boolean(),
        /** `demo-shop · Bug run · Local sandbox · 19 min so far`. */
        context: z.string(),
        /** Linked ▾'s drop-down is up. */
        linked: z.boolean(),
      }),
    }),
    z.strictObject({
      kind: z.literal('RunSteps'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        /** The run in time order: a row per step run, a loop's rounds each their own. */
        rows: z.array(
          z.strictObject({
            /** The step's id; its click `run:step:<id>`. */
            id: d.nodeId,
            /** `✓` `●` `◆` `–`; empty for one not reached. */
            mark,
            /** Its name in the workflow (`build`, `playbook`). */
            name: z.string(),
            /** At most one muted word: `1 finding`, `skipped`, `needs you`, `round 2`; empty for none. */
            outcome: z.string(),
            /** It sent the run back: `↩` after its word. */
            back: z.boolean(),
            /** Skipped, or not reached yet: dim. */
            dim: z.boolean(),
            /** Not reached yet: nothing to open. */
            todo: z.boolean(),
            /** It waits on you: its name in the Needs you hue. */
            needsYou: z.boolean(),
          }),
        ),
        /** The row the focus pane shows; absent while the keys are on `#2`. */
        selected: d.nodeId.optional(),
        /** Said when the run has no steps yet. */
        empty: z.string().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('RunFocus'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        /** The step shown: its id. */
        step: d.nodeId,
        name: z.string(),
        /** Its one main skill (`implement`); empty for none (checks). */
        skill: z.string(),
        /** After the skill: `09:18 · 3 min · subagent`. */
        meta: z.string(),
        /** `✓ done`, `● sent back`, `◆ needs you`, `– skipped`. */
        state: z.strictObject({ text: z.string(), hue: d.hue }),
        /** Its subagent started with a cleared context: `⟲ fresh`. */
        fresh: z.boolean(),
        /** `round 2 of 3`; empty for a step run once. */
        round: z.string(),
        /** `sent back from checks`; empty when it was not. */
        back: z.string(),
        /** It can open Chat at its point: `Open in Chat ↗`, `run:chat:<id>`. */
        chat: z.boolean(),
        // ── the state block, above the columns: each only when it applies ──
        /** Waiting on you: its question, the answers its agent offered, where to answer. */
        ask: z
          .strictObject({ question: z.string(), options: z.array(z.string()), hint: z.string() })
          .optional(),
        /** Running now: `● Now · 4 min so far · subagent`, the agent's last words, a dim note. */
        now: z.strictObject({ head: z.string(), words: z.string(), note: z.string() }).optional(),
        /**
         * It sent the run back: `↩ back to build` in the loop's hue, then its words (`loop review →
         * build`, `review.findings > 0`, `round 1 of max 2`, `carries review.findings`).
         */
        loop: z.strictObject({ head: z.string(), words: z.array(z.string()) }).optional(),
        /** It was sent back: `Sent back with · from review · round 1`, then what was carried. */
        carried: z.strictObject({ head: z.string(), items: z.array(z.string()) }).optional(),
        /** What it did, in plain words; empty for none. */
        did: z.string(),
        /** Its Step summary is not in yet: `did` is a quiet placeholder. */
        pending: z.boolean(),
        /** One click each: Review changes, Open PR #57, Playbook, Spec, Answer in Chat. */
        actions: z.array(z.strictObject({ id: d.nodeId, label: z.string(), primary: z.boolean() })),
        /** What the step read, on the left (narrow: above `made`). */
        read: column,
        /** What it made, on the right (narrow: under `read`). */
        made: column,
        /** Folded under the columns. */
        details: z.array(
          z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('commands'), ...head, rows: z.array(command) }),
            /** Each path's click `run:scratch:<step>:<n>` opens it in the Editor. */
            z.strictObject({
              kind: z.literal('paths'),
              ...head,
              rows: z.array(z.strictObject({ id: d.nodeId, path: z.string() })),
            }),
            z.strictObject({ kind: z.literal('skills'), ...head, names: z.array(z.string()) }),
          ]),
        ),
      }),
    }),
    z.strictObject({
      kind: z.literal('RunSpecPane'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        /** `Spec #41 on GitHub ↗`; the page's click is `run:spec:page`. */
        head: z.string(),
        title: z.string(),
        /** `Spec · issue #41 · from AB#2`. */
        meta: z.string(),
        /** Markdown, the shell's renderer; the criteria section is drawn from `criteria`. */
        body: z.string(),
        criteria: z.array(criterion),
        /** It has a page to open. */
        page: z.boolean(),
      }),
    }),
  ] as const;
};

type Schemas = ReturnType<typeof runSchemas>;
export type RunNode = z.infer<Schemas[number]>;
export type RunBar = z.infer<Schemas[0]>;
export type RunSteps = z.infer<Schemas[1]>;
export type RunStepRow = RunSteps['props']['rows'][number];
export type RunFocus = z.infer<Schemas[2]>;
export type RunDetail = RunFocus['props']['details'][number];
export type RunColumn = RunFocus['props']['read'];
export type RunBlock = RunColumn['blocks'][number];
export type RunPart = RunBlock['parts'][number];
export type RunLaneCard = Extract<RunPart, { kind: 'lanes' }>['lanes'][number]['cards'][number];
export type RunSpecPane = z.infer<Schemas[3]>;
export type RunKitFeature = Extract<RunPart, { kind: 'kit' }>['features'][number];
export type RunKitPart = RunKitFeature['parts'][number];
