/**
 * The verb table on the commands and outputs of t113a's real session (paths moved under
 * `/work`), and the test runners' other summary forms.
 */
import { describe, expect, test } from 'bun:test';
import { foldTasks, type Step, stepOf, stepText, testCounts } from './steps';
import { type FilePatch } from './transcript';

const ROOT = '/work/demo-shop-wt/2-the-cart-total-ignores-quantity';

const bash = (command: string, result?: { ok?: boolean; text: string }) =>
  stepOf(
    { tool: 'Bash', input: { command, description: 'x' } },
    result === undefined ? null : { ok: result.ok ?? true, text: result.text, patch: null },
    { root: ROOT },
  );

const row = (s: Step) => `${{ ok: '✓', failed: '✗', running: '●' }[s.glyph]} ${stepText(s)}`;

const NODE_FAILING = [
  'ℹ suites 0',
  'ℹ pass 2',
  'ℹ fail 1',
  'ℹ cancelled 0',
  'ℹ skipped 1',
  'ℹ todo 0',
  'ℹ duration_ms 59.261041',
  '',
  '✖ failing tests:',
  '',
  'test at test/cart.test.ts:13:1',
  "✖ cart total counts each line's quantity (0.61ms)",
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
].join('\n');

describe('Bash, read out of its command (the real session)', () => {
  test.each([
    [
      'cat api/src/cart.ts; ls api api/src; cat api/package.json 2>/dev/null; git log --oneline -3',
      { text: 'import { marketFor } from "./markets.ts";\n' },
      '✓ Read api/src/cart.ts',
    ],
    [
      'cd api && cat test/*.test.ts && npm test 2>&1 | tail -30',
      { text: NODE_FAILING },
      "✗ Ran npm test · 1 failed · cart total counts each line's quantity",
    ],
    [
      'grep -rn "quantity" api/src api/test',
      {
        text: [
          'api/src/cart.ts:6:  quantity: number;',
          'api/src/cart.ts:17:    (sum, line) => sum + line.price * line.quantity,',
          'api/test/cart.test.ts:10:  assert.equal(cartTotal({ market: "se", lines: [] }), 125);',
          'api/test/cart.test.ts:13:test("cart total counts each line\'s quantity", () => {',
        ].join('\n'),
      },
      '✓ Searched "quantity" · 2 files',
    ],
    [
      'cd api && npm test 2>&1 | grep -E "^ℹ (pass|fail|skipped)|^✖|AssertionError"',
      {
        text: [
          '✖ a negative quantity throws (0.285625ms)',
          'ℹ pass 4',
          'ℹ fail 1',
          'ℹ skipped 1',
          '✖ failing tests:',
          '✖ a negative quantity throws (0.285625ms)',
          '  AssertionError [ERR_ASSERTION]: Missing expected exception.',
        ].join('\n'),
      },
      '✗ Ran npm test · 1 failed · a negative quantity throws',
    ],
    [
      'npm test 2>&1 | grep -E "^ℹ (pass|fail|skipped)|^✖"',
      { text: 'ℹ pass 5\nℹ fail 0\nℹ skipped 1' },
      '✓ Ran npm test · 5 passed · 1 skipped',
    ],
    [
      "curl -sS -m 10 https://example.com -o /dev/null -w '%{http_code}'",
      {
        ok: false,
        text: [
          'Exit code 56',
          'curl: (56) CONNECT tunnel failed, response 403',
          '000',
          '<sandbox_violations>',
          "deny network-outbound example.com:443 (not in this command's allowed_domains)",
          '</sandbox_violations>',
        ].join('\n'),
      },
      "✗ Ran curl -sS -m 10 https://example.com -o /dev/null -w '%{http_… · sandbox denied example.com:443",
    ],
    [
      'cd .. && git worktree remove /work/demo-shop/.claude/worktrees/agent-ae61a6f2394984d52 && git branch -d worktree-agent-ae61a6f2394984d52',
      {
        ok: false,
        text: "Exit code 255\nerror: failed to delete '/work/demo-shop/.git/worktrees/agent-ae61a6f2394984d52': Operation not permitted",
      },
      "✗ Ran git worktree remove /work/demo-shop/.claude/worktrees/agent… · exit 255 · error: failed to delete '/work/demo-shop/.git/worktrees/agent-ae61a6f2394984d52…",
    ],
    [
      'git commit -qam "NO-TASK Count each cart line\'s quantity in the total." && git log --oneline -1',
      { text: "13ed31b NO-TASK Count each cart line's quantity in the total." },
      '✓ Ran git commit -qam "NO-TASK Count each cart line\'s quantity in…',
    ],
    [
      "git log --oneline -3 && sed -i '' 's/(sum, line) => sum + line.price,/(sum, line) => sum + line.price * line.quantity,/' api/src/cart.ts && git diff && npm test 2>&1 | tail -12",
      {
        text: '✔ an empty cart costs nothing (0.29ms)\nℹ tests 4\nℹ pass 3\nℹ fail 0\nℹ skipped 1',
      },
      '✓ Ran npm test · 3 passed · 1 skipped',
    ],
    [
      'git mv api/test/zero.test.ts api/test/quantity.test.ts && git status --short',
      { text: 'R  api/test/zero.test.ts -> api/test/quantity.test.ts' },
      '✓ Ran git mv api/test/zero.test.ts api/test/quantity.test.ts && g…',
    ],
    ['cat api/src/markets.ts', { text: 'export interface Market {' }, '✓ Read api/src/markets.ts'],
  ])('%s', (command, result, expected) => {
    expect(row(bash(command, result))).toBe(expected);
  });
});

describe('Bash: the other reading, searching and test forms', () => {
  test.each([
    ["sed -n '10,20p' api/src/cart.ts", '✓ Read api/src/cart.ts'],
    ['head -n 20 api/src/cart.ts', '✓ Read api/src/cart.ts'],
    [`cat ${ROOT}/api/src/cart.ts`, '✓ Read api/src/cart.ts'],
    ['FORCE_COLOR=0 cat README.md', '✓ Read README.md'],
    ['ls -la api', '✓ Ran ls -la api'],
  ])('%s', (command, expected) => {
    expect(row(bash(command, { text: '' }))).toBe(expected);
  });

  test("a shell write is Wrote, its heredoc no command (t113b's real turn)", () => {
    expect(
      row(
        bash(
          "echo 'Each line counts its quantity.' >> README.md && cat > api/src/vat.ts <<'EOF'\nexport const VAT = 0.25;\nnpm test\nEOF\ngit status --short",
          { text: ' M README.md\n?? api/src/vat.ts' },
        ),
      ),
    ).toBe('✓ Wrote README.md, api/src/vat.ts');
    expect(row(bash(`cat > ${ROOT}/api/src/x.ts <<'EOF'\nx\nEOF`, { text: '' }))).toBe(
      '✓ Wrote api/src/x.ts',
    );
    expect(row(bash('npm test 2>&1 | tee test.log', { text: 'ℹ pass 5\nℹ fail 0' }))).toBe(
      '✓ Ran npm test · 5 passed',
    );
    expect(row(bash('git log --oneline > log.txt', { text: '' }))).toBe(
      '✓ Ran git log --oneline > log.txt',
    );
    expect(row(bash('cat api/src/cart.ts 2>/dev/null', { text: 'x' }))).toBe(
      '✓ Read api/src/cart.ts',
    );
  });

  test("a write Reach refused on a read name is that refusal, naming /override (#114's 11)", () => {
    const refusal = 'Reach: read only · say /override to lower it';

    expect(
      row(
        bash(`psql "$ABE_DB_READ_URL_TEST" -c "INSERT INTO carts (id) VALUES (1)"`, {
          ok: false,
          text: 'Exit code 1\nERROR:  permission denied for table carts',
        }),
      ),
    ).toBe(`✗ Test DB write refused · ${refusal}`);
    expect(
      row(
        bash(`psql "$ABE_DB_READ_URL_TEST" -c "DELETE FROM carts" | cat`, {
          text: 'ERROR:  cannot execute DELETE in a read-only transaction',
        }),
      ),
    ).toBe(`✗ Test DB write refused · ${refusal}`);
    expect(
      row(
        bash('aws s3 cp seed.json s3://shop-test-seed/ --profile "$ABE_AWS_READ_TEST"', {
          ok: false,
          text: 'Exit code 1\nupload failed: ./seed.json to s3://shop-test-seed/seed.json An error occurred (AccessDenied) when calling the PutObject operation: User: arn:aws:sts::111111111111:assumed-role/abe-read/abe-octocat is not authorized to perform: s3:PutObject',
        }),
      ),
    ).toBe(`✗ Test AWS write refused · ${refusal}`);
    expect(
      row(
        bash('AWS_PROFILE=abe-read-prod aws dynamodb put-item --table-name carts --item {}', {
          ok: false,
          text: 'Exit code 254\nAn error occurred (AccessDeniedException) when calling the PutItem operation',
        }),
      ),
    ).toBe(`✗ Prod AWS write refused · ${refusal}`);
    // A read that worked, and a failure that is no refusal, stay what they are.
    expect(row(bash(`psql "$ABE_DB_READ_URL_TEST" -c "SELECT 1"`, { text: '1' }))).toBe(
      '✓ Ran psql "$ABE_DB_READ_URL_TEST" -c "SELECT 1"',
    );
    expect(
      row(
        bash(`psql "$ABE_DB_READ_URL_TEST" -c "SELEC 1"`, {
          ok: false,
          text: 'Exit code 1\nERROR:  syntax error at or near "SELEC"',
        }),
      ),
    ).toBe(
      '✗ Ran psql "$ABE_DB_READ_URL_TEST" -c "SELEC 1" · exit 1 · ERROR:  syntax error at or near "SELEC"',
    );
  });

  test('a > or tee inside quotes is no write', () => {
    expect(row(bash('node -e "const f = (a) => a + 1; console.log(f(1))"', { text: '2' }))).toBe(
      '✓ Ran node -e "const f = (a) => a + 1; console.log(f(1))"',
    );
    expect(row(bash("echo 'a > b | tee c'", { text: 'a > b | tee c' }))).toBe(
      "✓ Ran echo 'a > b | tee c'",
    );
    expect(row(bash('echo "a => b" > "out file.txt"', { text: '' }))).toBe('✓ Wrote out file.txt');
  });

  test("a command's separators as written, a leading cd taken off", () => {
    expect(row(bash('for c in a b; do echo $c; done || echo none', { text: 'a\nb' }))).toBe(
      '✓ Ran for c in a b; do echo $c; done || echo none',
    );
    expect(row(bash('cd api;  for c in a b; do echo $c; done', { text: 'a\nb' }))).toBe(
      '✓ Ran for c in a b; do echo $c; done',
    );
  });

  test('grep in one file: its lines name no file, any line is that one', () => {
    expect(
      row(
        bash('grep -n "line.price" api/src/cart.ts', {
          text: '17:    (sum, line) => sum + line.price,\n18: x',
        }),
      ),
    ).toBe('✓ Searched "line.price" · 1 file');
  });

  test('rg names files by their lines; git grep searches too', () => {
    expect(row(bash('rg -n quantity api', { text: 'api/src/cart.ts:6:  quantity: number;' }))).toBe(
      '✓ Searched "quantity" · 1 file',
    );
    expect(
      row(
        bash('git grep -n "price"', {
          text: 'api/src/cart.ts:4:  price: number;\nREADME.md:3:price',
        }),
      ),
    ).toBe('✓ Searched "price" · 2 files');
    expect(
      row(bash('grep -rl -e total api', { text: 'api/src/cart.ts\napi/test/cart.test.ts' })),
    ).toBe('✓ Searched "total" · 2 files');
  });

  test("grep's exit 1 is no match, not a failure", () => {
    expect(row(bash('grep -rn "vat_rate" api', { ok: false, text: 'Exit code 1' }))).toBe(
      '✓ Searched "vat_rate" · no matches',
    );
    expect(
      row(
        bash('grep -rn x missing/', {
          ok: false,
          text: 'Exit code 2\ngrep: missing/: No such file or directory',
        }),
      ),
    ).toBe('✗ Searched "x" · exit 2 · grep: missing/: No such file or directory');
  });

  // abe's exit 1 with an ok answer is a status that needs you, not a failure; a refusal fails
  test("abe's --json answer says ok or not, whatever its exit", () => {
    expect(
      row(
        bash('abe install status --json', {
          ok: false,
          text: 'Exit code 1\n{"ok":true,"data":{"state":"needs-you"}}',
        }),
      ),
    ).toBe('✓ Ran abe install status --json');
    expect(
      row(
        bash('abe install stage-done board --json', {
          ok: false,
          text: 'Exit code 1\n{"ok":false,"error":{"code":"board-unwritten"}}',
        }),
      ),
    ).toStartWith('✗ Ran abe install stage-done board --json · exit 1');
  });

  test('a running command is its verb in that form, with no result', () => {
    expect(bash('npm test 2>&1 | tail -30')).toEqual({
      glyph: 'running',
      verb: 'Running',
      object: 'npm test',
      result: null,
    });
    expect(row(bash('cat api/src/cart.ts'))).toBe('● Reading api/src/cart.ts');
    expect(row(bash('grep -rn "quantity" api'))).toBe('● Searching "quantity"');
  });

  test.each([
    [
      'npx vitest run',
      ' Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 12 passed | 1 skipped (14)\n × cart total ignores quantity 3ms',
      '✗ Ran vitest · 1 failed · cart total ignores quantity',
    ],
    [
      'bun test',
      '(fail) cart > cart total ignores quantity [0.40ms]\n\n 12 pass\n 1 skip\n 1 fail\n 14 expect() calls',
      '✗ Ran bun test · 1 failed · cart total ignores quantity',
    ],
    [
      'npx jest',
      '  ● cart › cart total ignores quantity\n\nTests:       1 failed, 1 skipped, 12 passed, 14 total',
      '✗ Ran jest · 1 failed · cart total ignores quantity',
    ],
    ['npm run test', 'ℹ pass 12\nℹ fail 0\nℹ skipped 1', '✓ Ran npm test · 12 passed · 1 skipped'],
    ['bun run test', ' 7 pass\n 0 fail', '✓ Ran bun test · 7 passed'],
  ])('%s', (command, text, expected) => {
    expect(row(bash(command, { text }))).toBe(expected);
  });

  test('a test run that failed without counts says it failed', () => {
    expect(
      row(bash('npm test', { ok: false, text: 'Exit code 1\nnpm error Missing script: "test"' })),
    ).toBe('✗ Ran npm test');
  });

  test('counts read alone', () => {
    expect(testCounts('ℹ pass 5\nℹ fail 0\nℹ skipped 1')).toEqual({
      passed: 5,
      failed: 0,
      skipped: 1,
      firstFailing: null,
    });
  });
});

const patch = (p: Partial<FilePatch>): FilePatch => ({
  path: `${ROOT}/api/src/cart.ts`,
  created: false,
  added: 5,
  removed: 1,
  hunks: [],
  cut: 0,
  ...p,
});

describe('file and other tools', () => {
  const tool = (
    name: string,
    input: Record<string, string | boolean | Record<string, string>[]>,
    result: { ok?: boolean; text?: string; patch?: FilePatch | null } | null,
  ) =>
    row(
      stepOf(
        { tool: name, input },
        result === null
          ? null
          : { ok: result.ok ?? true, text: result.text ?? '', patch: result.patch ?? null },
        { root: ROOT },
      ),
    );

  test('Read, Edit, Write', () => {
    expect(tool('Read', { file_path: `${ROOT}/api/src/cart.ts` }, { text: '1\timport' })).toBe(
      '✓ Read api/src/cart.ts',
    );
    expect(
      tool(
        'Edit',
        { file_path: `${ROOT}/api/src/cart.ts`, old_string: 'a', new_string: 'b' },
        { patch: patch({}) },
      ),
    ).toBe('✓ Edited api/src/cart.ts · +5 −1');
    expect(
      tool(
        'Write',
        { file_path: `${ROOT}/api/test/zero.test.ts`, content: 'x' },
        {
          patch: patch({
            path: `${ROOT}/api/test/zero.test.ts`,
            created: true,
            added: 12,
            removed: 0,
          }),
        },
      ),
    ).toBe('✓ Created api/test/zero.test.ts · +12 −0');
    expect(tool('Edit', { file_path: `${ROOT}/api/src/cart.ts` }, null)).toBe(
      '● Editing api/src/cart.ts',
    );
    expect(
      tool(
        'Edit',
        { file_path: `${ROOT}/api/src/cart.ts` },
        { ok: false, text: 'String to replace not found in file.' },
      ),
    ).toBe('✗ Edited api/src/cart.ts · String to replace not found in file.');
  });

  test("a tool a hook refused (#181): the hook's reason, not Claude Code's prefix", () => {
    expect(
      tool(
        'Write',
        { file_path: '/home/kim/Desktop/x.txt', content: 'x' },
        {
          ok: false,
          text: "PreToolUse:Write hook error: Write refused: outside this session's worktree (/w), the only place its tools write: /home/kim/Desktop/x.txt.",
        },
      ),
    ).toBe(
      "✗ Wrote /home/kim/Desktop/x.txt · Write refused: outside this session's worktree (/w), the only place its tools w…",
    );
  });

  test('Grep and Glob', () => {
    expect(
      tool('Grep', { pattern: 'quantity' }, { text: 'Found 4 files\napi/a.ts\napi/b.ts' }),
    ).toBe('✓ Searched "quantity" · 4 files');
    expect(
      tool('Glob', { pattern: 'api/**/*.ts' }, { text: 'api/src/cart.ts\napi/src/markets.ts' }),
    ).toBe('✓ Listed api/**/*.ts · 2 files');
  });

  test('Agent (Task): its description, type, and in background or done', () => {
    const writer = {
      subagent_type: 'abe:writer',
      description: 'Fix cartTotal quantity',
      prompt: 'x',
    };

    expect(
      tool('Agent', writer, { text: 'Async agent launched successfully.\nagentId: ae61' }),
    ).toBe('✓ Task Fix cartTotal quantity · writer · in background');
    expect(tool('Task', writer, { text: 'The cart total now counts each line.' })).toBe(
      '✓ Task Fix cartTotal quantity · writer · done',
    );
    expect(tool('Agent', writer, null)).toBe('● Task Fix cartTotal quantity');
  });

  test('Task rows side by side fold into one', () => {
    const done = (object: string): Step => ({
      glyph: 'ok',
      verb: 'Task',
      object,
      result: 'reader · done',
    });
    const read: Step = { glyph: 'ok', verb: 'Read', object: 'api/src/cart.ts', result: null };

    expect(
      foldTasks([read, done("Check the api's order total"), done('Check the web cart')]).map(row),
    ).toEqual([
      '✓ Read api/src/cart.ts',
      "✓ Task Check the api's order total · 2 subagents · done",
    ]);
    expect(
      foldTasks([done('a'), { glyph: 'running', verb: 'Task', object: 'b', result: 'writer' }]).map(
        row,
      ),
    ).toEqual(['● Task a · 2 subagents']);
  });

  test('WebFetch, TodoWrite, AskUserQuestion, MCP and the rest', () => {
    expect(
      tool(
        'WebFetch',
        { url: 'https://example.com', prompt: 'title?' },
        { text: 'Example Domain' },
      ),
    ).toBe('✓ Fetched example.com');
    expect(
      tool(
        'TodoWrite',
        {
          todos: [
            { content: 'a', status: 'completed' },
            { content: 'b', status: 'in_progress' },
          ],
        },
        { text: 'ok' },
      ),
    ).toBe('✓ Updated todos · 1/2 done');
    expect(
      tool('mcp__chrome-devtools__navigate_page', { url: 'http://localhost:3000' }, { text: '' }),
    ).toBe('✓ Used chrome-devtools navigate_page');
    expect(tool('ToolSearch', { query: 'select:Grep' }, { text: '' })).toBe('✓ Used ToolSearch');
  });
});
