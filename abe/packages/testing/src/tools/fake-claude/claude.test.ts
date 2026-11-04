import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { fakeClaude, scriptClaude } from '../claude';

const made: string[] = [];

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const Call = z.object({
  hook_event_name: z.string(),
  tool_name: z.string(),
  tool_use_id: z.string(),
});

/** Runs the fake once on `steps` in a trusted folder, stdin closed. Returns its tool hook payloads. */
const toolHooks = async (steps: Parameters<typeof scriptClaude>[1]) => {
  const root = mkdtempSync(join(tmpdir(), 'fake-claude-ids-'));
  const fake = fakeClaude();

  made.push(root, fake.dir);
  const out = join(root, 'hooks.jsonl');
  const settings = join(root, 'settings.json');
  const command = `cat >> ${out}; echo >> ${out}`;
  const hooks = { hooks: [{ type: 'command', command }] };

  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [hooks], PostToolUse: [hooks] } }));
  writeFileSync(
    join(root, '.claude.json'),
    JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }),
  );
  scriptClaude(root, steps);
  const child = Bun.spawn([join(fake.dir, 'claude'), '--settings', settings, 'go'], {
    cwd: root,
    env: { PATH: fake.path, HOME: root },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await child.exited;

  return readFileSync(out, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => Call.parse(JSON.parse(l)));
};

test('each tool call gets its own tool_use_id, shared by its PreToolUse and PostToolUse', async () => {
  const read = { tool_name: 'Read', tool_input: { file_path: 'src/cart.ts' } };
  const calls = await toolHooks([
    { hook: 'PreToolUse', payload: read },
    { hook: 'PostToolUse', payload: read },
    { hook: 'PreToolUse', payload: { tool_name: 'AskUserQuestion' } },
    { hook: 'PreToolUse' },
    { hook: 'PostToolUse' },
    { hook: 'PreToolUse', payload: { tool_name: 'Grep', tool_use_id: 'toolu_given' } },
  ]);
  expect(calls).toHaveLength(6);
  const [readPre, readPost, ask, bashPre, bashPost, given] = calls;

  expect(readPost?.tool_use_id).toBe(readPre?.tool_use_id ?? '');
  expect(bashPost?.tool_use_id).toBe(bashPre?.tool_use_id ?? '');
  expect(given?.tool_use_id).toBe('toolu_given');
  expect(new Set([readPre, ask, bashPre, given].map((c) => c?.tool_use_id)).size).toBe(4);
});
