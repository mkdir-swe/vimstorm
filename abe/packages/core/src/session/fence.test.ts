import { describe, expect, test } from 'bun:test';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenceAnswer, sessionFence } from './fence';

const FENCE = sessionFence({
  worktree: '/home/kim/src/shop-wt/4-checkout',
  checkout: '/home/kim/src/shop',
  home: '/home/kim',
  base: '/home/kim/src/shop-wt/4-checkout-base',
});

/** A PreToolUse as Claude Code sends it, in the session's worktree. */
const pre = (tool: string, input: Record<string, unknown>, cwd = FENCE.worktree) => ({
  session_id: 'c1',
  cwd,
  permission_mode: 'auto',
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: input,
});

/** No links: every path is its own real path. */
const asWritten = (path: string) => path;

const answer = (payload: unknown, realpath = asWritten) =>
  fenceAnswer(payload, FENCE, { realpath });

const reason = (payload: unknown) => answer(payload)?.hookSpecificOutput.permissionDecisionReason;

describe("fenceAnswer: Claude's file tools write only where the session's shell does (#181)", () => {
  test.each([
    ['Write', { file_path: '/home/kim/src/shop-wt/4-checkout/src/cart.ts', content: 'x' }],
    ['Edit', { file_path: '/home/kim/src/shop-wt/4-checkout/README.md', old_string: 'a' }],
    ['MultiEdit', { file_path: '/home/kim/src/shop-wt/4-checkout/a.ts', edits: [] }],
    ['NotebookEdit', { notebook_path: '/home/kim/src/shop-wt/4-checkout/n.ipynb' }],
    // A writer's worktree (`isolation: worktree`), and a path relative to the cwd.
    ['Write', { file_path: '/home/kim/src/shop/.claude/worktrees/agent-1/src/a.ts' }],
    ['Write', { file_path: 'src/new.ts' }],
    // The package caches the sandbox writes, and Claude Code's own plan files.
    ['Write', { file_path: '/home/kim/.npm/_cacache/x' }],
    ['Write', { file_path: '/home/kim/.claude/plans/plan.md' }],
    // Its card's Before worktree (#182: Run there).
    ['Write', { file_path: '/home/kim/src/shop-wt/4-checkout-base/src/cart.ts' }],
  ])('%s %j: inside, nothing said (the usual rules decide)', (tool, input) => {
    expect(answer(pre(tool, input))).toBeUndefined();
  });

  test.each([
    ['Write', { file_path: '/home/kim/Desktop/probe.txt', content: 'x' }],
    ['Edit', { file_path: '/home/kim/src/shop/src/cart.ts' }],
    ['MultiEdit', { file_path: '/etc/hosts' }],
    ['NotebookEdit', { notebook_path: '/home/kim/notes/n.ipynb' }],
    // Climbing out of the worktree, a home's `~`, a folder that only starts like the worktree.
    ['Write', { file_path: '../../../Desktop/x.txt' }],
    ['Write', { file_path: '~/Desktop/x.txt' }],
    ['Write', { file_path: '/home/kim/src/shop-wt/4-checkout-old/x.ts' }],
    ['Write', { file_path: '/home/kim/.claude/settings.json' }],
    // Caches that are not a package manager's: run later outside the sandbox, or other chats'.
    ['Write', { file_path: '/home/kim/.cache/vimstorm/luac/init.luac' }],
    ['Write', { file_path: '/home/kim/.cache/abe/retro-chats/r1/notes.md' }],
    ['Write', { file_path: '/home/kim/Library/Caches/com.example.app/x' }],
    ['Write', { file_path: '/home/kim/.vscode/extensions/x/index.js' }],
    // NotebookEdit is decided on its notebook, never a decoy file_path beside it.
    [
      'NotebookEdit',
      {
        file_path: '/home/kim/src/shop-wt/4-checkout/n.ipynb',
        notebook_path: '/home/kim/n.ipynb',
      },
    ],
  ])('%s %j: outside, refused, whatever the permission mode', (tool, input) => {
    const said = reason(pre(tool, input));

    expect(answer(pre(tool, input))?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(said).toContain(`${tool} refused`);
    expect(said).toContain("outside this session's worktree (/home/kim/src/shop-wt/4-checkout)");
  });

  test('the refusal names the path as written, and says what to do instead', () => {
    expect(reason(pre('Write', { file_path: '/home/kim/Desktop/probe.txt' }))).toBe(
      "Write refused: outside this session's worktree (/home/kim/src/shop-wt/4-checkout), the only place its tools write: /home/kim/Desktop/probe.txt. Write inside the worktree, or tell the person what to change there.",
    );
  });

  test('a link in the worktree to a file outside it: refused by where it leads', () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'abe-fence-')));
    const worktree = join(top, 'wt');
    const outside = join(top, 'Desktop');

    try {
      mkdirSync(worktree);
      mkdirSync(outside);
      symlinkSync(outside, join(worktree, 'out'));
      const fence = sessionFence({ worktree, checkout: join(top, 'repo'), home: top });
      const at = (file: string) =>
        fenceAnswer(pre('Write', { file_path: file }, worktree), fence, {
          realpath: realpathSync,
        });

      expect(at(join(worktree, 'out', 'x.txt'))?.hookSpecificOutput.permissionDecisionReason).toBe(
        `Write refused: outside this session's worktree (${worktree}), the only place its tools write: ${join(worktree, 'out', 'x.txt')} is a link to ${join(outside, 'x.txt')}. Write inside the worktree, or tell the person what to change there.`,
      );
      expect(at(join(worktree, 'src', 'new.ts'))).toBeUndefined();
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test.each([
    // A link to a file not there yet, absolute or relative, and a link to such a link.
    ['out', (top: string) => join(top, 'Desktop', 'new.txt'), 'out'],
    ['rel', () => '../Desktop/new.txt', 'rel'],
    ['hop', (top: string) => join(top, 'wt', 'out2'), 'hop'],
  ])(
    'a link %s in the worktree to a path not there yet: refused by where it leads (#181)',
    (name, target, written) => {
      const top = realpathSync(mkdtempSync(join(tmpdir(), 'abe-fence-')));
      const worktree = join(top, 'wt');

      try {
        mkdirSync(worktree);
        mkdirSync(join(top, 'Desktop'));
        symlinkSync(join(top, 'Desktop', 'new.txt'), join(worktree, 'out2'));
        symlinkSync(target(top), join(worktree, name));
        const fence = sessionFence({ worktree, checkout: join(top, 'repo'), home: top });
        const said = fenceAnswer(
          pre('Write', { file_path: join(worktree, written) }, worktree),
          fence,
          {
            realpath: realpathSync,
            readlink: readlinkSync,
          },
        )?.hookSpecificOutput.permissionDecisionReason;

        expect(said).toContain(
          `${join(worktree, written)} is a link to ${join(top, 'Desktop', 'new.txt')}`,
        );
      } finally {
        rmSync(top, { recursive: true, force: true });
      }
    },
  );

  test('a link in the worktree to a file in it not there yet: written as usual', () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'abe-fence-')));
    const worktree = join(top, 'wt');

    try {
      mkdirSync(worktree);
      symlinkSync('src/later.ts', join(worktree, 'later'));
      const fence = sessionFence({ worktree, checkout: join(top, 'repo'), home: top });

      expect(
        fenceAnswer(pre('Write', { file_path: join(worktree, 'later') }, worktree), fence, {
          realpath: realpathSync,
          readlink: readlinkSync,
        }),
      ).toBeUndefined();
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test.each([
    // The worktree's `.git` file names the repository git runs in (serve's own git too).
    '/home/kim/src/shop-wt/4-checkout/.git',
    '.git',
    '/home/kim/src/shop-wt/4-checkout/.GIT',
    '/home/kim/src/shop-wt/4-checkout/vendor/lib/.git',
    '/home/kim/src/shop-wt/4-checkout/vendor/lib/.git/config',
    '/home/kim/src/shop/.claude/worktrees/agent-1/.git',
  ])("%s: git's own, refused even inside the worktree (#181)", (file) => {
    expect(reason(pre('Write', { file_path: file }))).toMatch(
      /^Write refused: .*\.git is git's own \(where the repository and its hooks are\), which this session's tools never write\.$/i,
    );
  });

  test.each([
    // Claude Code's sandbox's TMPDIR: its shell writes there too.
    ['/tmp/claude/probe.sh', undefined],
    ['/private/tmp/claude/x/y.txt', undefined],
    ['/private/tmp/claude-501/x.txt', 'refused'],
    ['/tmp/other.txt', 'refused'],
  ])('%s: the sandbox TMPDIR only', (file, refused) => {
    const said = reason(pre('Write', { file_path: file }));

    if (refused === undefined) expect(said).toBeUndefined();
    else expect(said).toContain('Write refused');
  });

  test('while its worktree is not known yet, only the other places count (never every path)', () => {
    const starting = sessionFence({
      worktree: '',
      checkout: '/home/kim/src/shop',
      home: '/home/kim',
    });

    expect(
      fenceAnswer(pre('Write', { file_path: '/home/kim/Desktop/x' }), starting, {
        realpath: asWritten,
      }),
    ).toBeDefined();
  });

  test.each([
    '/home/kim/src/shop-wt/4-checkout/.claude/settings.json',
    '/home/kim/src/shop-wt/4-checkout/.claude/settings.local.json',
    // macOS's file system ignores case: Claude Code reads these as its settings too.
    '/home/kim/src/shop-wt/4-checkout/.Claude/Settings.json',
    '/home/kim/src/shop-wt/4-checkout/web/.CLAUDE/SETTINGS.LOCAL.JSON',
    // A skill's, agent's or command's frontmatter hooks run outside the sandbox; so do the
    // project's hook scripts; and its MCP servers.
    '/home/kim/src/shop-wt/4-checkout/.claude/skills/x/SKILL.md',
    '/home/kim/src/shop-wt/4-checkout/web/.claude/agents/a.md',
    '/home/kim/src/shop-wt/4-checkout/.claude/commands/c.md',
    '/home/kim/src/shop-wt/4-checkout/.claude/hooks/check.sh',
    '/home/kim/src/shop-wt/4-checkout/.mcp.json',
    '/home/kim/src/shop-wt/4-checkout-base/.claude/skills/x/SKILL.md',
    '/home/kim/src/shop/.claude/worktrees/agent-1/.claude/skills/x/SKILL.md',
  ])(
    "%s: Claude Code's own config for the project, refused inside the worktree too (#181)",
    (file) => {
      expect(reason(pre('Edit', { file_path: file }))).toMatch(
        /^Edit refused: .* is Claude Code's own config for this project \(its settings, hooks, skills, agents, commands, MCP servers\), which this session's tools never write/,
      );
    },
  );

  test('a file in the worktree hard linked elsewhere: refused, the write would land in both (#181)', () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'abe-fence-')));
    const worktree = join(top, 'wt');

    try {
      mkdirSync(worktree);
      writeFileSync(join(top, 'zshrc'), 'x');
      linkSync(join(top, 'zshrc'), join(worktree, 'rc'));
      writeFileSync(join(worktree, 'own.ts'), 'x');
      const fence = sessionFence({ worktree, checkout: join(top, 'repo'), home: top });
      const at = (file: string) =>
        fenceAnswer(pre('Edit', { file_path: file }, worktree), fence, {
          realpath: realpathSync,
          hardLinks: (path) => {
            const s = statSync(path, { throwIfNoEntry: false });

            return s?.isFile() === true ? s.nlink : undefined;
          },
        })?.hookSpecificOutput.permissionDecisionReason;

      expect(at(join(worktree, 'rc'))).toBe(
        `Edit refused: ${join(worktree, 'rc')} is a hard link (2 names), so the write would land outside this session's worktree too. Write a new file instead.`,
      );
      expect(at(join(worktree, 'own.ts'))).toBeUndefined();
      expect(at(join(worktree, 'new.ts'))).toBeUndefined();
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("a skill nested in the worktree's folders (moved in past the sandbox): refused; any other skill: not the fence's (#181)", () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'abe-fence-')));
    const worktree = join(top, 'wt');

    try {
      mkdirSync(join(worktree, 'web', '.claude', 'skills', 'deploy'), { recursive: true });
      mkdirSync(join(worktree, 'packages', 'app', '.claude', 'skills', 'lint'), {
        recursive: true,
      });
      const fence = sessionFence({ worktree, checkout: join(top, 'repo'), home: top });
      const skill = (name: string) =>
        fenceAnswer(pre('Skill', { skill: name }, worktree), fence, {
          realpath: realpathSync,
        })?.hookSpecificOutput.permissionDecisionReason;

      expect(skill('web:deploy')).toBe(
        `Skill refused: web:deploy is a skill in ${join(worktree, 'web', '.claude', 'skills', 'deploy')}, inside this session's worktree, where its hooks would run outside the sandbox. Tell the person about it instead.`,
      );
      expect(skill('packages/app:lint')).toContain('Skill refused');
      // A plugin's, a personal or the project's own skill.
      expect(skill('abe-core:factory')).toBeUndefined();
      expect(skill('../../x:y')).toBeUndefined();
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("a nested skill offered by its bare name (#213): found in the folders and refused; the project's own, a personal or a built-in one: not the fence's", () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'abe-fence-')));
    const worktree = join(top, 'wt');
    const moved = join(top, 'claude-tmp', 'web');

    try {
      // a folder from /tmp/claude, its .claude/skills inside, linked in as web/
      mkdirSync(join(moved, '.claude', 'skills', 'deploy'), { recursive: true });
      mkdirSync(join(worktree, 'src', 'deep', 'er', '.claude', 'skills', 'lint'), {
        recursive: true,
      });
      mkdirSync(join(worktree, '.claude', 'skills', 'own'), { recursive: true });
      mkdirSync(join(top, '.claude', 'skills', 'mine'), { recursive: true });
      symlinkSync(moved, join(worktree, 'web'));
      // a link out of the tree: looked into, not walked below
      mkdirSync(join(top, 'elsewhere', 'a', '.claude', 'skills', 'far'), { recursive: true });
      symlinkSync(join(top, 'elsewhere'), join(worktree, 'out'));
      // build output: not walked
      mkdirSync(join(worktree, 'target', 'x', '.claude', 'skills', 'built'), { recursive: true });
      const fence = sessionFence({ worktree, checkout: join(top, 'repo'), home: top });
      const cuts: string[] = [];
      const skill = (name: string) =>
        fenceAnswer(pre('Skill', { skill: name }, worktree), fence, {
          realpath: realpathSync,
          dirs: (path) =>
            readdirSync(path, { withFileTypes: true })
              .filter((d) => d.isDirectory() || d.isSymbolicLink())
              .map((d) => ({ name: d.name, link: d.isSymbolicLink() })),
          cut: (_, n) => cuts.push(n),
        })?.hookSpecificOutput.permissionDecisionReason;

      expect(skill('deploy')).toBe(
        `Skill refused: deploy is a skill in ${join(worktree, 'web', '.claude', 'skills', 'deploy')}, inside this session's worktree, where its hooks would run outside the sandbox. Tell the person about it instead.`,
      );
      expect(skill('lint')).toContain('Skill refused');
      // the project's own top-level skill, a personal one, a built-in (no folder anywhere)
      expect(skill('own')).toBeUndefined();
      expect(skill('mine')).toBeUndefined();
      expect(skill('simplify')).toBeUndefined();
      expect(skill('far')).toBeUndefined();
      expect(skill('built')).toBeUndefined();
      expect(cuts).toEqual([]);
      // past the depth cap: let by, and said
      mkdirSync(join(worktree, 'a', 'b', 'c', 'd', 'e', 'f', 'g', '.claude', 'skills', 'deepest'), {
        recursive: true,
      });
      expect(skill('deepest')).toBeUndefined();
      expect(cuts).toEqual(['deepest']);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test('a file tool whose path cannot be read: refused', () => {
    expect(reason(pre('Write', { content: 'x' }))).toContain('its path could not be read');
  });
});

describe('fenceAnswer: WebFetch reaches any host, a URL read plainly (ADR 0029)', () => {
  test.each([
    'https://github.com/octo/shop/blob/main/README.md',
    'https://api.github.com/repos/octo/shop',
    'https://registry.npmjs.org/zod',
    'https://www.npmjs.org/package/zod',
  ])('%s: on the list, nothing said', (url) => {
    expect(answer(pre('WebFetch', { url, prompt: 'read it' }))).toBeUndefined();
  });

  // the network is open (ADR 0029): the jail holds secrets and files, not hosts
  test.each([
    'https://example.com/',
    'https://www.wikipedia.org/wiki/X',
    'https://github.com@example.com/',
    'https://api.vendor.io/',
  ])('%s: any host reached', (url) => {
    expect(answer(pre('WebFetch', { url }))).toBeUndefined();
  });

  test.each(['not a url', 'file:///etc/hosts', 'https://%67ithub.com/', 'https:///x'])(
    '%s: a URL that does not read plainly is refused',
    (url) => {
      expect(reason(pre('WebFetch', { url }))).toContain('could not be read');
    },
  );
});

describe('fenceAnswer: everything else is not its to answer', () => {
  test.each([
    ['Bash', { command: 'curl https://example.com' }],
    ['Read', { file_path: '/etc/hosts' }],
    ['AskUserQuestion', { questions: [] }],
  ])('%s: nothing said (the sandbox and the deny rules hold those)', (tool, input) => {
    expect(answer(pre(tool, input))).toBeUndefined();
  });

  test('not a PreToolUse payload: nothing said', () => {
    expect(answer('not json')).toBeUndefined();
    expect(answer({ tool_name: 7 })).toBeUndefined();
  });
});
