/**
 * `githubIdentity` (1.x's Project GitHub identity): the GitHub login the review screen's writes
 * go out as (a review, a comment, a reply, a resolve, ready, close, a Draft PR, a merge). gh's
 * login is read before each one: another login, or none read, refuses it in red naming both;
 * unset, gh's login goes, whichever it is.
 */
import { type ReviewRefusal } from './drafts';

/** The code `abe pr merge` refuses with when gh's login is not githubIdentity's. */
export const IDENTITY_REFUSED = 'github-identity';

/** gh's login as read (`gh api user`), or why it could not be. */
export type LoginRead = { ok: true; data: string } | { ok: false; error: { message: string } };

/** Why a GitHub write may not go as `login` when `expected` is set; `undefined` when it may. */
export const identityRefusal = (
  expected: string | null,
  login: LoginRead,
): ReviewRefusal | undefined => {
  if (expected === null) return undefined;
  if (!login.ok)
    return {
      tone: 'error',
      why: `✗ GitHub writes go as ${expected} (githubIdentity), but gh's login could not be read: ${login.error.message}`,
    };
  // GitHub logins are one account whatever their case.
  if (login.data.toLowerCase() === expected.toLowerCase()) return undefined;

  return {
    tone: 'error',
    why: `✗ GitHub writes go as ${expected} (githubIdentity), but gh is signed in as ${login.data === '' ? 'nobody' : login.data}: gh auth switch --user ${expected}`,
  };
};
