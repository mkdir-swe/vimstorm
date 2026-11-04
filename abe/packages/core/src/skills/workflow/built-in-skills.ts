/**
 * Every file of the built-in Layer's skills (`BUILT_IN_SKILLS`), from the shipped set: the
 * install copies the repo's share into its `abe/skills/` (ADR 0033); before that
 * `abe workflow path` writes one out read-only for the Editor.
 */
import { SHIPPED_FILES } from '../../shipped';
import { BUILT_IN_SKILLS } from './kinds';

/** Each built-in skill's files, `skills/<name>/…`, as `packages/core/skills/` holds them. */
export const BUILT_IN_SKILL_FILES: readonly { path: string; text: string }[] = SHIPPED_FILES.filter(
  (f) => BUILT_IN_SKILLS.some((name) => f.path.startsWith(`skills/${name}/`)),
).map((f) => ({ path: f.path, text: f.text }));
