/**
 * A page's screenshot by this Mac's headless Chrome or Chromium (`--screenshot`), with a profile
 * of its own made and removed per shot: no sign-in, history or keychain of yours. The install's
 * Prototype check takes one of the prototype's page. IO only.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPng, type PageShot } from '@abe/core';
import { runProcess } from './process';
import { type Env } from './locations';

const SHOT_MS = 30_000;

/** `executable` (none: no browser here, every shot refused) writing PNGs. */
export const chromePageShot =
  (o: { executable: string | null; env: Env }): PageShot =>
  async ({ url, file, width, height }) => {
    if (o.executable === null) return { ok: false, why: 'no Chrome or Chromium on this Mac' };
    const profile = mkdtempSync(join(tmpdir(), 'abe-shot-'));

    try {
      const ran = await runProcess(
        [
          o.executable,
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--disable-sync',
          '--disable-background-networking',
          '--use-mock-keychain',
          '--hide-scrollbars',
          `--user-data-dir=${profile}`,
          `--window-size=${width},${height}`,
          `--screenshot=${file}`,
          url,
        ],
        { PATH: o.env.PATH ?? '/usr/bin:/bin', HOME: o.env.HOME ?? profile },
        undefined,
        SHOT_MS,
      );

      if (!existsSync(file) || !isPng(readFileSync(file)))
        return {
          ok: false,
          why: `the browser wrote no screenshot (exit ${ran.exit}): ${ran.stderr.trim().split('\n').slice(-2).join(' ')}`,
        };

      return { ok: true };
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  };
