/**
 * The box links run `abe` on the box with every word kept whole: over an ssh-like command the
 * words go through the box's shell, so a card's text with spaces, quotes or `$(…)` must arrive as
 * one word and run nothing. A fake `box-ssh` does what ssh does: joins the words after `--` and
 * hands them to `sh -c`; the fake `abe` prints its argv as JSON.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Answered, type Box, type Boxes } from '@abe/core';
import { z } from 'zod';
import { type AwsCli } from './aws';
import { execLink, SSM_OUTPUT_LIMIT, ssmLink } from './box-link';

const dir = mkdtempSync(join(tmpdir(), 'link-'));
const marker = join(dir, 'ran');

writeFileSync(
  join(dir, 'box-ssh'),
  // ssh: everything after `--` joined by spaces, run by the remote shell.
  '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec /bin/sh -c "$*"\n',
  { mode: 0o755 },
);
writeFileSync(
  join(dir, 'abe'),
  `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
  { mode: 0o755 },
);
const link = execLink({ PATH: `${dir}:/usr/bin:/bin` }, join(dir, 'box-ssh'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('execLink', () => {
  const hostile = [
    'session',
    'run',
    '--text',
    `{"title":"It's a \\"cart\\" bug $(touch ${marker}) \`touch ${marker}\` ; touch ${marker}"}`,
    'two  spaces',
    '',
  ];

  test("each word arrives whole on the box, and nothing in a card's text runs", async () => {
    const ran = await link.run('demo-shop-4', hostile);

    expect(ran.exit).toBe(0);
    expect(z.array(z.string()).parse(JSON.parse(ran.stdout))).toEqual(hostile);
    expect(existsSync(marker)).toBe(false);
  });

  test('follow reads the same words', async () => {
    const lines: string[] = [];
    const stream = link.follow('demo-shop-4', hostile, (line) => lines.push(line));

    expect(await stream.ended).toBe(0);
    expect(z.array(z.string()).parse(JSON.parse(lines[0] ?? ''))).toEqual(hostile);
  });

  test('attach is the command with -t, the words quoted for the box', () => {
    expect(link.attach('demo-shop-4', ['session', 'attach', '4-a1b2'])).toEqual([
      join(dir, 'box-ssh'),
      '-t',
      'demo-shop-4',
      '--',
      'abe',
      "'session'",
      "'attach'",
      "'4-a1b2'",
    ]);
  });
});

/**
 * The SSM link against a fake `aws`: SSM Run Command keeps only the first 24,000 characters a
 * command printed, so an output at that length is said cut on stderr (a screenshot read through
 * it came back black below its first rows, #66); a shorter one comes back as printed.
 */
const box: Box = {
  id: 'i-0123456789abcdef0',
  name: 'demo-shop-103',
  owner: 'ada',
  state: 'running',
  size: 'm8g.large',
  zone: 'eu-west-1a',
  privateIp: '10.0.0.7',
  vpc: null,
  subnet: null,
  repo: 'mkdir-swe/demo-shop',
  card: 103,
};
const boxes: Boxes = {
  list: () => Promise.resolve({ ok: true, data: [box] }),
  status: () => Promise.resolve({ ok: true, data: box }),
  up: () => Promise.resolve({ ok: true, data: box }),
  start: () => Promise.resolve({ ok: true, data: box }),
  stop: () => Promise.resolve({ ok: true, data: box }),
  resize: () => Promise.resolve({ ok: true, data: box }),
  terminate: () => Promise.resolve({ ok: true, data: box }),
};
/** An `aws` whose SSM command printed `stdout` and `stderr` (as SSM hands them back) and exited 0. */
const awsPrinting =
  (stdout: string, stderr = ''): AwsCli =>
  (args): Promise<Answered<string>> =>
    Promise.resolve({
      ok: true,
      data:
        args[1] === 'send-command'
          ? JSON.stringify({ Command: { CommandId: 'c-1' } })
          : JSON.stringify({
              Status: 'Success',
              ResponseCode: 0,
              StandardOutputContent: stdout,
              StandardErrorContent: stderr,
            }),
    });
const ssm = (aws: AwsCli) => ssmLink({ aws, boxes, region: null, sleep: () => Promise.resolve() });

describe('ssmLink', () => {
  test('a whole output comes back as printed', async () => {
    const ran = await ssm(awsPrinting('{"ok":true}\n')).run('demo-shop-103', ['status', '--json']);

    expect(ran).toEqual({ exit: 0, stdout: '{"ok":true}\n', stderr: '' });
  });

  test("an output at SSM's limit is said cut on stderr, the exit kept", async () => {
    const cut = 'A'.repeat(SSM_OUTPUT_LIMIT);
    const ran = await ssm(awsPrinting(cut)).run('demo-shop-103', ['logs']);

    expect(ran.exit).toBe(0);
    expect(ran.stdout).toBe(cut);
    expect(ran.stderr).toContain('24,000');
    expect(ran.stderr).toContain('abe box attach');
  });

  test('a stderr at the limit is said cut too, after what it says', async () => {
    const said = 'E'.repeat(SSM_OUTPUT_LIMIT);
    const ran = await ssm(awsPrinting('', said)).run('demo-shop-103', ['logs']);

    expect(ran.stderr.startsWith(said)).toBe(true);
    expect(ran.stderr).toContain('24,000');
  });

  test('an output one short of the limit is not', async () => {
    const ran = await ssm(awsPrinting('A'.repeat(SSM_OUTPUT_LIMIT - 1))).run('demo-shop-103', [
      'logs',
    ]);

    expect(ran.stderr).toBe('');
  });
});
