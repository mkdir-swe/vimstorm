/**
 * `abe session skills`: the skills a session's Claude Code loads, read from their `SKILL.md`
 * frontmatter for Chat's `/` menu (core's `slash-skills.ts` names them). The plugin's as its launch
 * builds it (the repo's `abe/skills` copies in the main checkout), the repo's `.claude/skills` in
 * its worktree (the main checkout before it has one), yours in the sessions' `HOME` only when it
 * loads the user source. A box's session: its box's serve answers.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Handlers,
  pluginSkillFiles,
  refused,
  type SessionMeta,
  type SessionSkill,
  SessionSkillsData,
  sessionSkills,
} from '@abe/core';
import { abeFolder, skillFront, skillFrontsIn } from '@abe/ports';
import { on, type SessionCtx } from './sessions';

export type SkillsCtx = SessionCtx & {
  serve: {
    /** The sessions' `HOME` where they run: yours are its `.claude/skills`. */
    sessionsHome?: string | undefined;
  };
};

/** The skills `meta`'s Claude Code loads, its `HOME` at `home`. */
export const skillsOfSession = (
  meta: Pick<SessionMeta, 'abe' | 'repo' | 'worktree' | 'skillsOnTop'>,
  home: string,
): SessionSkill[] => {
  const project = meta.worktree !== '' && existsSync(meta.worktree) ? meta.worktree : meta.repo;
  const plugin = pluginSkillFiles({
    hub: meta.abe !== undefined && meta.abe !== null,
    folder: abeFolder(meta.repo),
  });

  return sessionSkills({
    plugin: plugin.map((f) => skillFront(f.path.split('/')[1] ?? '', f.text)),
    repo: skillFrontsIn(join(project, '.claude', 'skills')),
    personal: meta.skillsOnTop ? skillFrontsIn(join(home, '.claude', 'skills')) : null,
  });
};

export const skillsHandlers = () =>
  ({
    'session skills': (args, ctx) =>
      on(
        ctx,
        args.id,
        (s) => {
          const meta = s.metaOf(args.id);

          if (meta === undefined)
            return Promise.resolve(refused('no-session', `no session ${args.id}`));

          return Promise.resolve({
            ok: true as const,
            data: { id: args.id, skills: skillsOfSession(meta, ctx.serve.sessionsHome ?? '/') },
          });
        },
        (c) => c.forward(args.id, SessionSkillsData, ['session', 'skills', args.id]),
      ),
  }) satisfies Partial<Handlers<SkillsCtx>>;
