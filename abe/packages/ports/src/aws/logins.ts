/**
 * The person's logins from Secrets Manager (ADR 0016: stored once, readable only by their boxes),
 * through the Secrets port: `abe/<owner>/claude-token` and `abe/<owner>/github-token`, each the
 * token itself or `{"token": "…"}`. The values go straight on to the workspace; nothing here
 * prints or keeps them.
 */
import { type Answered, type LoginSet, type Logins, loginSecrets, type Secrets } from '@abe/core';
import { z } from 'zod';

const Wrapped = z.object({ token: z.string().min(1) });

const tokenOf = (text: string): string => {
  try {
    const wrapped = Wrapped.safeParse(JSON.parse(text));

    if (wrapped.success) return wrapped.data.token;
  } catch {
    // Not JSON: the token itself.
  }

  return text.trim();
};

export const secretLogins = (o: {
  secrets: Secrets;
  owner: string;
  region: string | null;
}): Logins => ({
  read: async (): Promise<Answered<LoginSet>> => {
    const ids = loginSecrets(o.owner);
    const [claude, github] = await Promise.all([
      o.secrets.read({ secret: ids.claude, region: o.region }),
      o.secrets.read({ secret: ids.github, region: o.region }),
    ]);

    if (!claude.ok)
      return { ok: false, error: { code: 'no-login', message: claude.error.message } };
    if (!github.ok)
      return { ok: false, error: { code: 'no-login', message: github.error.message } };
    const set = { claude: tokenOf(claude.data), github: tokenOf(github.data) };

    if (set.claude === '' || set.github === '')
      return {
        ok: false,
        error: { code: 'no-login', message: `a login of ${o.owner}'s is empty` },
      };

    return { ok: true, data: set };
  },
});
