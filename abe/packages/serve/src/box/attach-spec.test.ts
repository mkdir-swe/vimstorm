/**
 * `abe workspace attach-spec` for a cloud session (#74): what VimStorm runs goes through `abe box
 * attach <box> -- …` to the Workspace's own box. A fake `abe box attach` runs it here, with the
 * box's clone as a local folder, so each argv is run for real.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachSpec, boxName, SessionAttachData } from '@abe/core';
import {
  fakeBoxAttach,
  fakeEc2,
  type FakeEc2,
  macServed,
  type ServedCli,
  tempState,
} from '@abe/testing';

const REPO = 'mkdir-swe/demo-shop';
const BOX = boxName(REPO);
const ROOT = '/workspace/repo';

const record = (id: string, state: string) => ({
  v: 1,
  id,
  card: 4,
  title: 'As a visitor I can sign in with email',
  description: '',
  criteria: '',
  repo: REPO,
  worktree: ROOT,
  branch: 'card/4-as-a-visitor-i-can',
  box: BOX,
  state,
  since: '2026-10-24T10:00:00.000Z',
  startedAt: '2026-10-24T10:00:00.000Z',
  transcriptPath: null,
  lastAssistantMessage: null,
  models: null,
  subagents: [],
  limit: 3,
});

describe('attach-spec in your environment: every argv through abe box attach', () => {
  const clone = mkdtempSync(join(tmpdir(), 'clone-'));
  const attach = fakeBoxAttach({ root: ROOT, dir: clone });
  let ec2: FakeEc2;
  let mac: ServedCli;

  beforeAll(async () => {
    // The Mac's cloud: its boxes on the fake EC2 (none asked here), the link to a box never up.
    ec2 = fakeEc2();
    const state = tempState();

    mkdirSync(join(state.dir, 'cloud'), { recursive: true });
    for (const [id, s] of [
      ['4-work', 'working'],
      ['4-done', 'ended'],
      ['4-wait', 'queued'],
    ] as const)
      writeFileSync(join(state.dir, 'cloud', `${id}.json`), JSON.stringify(record(id, s)));
    writeFileSync(join(clone, 'cart.ts'), 'export const total = 1;\n');
    mac = await macServed(
      {
        PATH: ec2.path,
        ABE_OWNER: ec2.owner,
        ABE_BOX_LINK: 'socket:/nonexistent.sock',
        ABE_BOX_ATTACH: attach.bin,
        AWS_REGION: 'eu-west-1',
      },
      { state },
    );
  });

  afterAll(async () => {
    await mac.close();
    ec2.remove();
  });

  test('the box, its region, the clone; nvim, the shell and exec all go to that one box', async () => {
    const out = await mac.json(AttachSpec, 'workspace', 'attach-spec', '4-work');

    if (!out.doc.ok) throw new Error(out.doc.error.message);
    const spec = out.doc.data;
    const via = [attach.bin, BOX, '--'];

    expect(spec).toMatchObject({
      where: 'cloud',
      root: ROOT,
      // on the box's host, then into its workspace container (#89)
      // its listings and git over the box's one shared SSH connection (#93)
      exec: [attach.bin, BOX, '--shared', '--', 'docker', 'exec', '-i', '-u', 'abe', 'abe-ws-4'],
      box: { name: BOX, region: 'eu-west-1' },
      waking: false,
    });
    expect(spec.nvim.slice(0, 3)).toEqual(via);
    expect(spec.shell.slice(0, 3)).toEqual(via);
  });

  test('run for real through the fake: exec reads the clone, the shell starts in it', async () => {
    const out = await mac.json(AttachSpec, 'workspace', 'attach-spec', '4-work');

    if (!out.doc.ok) throw new Error(out.doc.error.message);
    const spec = out.doc.data;
    const run = (argv: string[]) => {
      const p = Bun.spawnSync(argv, { stdin: 'ignore' });

      return { exit: p.exitCode, stdout: p.stdout.toString() };
    };

    // the tree's listing and git go as `<exec> <command>` with the box's own paths
    expect(run([...spec.exec, 'ls', ROOT])).toEqual({ exit: 0, stdout: 'cart.ts\n' });
    // the shell's argv (here a command after it, as a login shell would read one)
    const shell = run([...spec.shell, '-c', 'pwd -P']);

    expect(shell.exit).toBe(0);
    expect(shell.stdout.trim().endsWith(clone.split('/').at(-1) ?? '')).toBe(true);
    expect(attach.calls().map((c) => c.slice(0, 2))).toEqual([
      [BOX, '--shared'],
      [BOX, '--'],
    ]);
  });

  test('an ended session’s workspace still opens, waking its box; a queued one has none yet', async () => {
    const ended = await mac.json(AttachSpec, 'workspace', 'attach-spec', '4-done');

    expect(ended.doc).toMatchObject({ ok: true, data: { where: 'cloud', waking: true } });
    const queued = await mac.json(AttachSpec, 'workspace', 'attach-spec', '4-wait');

    expect(queued.doc).toMatchObject({ ok: false, error: { code: 'session-queued' } });
  });

  test("Chat's attach uses the same abe box attach", async () => {
    const out = await mac.json(SessionAttachData, 'session', 'attach', '4-work');

    expect(out.doc.ok && out.doc.data.argv).toEqual([attach.bin, BOX, '--session', '4-work']);
  });
});
