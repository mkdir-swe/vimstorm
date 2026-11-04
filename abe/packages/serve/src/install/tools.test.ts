/** `abe tools check` through the socket: each tool as this serve's probe finds it. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_MIN, envelope, type Reply, ToolsCheckData } from '@abe/core';
import { fakeToolProbe, printed, scenario, type ServeScenario } from '@abe/testing';

const open: ServeScenario[] = [];

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

const json = (reply: Reply) => envelope(ToolsCheckData).parse(JSON.parse(reply.stdout));

describe('abe tools check', () => {
  test('each tool with its version or not found, the check it ran and the fix', async () => {
    const probe = fakeToolProbe({
      node: printed('v22.11.0\n'),
      tmux: printed('tmux 3.5a\n'),
      docker: { found: true, exit: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
      gh: printed('gh version 2.63.0 (2024-11-27)\n'),
      git: printed('git version 2.47.1\n'),
      aws: printed('aws-cli/2.22.0 Python/3.12.6 Darwin/25.6.0\n'),
    });
    const s = await scenario({ toolProbe: probe });

    open.push(s);
    const reply = await s.request('tools', 'check', '--json');
    const doc = json(reply);

    expect(reply.exit).toBe(0);
    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.where).toBe('this Mac');
    expect(doc.data.tools.map((t) => [t.tool, t.state, t.version, t.fix])).toEqual([
      ['node', 'ok', '22.11.0', null],
      ['tmux', 'ok', '3.5a', null],
      ['docker', 'failed', null, 'open -a Docker'],
      // no Azure board, no cloud here: az and aws are optional, no fix (ADR 0042)
      ['az', 'missing', null, null],
      ['gh', 'ok', '2.63.0', null],
      ['claude', 'missing', null, 'brew install --cask claude-code'],
      ['git', 'ok', '2.47.1', null],
      ['rg', 'missing', null, 'brew install ripgrep'],
      ['aws', 'ok', '2.22.0', null],
    ]);
    expect(doc.data.tools.find((t) => t.tool === 'az')).toMatchObject({
      check: 'command -v az, as abe serve runs it',
      message: "not found on serve's PATH",
      optional: 'Azure Boards boards',
    });
    expect(doc.data.tools.find((t) => t.tool === 'docker')).toMatchObject({
      check: 'docker info --format {{.ServerVersion}}',
      message: 'engine not running',
    });
    expect(probe.calls.map((c) => c[0])).toEqual([
      'node',
      'tmux',
      'docker',
      'az',
      'gh',
      'claude',
      'git',
      'rg',
      'aws',
    ]);
  });

  test('az is needed for an Azure board, aws for serve.target: cloud, else optional (ADR 0042)', async () => {
    const checked = async (yaml: string) => {
      const s = await scenario({ toolProbe: fakeToolProbe({}) });

      open.push(s);
      mkdirSync(join(s.state.dir, '.git'));
      writeFileSync(join(s.state.dir, 'abe.yaml'), yaml);
      const reply = await s.request('tools', 'check', '--json');
      const doc = json(reply);

      if (!doc.ok) throw new Error(doc.error.message);

      return {
        rows: doc.data.tools
          .filter((t) => t.tool === 'az' || t.tool === 'aws')
          .map((t) => [t.tool, t.fix, t.optional]),
        text: (await s.request('tools', 'check')).stdout,
      };
    };
    const plain = await checked('');

    expect(plain.rows).toEqual([
      ['az', null, 'Azure Boards boards'],
      ['aws', null, 'sessions on your boxes (serve.target: cloud)'],
    ]);
    expect(plain.text).not.toContain('azure-cli');
    expect(plain.text).not.toContain('awscli');
    expect(
      (
        await checked(
          'board:\n  organization: https://dev.azure.com/acme\n  project: Shop\n  team: Web\n',
        )
      ).rows,
    ).toEqual([
      ['az', 'brew install azure-cli', null],
      ['aws', null, 'sessions on your boxes (serve.target: cloud)'],
    ]);
    expect((await checked('serve.target: cloud\n')).rows).toEqual([
      ['az', null, 'Azure Boards boards'],
      ['aws', 'brew install awscli', null],
    ]);
  });

  test('the human text marks each tool', async () => {
    const s = await scenario({ toolProbe: fakeToolProbe({ node: printed('v16.0.0') }) });

    open.push(s);
    const reply = await s.request('tools', 'check');

    expect(reply.stdout).toContain(
      '  node   ⚠ 16.0.0 is too old: 18 or newer  (brew upgrade node)\n',
    );
    expect(reply.stdout).toContain("  tmux   ⚠ not found on serve's PATH  (brew install tmux)\n");
  });

  test("node under a version manager is named; missing, the manager's install is the fix", async () => {
    const volta = {
      manager: 'Volta' as const,
      home: '/home/ada/.volta',
      tool: '/home/ada/.volta/bin/volta',
    };
    const at = '/home/ada/.volta/bin/node';
    const found = await scenario({
      toolProbe: fakeToolProbe({ node: printed('v22.11.0\n', at) }, [volta]),
    });
    const missing = await scenario({ toolProbe: fakeToolProbe({}, [volta]) });

    open.push(found, missing);
    expect((await found.request('tools', 'check')).stdout).toContain(
      `  node   ✓ 22.11.0 · Volta ${at}\n`,
    );
    const doc = json(await missing.request('tools', 'check', '--json'));

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.tools.find((t) => t.tool === 'node')).toMatchObject({
      state: 'missing',
      message: "not found on serve's PATH; Volta is installed but has no node",
      fix: '/home/ada/.volta/bin/volta install node',
    });
  });

  test('an old claude first on PATH is flagged, naming the one sessions use', async () => {
    const s = await scenario({
      toolProbe: fakeToolProbe({
        claude: [
          printed('2.1.39 (Claude Code)\n', '/home/ada/.volta/bin/claude'),
          printed('2.1.310 (Claude Code)\n', '/home/ada/.local/bin/claude'),
        ],
      }),
    });

    open.push(s);
    expect((await s.request('tools', 'check')).stdout).toContain(
      `  claude ⚠ 2.1.39 at /home/ada/.volta/bin/claude comes first on PATH and is too old (${CLAUDE_MIN} or newer); sessions use 2.1.310 at /home/ada/.local/bin/claude  ('/home/ada/.volta/bin/claude' update)\n`,
    );
  });

  test('a serve without its probe refuses', async () => {
    const s = await scenario();

    open.push(s);
    const reply = await s.request('tools', 'check', '--json');

    expect(reply.exit).toBe(1);
    expect(JSON.parse(reply.stdout)).toMatchObject({ ok: false, error: { code: 'no-tool-probe' } });
  });
});
