/**
 * Azure DevOps tokens from `az account get-access-token`, which renews them with its own refresh
 * token while the login lasts. A token is kept until five minutes before it runs out, or until a
 * 401 asks for a new one. Never logged, never put in an answer.
 */
import { type BoardError, entraBlock, entraBlockText } from '@abe/core';
import { z } from 'zod';
import { type Env } from '../mac/locations';

/** Azure DevOps' resource id, which `az` mints its tokens for. */
export const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

const RENEW_BEFORE_MS = 5 * 60_000;
/** An `az` too old to say when its token runs out: read again after this. */
const UNKNOWN_LIFETIME_MS = 15 * 60_000;
const TIMEOUT_MS = 60_000;

export type Token = { ok: true; token: string } | { ok: false; error: BoardError };

/**
 * Hands out a bearer token that is still good. `stale`: one Azure DevOps refused, read anew
 * unless another request already did (so requests refused together renew once).
 */
export type Tokens = { get: (stale?: string) => Promise<Token> };

const AzToken = z.object({
  accessToken: z.string().min(1),
  expires_on: z.coerce.number().optional(),
});

const NO_LOGIN = 'run `az login --allow-no-subscriptions` and retry';

const failed = (why: string): Token => ({
  ok: false,
  error: { code: 'auth', message: `no Azure DevOps token from az (${why}): ${NO_LOGIN}` },
});

/** What `az` runs with: the given environment less a PAT that would stand in for the login. */
const azEnv = (env: Env): Record<string, string> => {
  const kept: Record<string, string> = {};

  for (const [name, value] of Object.entries(env))
    if (value !== undefined && name !== 'AZURE_DEVOPS_EXT_PAT') kept[name] = value;

  return kept;
};

export const azTokens = (env: Env, now: () => number = Date.now): Tokens => {
  const childEnv = azEnv(env);
  let current: { token: string; expiresAt: number } | undefined;
  let reading: Promise<Token> | undefined;

  const read = async (): Promise<Token> => {
    const bin = Bun.which('az', { PATH: childEnv.PATH ?? '' });

    if (bin === null) return failed('az is not installed (not on PATH)');
    const child = Bun.spawn(
      [bin, 'account', 'get-access-token', '--resource', ADO_RESOURCE, '-o', 'json'],
      { env: childEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    const [stdout, exit, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
      new Response(child.stderr).text(),
    ]).finally(() => {
      clearTimeout(timer);
    });
    // #237: Entra's refusal, said with its fix (no `az login` helps there).
    const blocked = exit === 0 ? undefined : entraBlock(stderr);

    if (blocked !== undefined)
      return {
        ok: false,
        error: {
          code: 'auth',
          message: `no Azure DevOps token from az: ${entraBlockText(blocked)}`,
        },
      };
    if (exit !== 0) return failed(`az exited ${exit}`);
    let json: unknown;

    try {
      json = JSON.parse(stdout);
    } catch {
      return failed('az answered no JSON');
    }
    const parsed = AzToken.safeParse(json);

    if (!parsed.success) return failed('az answered no token');
    const { accessToken, expires_on } = parsed.data;

    current = {
      token: accessToken,
      expiresAt: expires_on === undefined ? now() + UNKNOWN_LIFETIME_MS : expires_on * 1000,
    };

    return { ok: true, token: accessToken };
  };

  return {
    get: async (stale) => {
      if (stale !== undefined && current?.token === stale) current = undefined;
      if (current !== undefined && current.expiresAt - RENEW_BEFORE_MS > now())
        return { ok: true, token: current.token };
      // One read at a time: requests waiting on a token share it.
      reading ??= read().finally(() => {
        reading = undefined;
      });

      return reading;
    },
  };
};
