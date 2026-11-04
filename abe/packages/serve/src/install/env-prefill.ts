/**
 * The Abe env files' prefill as serve writes it (ADR 0028): the env files placed (`envFilesPlaced`:
 * `abe.yaml`'s worktree groups first, ADR 0040, then the session's mapping), the repo's env files
 * read for their values, core's
 * `abeEnvPrefill` and `withAbeBlocks`, each file written again only when its text changed (mode
 * 600). A value is read here and written to the Abe env files, never into a reply, an event or
 * the record.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ABE_ENVS,
  type AbeEnv,
  abeEnvFile,
  abeEnvHeader,
  abeEnvPrefill,
  asksEnvProfiles,
  envFilesPlaced,
  type Install,
  type InstallRepo,
  withAbeBlocks,
  type WorktreeRecipe,
} from '@abe/core';

/** Whether a move changed what the prefill writes: the mapping. */
export const envMapChanged = (before: Install, now: Install): boolean =>
  JSON.stringify(before.envFiles?.mapping ?? null) !==
  JSON.stringify(now.envFiles?.mapping ?? null);

/**
 * The Abe env files prefilled from where `abe.yaml` (`team`) and the install's mapping place the
 * repo's env files: Abe's blocks written again, the person's own lines kept. Each file written,
 * by its new mtime (ms).
 */
export const prefillAbeEnvFiles = async (
  repo: InstallRepo,
  top: string,
  i: Install,
  team: {
    recipe?: WorktreeRecipe | undefined;
    notUsed?: readonly { key: string; why: string }[];
  } = {},
): Promise<Partial<Record<AbeEnv, number>>> => {
  const files = envFilesPlaced(i, team.recipe, team.notUsed);
  const texts: Record<string, string | undefined> = {};

  for (const f of files) if (Array.isArray(f.to)) texts[f.path] = await repo.read(top, f.path);
  const p = abeEnvPrefill({
    files,
    texts,
    ci: i.envFiles?.mapping?.ci ?? null,
    awsCovers: asksEnvProfiles(i),
  });
  const written: Partial<Record<AbeEnv, number>> = {};

  for (const env of ABE_ENVS) {
    const path = join(top, abeEnvFile(env));
    const there = existsSync(path);
    const current = there ? readFileSync(path, 'utf8') : abeEnvHeader(env);
    const next = withAbeBlocks(current, p.blocks[env]);

    if (there && next === current) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, { mode: 0o600 });
    chmodSync(path, 0o600);
    written[env] = statSync(path).mtimeMs;
  }

  return written;
};
