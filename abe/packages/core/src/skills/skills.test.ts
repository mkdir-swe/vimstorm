import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { type ArgsSpec, flagName, GLOBAL_FLAGS } from '../command';
import { COMMANDS, isCommandId, type CommandId } from '../contract/commands';
import { STAGES } from '../factory/factory';
import {
  CORE_HUB_SKILLS,
  CORE_SKILLS,
  FACTORY_SKILL,
  HUB_INVOKED_SKILLS,
  INSTALL_SKILLS,
} from './skills';
import { VENDORED_SKILLS } from '../shipped';
import { BUILT_IN_SKILL_FILES, BUILT_IN_SKILLS } from './workflow';

const SKILLS_DIR = join(import.meta.dir, '..', '..', 'skills');

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

/** Claude Code's rules for a skill's name and description (and the Agent Skills format's). */
const Frontmatter = z.object({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  description: z.string().min(20).max(1024),
  metadata: z.object({ upstream: z.string() }).optional(),
});

const frontmatter = (text: string): unknown => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);

  return m?.[1] === undefined ? undefined : Bun.YAML.parse(m[1]);
};

/** A one-shot's system prompt beside a skill (`triage`, `improve`, `retro`): core runs it itself. */
const isOneShot = (path: string) => path.endsWith('/one-shot.md');

/** The install's parts, in hint order (#71's contract v2): `sources` the one not required. */
const INSTALL_PARTS = [
  'logins',
  'board',
  'sources',
  'env-files',
  'worktree',
  'checks',
  'workflows',
  'skills',
  'verify',
  'prototype',
  'done',
] as const;

/** A vendored skill's `metadata.upstream`: `<owner/repo>@<commit> <path> (<hand edits>)`. */
const skillUpstream = (text: string) => {
  const note = Frontmatter.safeParse(frontmatter(text)).data?.metadata?.upstream ?? '';
  const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{7,40}) (\S+)/.exec(note);

  return m === null ? null : { repo: m[1] ?? '', commit: m[2] ?? '', path: m[3] ?? '' };
};

const skills = CORE_SKILLS.filter((f) => f.path.endsWith('/SKILL.md')).map((f) => ({
  ...f,
  folder: f.path.split('/')[1] ?? '',
}));

/** Every `abe …` a text names: inline code starting with `abe `, and code lines starting so. */
const mentions = (text: string): string[] => [
  ...[...text.matchAll(/`(abe [^`\n]+)`/g)].map((m) => m[1] ?? ''),
  ...[...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) =>
    (m[1] ?? '').split('\n').filter((line) => line.startsWith('abe ')),
  ),
];

/** The command row a mention names: `noun verb sub` or `noun verb` when that is one, else the bare noun. */
const commandOf = (mention: string): string => {
  const [, noun = '', verb = '', sub = ''] =
    /^abe ([a-z]+)(?: ([a-z][a-z-]*))?(?: ([a-z][a-z-]*))?/.exec(mention) ?? [];

  if (isCommandId(`${noun} ${verb} ${sub}`)) return `${noun} ${verb} ${sub}`;

  return isCommandId(`${noun} ${verb}`) ? `${noun} ${verb}` : noun;
};

/** A command group named alone in prose (`abe factory`): some row has that noun. */
const isGroup = (mention: string) =>
  /^abe [a-z]+$/.test(mention) &&
  Object.values(COMMANDS).some((c) => c.noun === mention.slice('abe '.length));

const flagsOf = (id: CommandId): Set<string> => {
  const args: ArgsSpec = { ...COMMANDS[id].args, ...GLOBAL_FLAGS };

  return new Set(
    Object.entries(args)
      .filter(([, arg]) => arg.kind === 'flag')
      .map(([key]) => flagName(key)),
  );
};

describe('core skills', () => {
  test('every file of the skills folder ships in the plugin, at its path there', () => {
    const onDisk = filesUnder(SKILLS_DIR)
      .map((p) => `skills/${relative(SKILLS_DIR, p)}`)
      .filter((p) => !isOneShot(p));

    expect([...CORE_SKILLS, ...CORE_HUB_SKILLS].map((f) => f.path).sort()).toEqual(onDisk.sort());
  });

  test("the built-in Layer's skill files are every file of BUILT_IN_SKILLS' folders", () => {
    const onDisk = filesUnder(SKILLS_DIR)
      .map((p) => `skills/${relative(SKILLS_DIR, p)}`)
      .filter((p) => BUILT_IN_SKILLS.some((name) => p.startsWith(`skills/${name}/`)));

    expect(BUILT_IN_SKILL_FILES.map((f) => f.path).sort()).toEqual(onDisk.sort());
    expect([...new Set(BUILT_IN_SKILL_FILES.map((f) => f.path.split('/')[1]))].sort()).toEqual(
      [...BUILT_IN_SKILLS].sort(),
    );
  });

  test('the Factory skills, the factory skill first among them', () => {
    expect(skills.map((s) => s.folder)).toEqual([
      FACTORY_SKILL,
      'create-specification',
      'to-tickets',
      'reproduce',
      'investigate',
      'implement',
      'tdd',
      'code-review',
      'verify',
      'pr',
      'playbook',
      'prototype',
      // vendored from mattpocock/skills
      'wayfinder',
      'implement-spec',
      'codebase-design',
      'diagnosing-bugs',
      'domain-modeling',
      'grilling',
      'research',
      'wizard',
      'improve-codebase-architecture',
      'handoff',
      'to-questionnaire',
      'writing-for-agents',
      'wait-what',
      // vendored from pstack
      'create-verification-skill',
      'maintain-verification-skill',
      'technical-writing',
      'unslop',
      'why',
      'how',
      'typescript-best-practices',
      // the principles
      'principle-attack-the-premise',
      'principle-boundary-discipline',
      'principle-encode-lessons-in-structure',
      'principle-fix-root-causes',
      'principle-foundational-thinking',
      'principle-laziness-protocol',
      'principle-make-operations-idempotent',
      'principle-migrate-callers-then-delete-legacy-apis',
      'principle-minimize-reader-load',
      'principle-model-the-domain',
      'principle-prove-it-works',
      'principle-sequence-verifiable-units',
      'principle-subtract-before-you-add',
      'principle-test-behavior-not-implementation',
      'principle-type-system-discipline',
    ]);
  });

  test.each(VENDORED_SKILLS.map((name) => [name]))(
    '%s names the upstream repo, commit and folder it was copied from',
    (name) => {
      const s = skills.find((k) => k.folder === name);

      const up = skillUpstream(s?.text ?? '');

      expect([up?.repo, up?.commit]).toBeOneOf([
        ['mattpocock/skills', '59db609'],
        ['cursor/plugins', '9f844cd'],
      ]);
      expect(up?.path.split('/').at(-1)).toBe(name);
    },
  );

  test("both upstreams' MIT notices ship with the skills, one for every repo a skill names", () => {
    const notices = CORE_SKILLS.find((f) => f.path === 'skills/THIRD-PARTY-NOTICES.md')?.text ?? '';
    const repos = new Set(skills.flatMap((s) => skillUpstream(s.text)?.repo ?? []));

    expect([...repos].sort()).toEqual(['cursor/plugins', 'mattpocock/skills']);
    for (const repo of repos) expect(notices).toContain(`## ${repo}`);
    expect(notices.match(/^MIT License$/gm)).toHaveLength(2);
    expect(notices).toContain('Copyright (c) 2026 Matt Pocock');
    expect(notices).toContain('Copyright (c) 2026 Lauren Tan');
  });

  test('the person starts the routers, handoff and the multi-session flows; Abe may run every other skill', () => {
    const personOnly = skills
      .filter((s) => /^disable-model-invocation: true$/m.test(s.text.split('\n---\n')[0] ?? ''))
      .map((s) => s.folder);

    expect(personOnly.sort()).toEqual([
      'handoff',
      'implement-spec',
      'improve-codebase-architecture',
      'wait-what',
      'wayfinder',
    ]);
  });

  test.each(
    [
      ...skills,
      ...CORE_HUB_SKILLS.filter((f) => f.path.endsWith('/SKILL.md')).map((f) => ({
        ...f,
        folder: f.path.split('/')[1] ?? '',
      })),
    ].map((s) => [s.folder, s] as const),
  )('%s parses: frontmatter with its folder as name and a description', (folder, s) => {
    const meta = Frontmatter.parse(frontmatter(s.text));

    expect(meta.name).toBe(folder);
    expect(s.text.slice(s.text.indexOf('\n---\n') + 5).trim()).not.toBe('');
  });

  test("the factory skill is a Factory run's alone: never loaded for a plain session on a card (#186)", () => {
    const s = skills.find((k) => k.folder === FACTORY_SKILL);
    const { description } = Frontmatter.parse(frontmatter(s?.text ?? ''));

    expect(description).not.toContain('when a session starts on a card');
    expect(description).toContain('Use only in a run');
    expect(description).toContain('never in a plain session on a card');
  });

  test.each(['implement', 'tdd', 'create-specification', 'to-tickets', 'code-review', 'pr'])(
    '%s names the upstream commit it is based on',
    (folder) => {
      const s = skills.find((k) => k.folder === folder);
      const meta = Frontmatter.parse(frontmatter(s?.text ?? ''));

      expect(meta.metadata?.upstream).toMatch(/^mattpocock\/skills@[0-9a-f]{7,40} skills\//);
    },
  );

  test("every abe command a skill names is a row of the command table, run from inside a session (the Abe chat's skills any)", () => {
    const named = [...CORE_SKILLS, ...CORE_HUB_SKILLS].flatMap((f) =>
      mentions(f.text).map((m) => ({ file: f.path, m })),
    );

    expect(named.length).toBeGreaterThan(10);
    for (const { file, m } of named.filter((n) => !isGroup(n.m))) {
      const id = commandOf(m);

      expect({ file, m, known: isCommandId(id) }).toEqual({ file, m, known: true });
      if (!isCommandId(id)) continue;
      // the Abe chat runs every abe command as the person: its skills may name any (the
      // prototype skill's first part is the Abe chat's: it starts the prototype session)
      if (!CORE_HUB_SKILLS.some((f) => f.path === file) && !file.startsWith('skills/prototype/'))
        expect({ file, m, inSession: COMMANDS[id].inSession }).toEqual({
          file,
          m,
          inSession: true,
        });
      const flags = flagsOf(id);
      const unknown = [...m.matchAll(/--([a-z][a-z-]*)/g)]
        .map((f) => f[1] ?? '')
        .filter((f) => !flags.has(f));

      expect({ file, m, unknown }).toEqual({ file, m, unknown: [] });
    }
  });

  test('the prototype skill reads `abe prototype list --json` where its data has the list', () => {
    const text = CORE_SKILLS.find((f) => f.path === 'skills/prototype/PROTOCOL.md')?.text ?? '';
    const key = /`abe prototype list --json` \(the list is `\.data\.([a-z]+)`/.exec(text)?.[1];
    const result = COMMANDS['prototype list'].result;

    expect(key).toBeDefined();
    expect(result.safeParse({ [key ?? '']: [] }).success).toBe(true);
    // what a jq of `.data[]` reads it as: not the list
    expect(result.safeParse([]).success).toBe(false);
  });

  test('the skills you invoke in the Abe chat are the ones its guide names as /abe:<name>, each shipped', () => {
    const guide = CORE_HUB_SKILLS.find((f) => f.path === 'skills/abe/SKILL.md')?.text ?? '';
    const named = new Set([...guide.matchAll(/\/abe:([a-z-]+)/g)].map((m) => m[1] ?? ''));

    named.delete('abe');
    expect([...HUB_INVOKED_SKILLS].sort()).toEqual([...named].sort());
    const shipped = [...CORE_SKILLS, ...CORE_HUB_SKILLS].map((f) => f.path);

    for (const name of HUB_INVOKED_SKILLS) expect(shipped).toContain(`skills/${name}/SKILL.md`);
  });

  test('the factory skill names every stage', () => {
    const text = skills.find((s) => s.folder === FACTORY_SKILL)?.text ?? '';

    for (const stage of STAGES) expect(text).toMatch(new RegExp(`\\b${stage}\\b`));
  });

  test.each<[string, string[]]>([
    ['spec', ['create-specification']],
    ['reproduce', ['reproduce']],
    ['build', ['implement', 'tdd']],
    ['review', ['code-review']],
    ['verify', ['verify']],
    ['pr', ['pr', 'technical-writing']],
    ['step', ['playbook', 'investigate']],
  ])("the factory skill's step table: %s uses %p", (stage, named) => {
    const text = skills.find((s) => s.folder === FACTORY_SKILL)?.text ?? '';
    const row = text.split('\n').find((l) => l.startsWith(`| ${stage} `)) ?? '';
    const does = row.split('|')[2] ?? '';

    for (const skill of named) {
      expect({ stage, skill, core: skills.some((s) => s.folder === skill) }).toEqual({
        stage,
        skill,
        core: true,
      });
      expect({ stage, does, names: new RegExp(`\\b${skill}\\b`).test(does) }).toEqual({
        stage,
        does,
        names: true,
      });
    }
  });

  // what the factory skill tells the coordinator, one rule a row (the session follows the words)
  test.each<[string, string]>([
    ['unslop on every text a run writes', 'runs that text through the unslop skill'],
    ['principles by their triggers', 'principles load by their triggers'],
    ['each step in a subagent', "each step's work runs in a subagent of its own"],
    [
      'the main session orchestrates',
      'hands the step its brief, gets a short report back and records it',
    ],
    ['a fresh step gets only what status says', "Never earlier steps' reports, your notes"],
    ['a gate is one call seeing only what it sees', 'Make **one** call'],
    ['the spec asks through the main session', 'A subagent never asks'],
    ['build is coordinated, never one subagent', 'build is never handed to one subagent whole'],
    ["a step agents may not run is the person's", 'Never run a `Who: you` step'],
    [
      "to-questionnaire for a decision that is someone else's",
      'write it with the to-questionnaire skill',
    ],
    ['handoff only when asked', 'The handoff skill runs only when the person asks for a handoff'],
    ['skills never commit', 'no skill commits on its own'],
  ])('the factory skill says %s', (_, phrase) => {
    expect(skills.find((s) => s.folder === FACTORY_SKILL)?.text).toContain(phrase);
  });

  test("the playbook skill: one agent, the person's steps never run, the coordinator commits", () => {
    const text = skills.find((s) => s.folder === 'playbook')?.text ?? '';

    expect(text).toContain('Start no subagents');
    expect(text).toContain('.abe/playbooks/<card>.md');
    expect(text).toContain('Never run a `Who: you` step');
    expect(text).toContain('Commit nothing');
  });

  test('create-specification: found out first and cited, then asked (Needs you when away), then specced', () => {
    const text = skills.find((s) => s.folder === 'create-specification')?.text ?? '';
    const abe = CORE_SKILLS.find((f) => f.path === 'skills/create-specification/PROTOCOL.md')?.text;

    expect(text).toContain('## 2. Find out first');
    expect(text).toContain('**citation**');
    expect(abe).toContain('abe factory needs-you --reason');
    expect(text).toContain('AskUserQuestion');
    expect(text).toContain('## Open for the product owner');
    expect(abe).toContain(
      'abe factory stage-done create-specification --report .scratch/<card>/spec.md',
    );
  });

  test("Factory install: the install skill's parts table names each part, with its reference in the plugin", () => {
    const text = INSTALL_SKILLS.find((f) => f.path === 'skills/install/SKILL.md')?.text ?? '';
    const rows = [...text.matchAll(/^\| `([a-z-]+)` +\|.*\]\((references\/[a-z-]+\.md)\)/gm)];

    expect(rows.map((r) => r[1])).toEqual([...INSTALL_PARTS]);
    for (const [, part, ref] of rows)
      expect({
        part,
        ref,
        shipped: INSTALL_SKILLS.some((f) => f.path === `skills/install/${ref}`),
      }).toEqual({
        part,
        ref,
        shipped: true,
      });
  });

  test('links between skill files resolve inside the plugin', () => {
    for (const plugin of [CORE_SKILLS, INSTALL_SKILLS])
      for (const f of plugin)
        // a `<placeholder>` target is a shape to write, not a file of the plugin
        for (const [, target = ''] of f.text.matchAll(/\]\(([^)#:<]+\.md)\)/g))
          expect(plugin.map((g) => g.path)).toContain(join(dirname(f.path), target));
  });

  test('create-specification, implement, verify and pr say how to use a prototype reference (#351)', () => {
    const text = (folder: string) => skills.find((s) => s.folder === folder)?.text ?? '';

    for (const folder of ['create-specification', 'implement', 'verify', 'pr']) {
      expect({ folder, says: text(folder).includes('**prototype reference**') }).toEqual({
        folder,
        says: true,
      });
      expect({ folder, path: text(folder).includes('.scratch/<card>/prototype/') }).toEqual({
        folder,
        path: true,
      });
    }
    expect(text('create-specification')).toContain('`## Prototype` section');
    expect(text('implement')).toContain('never paste');
    expect(text('verify')).toContain('differs on purpose');
    expect(text('pr')).toContain('Built from Prototype v<n>');
  });
});

// the rules the install skill carries, one row each (the session follows them, so the words matter)
describe('the install skill says', () => {
  test.each<[string, string]>([
    ['SKILL.md', '**The goal**: every required part passes. `abe install check --all`'],
    [
      'SKILL.md',
      'Whatever the person asks, you do yourself: add an MCP server and start its sign-in',
    ],
    ['SKILL.md', 'Write both as ordinary changes: never commit them and never exclude them'],
    ['SKILL.md', "**`.abe/`** is the person's alone, always kept out of git"],
    ['SKILL.md', '**Read in a subagent.**'],
    ['SKILL.md', 'started in the background as soon as the app runs locally'],
    ['SKILL.md', 'A subagent never asks the person'],
    ['SKILL.md', "**Pick the order yourself.** The table's order is the default"],
    ['SKILL.md', '**After each part, check it**: `abe install check <part>`'],
    ['SKILL.md', '**Come back to any part**'],
    ['SKILL.md', '**The up-front round.**'],
    ['SKILL.md', '**Preselect from evidence.**'],
    ['SKILL.md', '**Every question offers "Not sure: find out".**'],
    ['SKILL.md', "search the team's sources read-only"],
    ['SKILL.md', '**After the round, one question at a time**'],
    ['SKILL.md', 'prefixed with `!` so they run it in this chat'],
    ['SKILL.md', 'only after a confirm question that says so'],
    ['SKILL.md', 'then run `abe settings set agents.prod true`'],
    ['SKILL.md', 'When the status says `join: true`'],
    ['SKILL.md', 'A team part that fails (the board, a check, the pack) is a warning'],
    ['SKILL.md', '**Key names only.**'],
    ['SKILL.md', '**Not Done**: `:install` reopens this same chat'],
    ['SKILL.md', '**Done**: `:install` opens a new chat seeded from the status'],
    ['references/read.md', '**Read only this checkout.** Never open a file outside it'],
    ['references/logins.md', 'Until the board is known to be Azure it is `skipped`'],
    ['references/logins.md', '**The aws profiles are an up-front question**'],
    ['references/logins.md', "sets the one that reads it as this checkout's gh account itself"],
    ['references/board.md', '**Where cards run**'],
    ['references/board.md', "A card's run always ends in a pull request"],
    ['references/board.md', '`provider` is `github`, `azure` or `local` only'],
    ['references/board.md', 'preselect **GitHub Issues**'],
    ['references/board.md', "**Where a card's spec goes** (`spec.where`)"],
    [
      'references/board.md',
      'Never offer to keep that board, and never ask the person to switch accounts for it',
    ],
    ['references/board.md', "takes the project's default team (`<project> Team`)"],
    [
      'references/board.md',
      '**A board that refuses the az login (401, 403): check whether the board is the wrong one before any account.**',
    ],
    ['references/board.md', 'means the other board or option you offered, never another account'],
    ['references/board.md', 'only on a **shared board**'],
    ['references/board.md', '`card create --title "<title>"`, after `abe` in Terminal'],
    ['references/sources.md', 'its MCP server goes in `abe.yaml` `sources:`'],
    ['references/sources.md', 'Never run `claude mcp remove`'],
    ['references/env-files.md', '**Never ask for `DATABASE_URL`**'],
    ['references/env-files.md', 'You read and edit these files directly. Key names only'],
    ['references/env-files.md', 'Run steps 1 to 3 in a subagent'],
    ['references/checks.md', '`abe install try --command "<command>"`'],
    ['references/checks.md', '**Fix a failing check in a subagent**'],
    ['references/checks.md', '**The files you write now must agree with each other**'],
    ['references/checks.md', '**Write only what you checked.**'],
    ['references/skills.md', '**Check the files agree.**'],
    ['references/skills.md', 'name no start script (none is written)'],
    ['references/skills.md', '**Session-only words stay out of the files.**'],
    ['references/skills.md', 'a cause you did not confirm is written as unknown'],
    [
      'references/verify.md',
      "Copy this skill's `scripts/ports.sh` to `.claude/skills/run-app/scripts/ports.sh`",
    ],
    ['references/verify.md', "Never give an answer that isn't true to get past the gate"],
    [
      'references/verify.md',
      '**Start it in a background subagent as soon as the app runs locally**',
    ],
    ['references/verify.md', '**Check `verify-<app>` agrees with `abe.yaml`**'],
    [
      'references/verify.md',
      'headless Playwright with its own browser, against the local app only',
    ],
    ['references/verify.md', '**Prove it once, end to end**'],
    ['references/verify.md', 'is not written here unless they said to keep it'],
    [
      'references/verify.md',
      'Run the checks again now the pack is written: `abe install try <name>` for each check',
    ],
    ['references/verify.md', "never take them out of the repo's lint"],
    ['references/done.md', 'Its line names the changed files for the person to commit'],
    ['references/done.md', 'you never commit or push them'],
    ['references/done.md', 'say there is nothing for the Factory to take yet'],
  ])('%s: %s', (file, phrase) => {
    expect(INSTALL_SKILLS.find((f) => f.path === `skills/install/${file}`)?.text).toContain(phrase);
  });
});
