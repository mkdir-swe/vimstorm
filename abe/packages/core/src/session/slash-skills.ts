/**
 * The skills a session's Claude Code loads, as Chat's `/` menu lists them after its commands:
 * Abe's from the session's `abe` plugin (`--plugin-dir`) as `/abe:<name>` (core's, the Abe chat's
 * own too in the Abe chat, as the shipped files' `pluginFor` has them for the repo), the repo's `.claude/skills/<name>/` as `/<name>` (the project source
 * `--setting-sources` keeps), and the person's `~/.claude/skills/<name>/` as `/<name>` only when the
 * session loads the user source (`skillsOnTop` at launch). The ports read the files; this names them.
 */
import { z } from 'zod';
import { type AbeFolder, pluginFor } from '../shipped';
import { CORE_HUB_SKILLS, PLUGIN_NAME, PLUGIN_SKILLS, type PluginFile } from '../skills';

export const SKILL_OWNERS = ['abe', 'repo', 'yours'] as const;

/** One skill the session can invoke: its name as typed, whose it is, its description on one line. */
export const SessionSkill = z.object({
  /** As typed in the composer: `/abe:triage`, `/tdd`. */
  name: z.string().min(2),
  whose: z.enum(SKILL_OWNERS),
  description: z.string(),
});
export type SessionSkill = z.infer<typeof SessionSkill>;

/** `abe session skills`: Abe's first, then the repo's, then yours, each by name. */
export const SessionSkillsData = z.object({
  id: z.string(),
  skills: z.array(SessionSkill),
});
export type SessionSkillsData = z.infer<typeof SessionSkillsData>;

const WHOSE_WORDS = { abe: 'Abe’s', repo: 'Repo’s', yours: 'Yours' } as const;

export const sessionSkillsText = (d: SessionSkillsData): string =>
  d.skills.length === 0
    ? `${d.id}: no skills`
    : d.skills.map((s) => `${s.name}  ${WHOSE_WORDS[s.whose]}  ${s.description}`).join('\n');

/** A `SKILL.md` as the ports read its frontmatter: its folder's name, `name`, `description`. */
export type SkillFront = {
  /** Its folder's name (`skills/<dir>/SKILL.md`). */
  dir: string;
  /** Frontmatter `name:`; absent: the folder's. */
  name?: string | undefined;
  description: string;
  /** Frontmatter `user-invocable: false`: Claude Code keeps it out of its `/` menu. */
  hidden?: boolean | undefined;
};

/** The `SKILL.md` files of a session's plugin: core's, the Abe chat's own in it, the repo's copies. */
export const pluginSkillFiles = (o: { hub: boolean; folder: AbeFolder | null }): PluginFile[] =>
  // as the launch builds the plugin (`sessions.ts`, the Abe chat's `CORE_HUB_SKILLS` its extra)
  pluginFor([...PLUGIN_SKILLS, ...(o.hub ? CORE_HUB_SKILLS : [])], o.folder).filter((f) =>
    /^skills\/[^/]+\/SKILL\.md$/.test(f.path),
  );

/** Whitespace folded: a description's one line. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const byName = (a: SessionSkill, b: SessionSkill) => a.name.localeCompare(b.name);

/**
 * The session's skills: the plugin's as `/abe:<name>`, the repo's and (`personal`, null when the
 * session leaves the user source out) yours as `/<name>`; one of yours wins over the repo's of the
 * same name, as Claude Code's personal skills win over a project's. `user-invocable: false` ones
 * are left out.
 */
export const sessionSkills = (o: {
  plugin: readonly SkillFront[];
  repo: readonly SkillFront[];
  personal: readonly SkillFront[] | null;
}): SessionSkill[] => {
  const row = (f: SkillFront, whose: SessionSkill['whose'], prefix: string): SessionSkill[] =>
    f.hidden === true
      ? []
      : [{ name: `/${prefix}${f.name ?? f.dir}`, whose, description: oneLine(f.description) }];
  const yours = (o.personal ?? []).flatMap((f) => row(f, 'yours', ''));
  const repo = o.repo
    .flatMap((f) => row(f, 'repo', ''))
    .filter((s) => !yours.some((y) => y.name === s.name));

  return [
    ...o.plugin.flatMap((f) => row(f, 'abe', `${PLUGIN_NAME}:`)).sort(byName),
    ...repo.sort(byName),
    ...yours.sort(byName),
  ];
};
