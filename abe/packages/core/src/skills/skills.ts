/**
 * Core's skills as the sessions' plugins hold them (`skills/<name>/…` of the plugin folder, Claude
 * Code's default place), taken from the shipped set (`SHIPPED_FILES`): every session's, then the
 * Abe chat's own (`CORE_HUB_SKILLS`).
 */
import { SHIPPED_FILES } from '../shipped';
import type { PluginFile } from './subagents';

const shipped = (plugin: 'session' | 'hub'): PluginFile[] =>
  SHIPPED_FILES.filter((f) => f.plugin === plugin).map((f) => ({ path: f.path, text: f.text }));

/** A SKILL.md's text without its YAML frontmatter: what an agent is told (a one-shot's system prompt). */
export const skillBody = (text: string): string => text.replace(/^---\n[\s\S]*?\n---\n+/, '');

/** The skill a Factory run's launch prompt invokes. */
export const FACTORY_SKILL = 'factory';

/** Every file of core's skills, as the plugin folder holds them (`SHIPPED_FILES`' every session's). */
export const CORE_SKILLS: readonly PluginFile[] = shipped('session');

/**
 * The install's skill (#71): `install` drives the install in the Abe chat (`/abe:install`),
 * loading a reference per part (`references/<part>.md`) and Read's findings.
 */
export const INSTALL_SKILLS: readonly PluginFile[] = shipped('hub').filter((f) =>
  f.path.startsWith('skills/install/'),
);

/**
 * What the Abe chat (the hub) adds to core's plugin: its guide (`abe`) and the skills the person
 * invokes there as `/abe:<name>` that no Factory run loads: install, triage, improve, retro and
 * make-card.
 */
export const CORE_HUB_SKILLS: readonly PluginFile[] = shipped('hub');

/** A skill's name from its `SKILL.md` path (`skills/<name>/SKILL.md`), else undefined. */
const skillName = (path: string): string | undefined =>
  /^skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1];

/**
 * The skills the person invokes in the Abe chat as `/abe:<name>`: the hub's own but its guide
 * (`abe`, which starts it), and `prototype`, a run's skill too that `/abe:prototype` starts.
 */
export const HUB_INVOKED_SKILLS: readonly string[] = [
  ...CORE_HUB_SKILLS.flatMap((f) => {
    const name = skillName(f.path);

    return name === undefined || name === 'abe' ? [] : [name];
  }),
  'prototype',
];
