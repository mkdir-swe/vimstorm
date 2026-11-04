/**
 * A session worktree's git hooks (#196): its pushes to the default branch refused with a readable
 * reason, every other hook the repository has run as before. The worktree's own `core.hooksPath`
 * (its `config.worktree`, `extensions.worktreeConfig`) names `SESSION_HOOKS` under the
 * repository's `hooks/`, which a session's sandbox never writes, nor its worktree config
 * (`sessionBoundary`); each hook there runs the repository's own (its `core.hooksPath` in any
 * other scope, else `hooks/`) with the same arguments and stdin. The main checkout keeps its own.
 *
 * Defence in depth, no wall: `--no-verify` or a script that turns hooks off skips it (the session's
 * deny rules refuse those as commands typed).
 */

/** The folder under the repository's `hooks/` that a session worktree's `core.hooksPath` names. */
export const SESSION_HOOKS = 'abe-session';

/** A push to the default branch refused (the hook's first word after `abe:`). */
export const DEFAULT_BRANCH_PUSH = 'default-branch-push';

/**
 * The client-side hooks git runs by name: each one passes on to the repository's own. Not
 * `reference-transaction` nor `post-index-change`, which git runs on every ref and index change
 * (a shell and three gits each time); a repository's own of those does not run in a session
 * worktree.
 */
export const SESSION_HOOK_NAMES = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'post-rewrite',
  'pre-auto-gc',
  'sendemail-validate',
] as const;

const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * Every session hook's text, the same for each name (it reads its own name): `defaultBranch` the
 * default branch's name as `serve` found it (null: none found), and at push time the remote's
 * `HEAD` too; with neither known, `main` and `master`.
 */
export const sessionHookScript = (defaultBranch: string | null): string => `#!/bin/sh
# abe: a session worktree's hook (#196). See core's session-hooks.ts.
name=$(basename "$0")
top=$(git rev-parse --show-toplevel 2>/dev/null) || top=.
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 1
# The repository's own hooks folder: its core.hooksPath in any scope but this worktree's.
own=$(git config --show-scope --get-all core.hooksPath 2>/dev/null | awk -F '\\t' '$1 != "worktree" && $1 != "command" { v = $2 } END { print v }')
case $own in
  '') own="$common/hooks" ;;
  '~/'*) own="$HOME/\${own#'~/'}" ;;
  /*) ;;
  *) own="$top/$own" ;;
esac
# Never itself (a core.hooksPath set to this folder in the repository's own config).
[ "$(cd "$own" 2>/dev/null && pwd -P)" = "$(cd "$(dirname "$0")" && pwd -P)" ] && own=/nonexistent
if [ "$name" = pre-push ]; then
  input=$(cat)
  default=${shellWord(defaultBranch ?? '')}
  remote=$(git symbolic-ref --quiet --short "refs/remotes/$1/HEAD" 2>/dev/null)
  remote=\${remote#"$1/"}
  for ref in $(printf '%s\\n' "$input" | awk '{ print $3 }'); do
    branch=\${ref#refs/heads/}
    if [ -n "$default$remote" ]; then
      [ "$branch" = "$default" ] || [ "$branch" = "$remote" ] || continue
    else
      [ "$branch" = main ] || [ "$branch" = master ] || continue
    fi
    echo "abe: ${DEFAULT_BRANCH_PUSH}: $branch is the default branch, and a session never pushes to it. Push the card's branch; its pull request takes the change to $branch once a person merges it." >&2
    exit 1
  done
  # The repository's pre-push gets the same stdin: its lines, or nothing.
  if [ -x "$own/$name" ]; then
    if [ -n "$input" ]; then printf '%s\\n' "$input"; fi | "$own/$name" "$@"
    exit $?
  fi
  exit 0
fi
if [ -x "$own/$name" ]; then exec "$own/$name" "$@"; fi
exit 0
`;
