/**
 * The Launch note's words and shapes (#347) the screens read too: its limits, the standing notes'
 * Layers in words, the prompt's note heading and standing lines. Pure (zod and type imports
 * only), so the ui may import it (`@abe/core/launch-words`); `launch-note.ts` builds on it.
 */
import { z } from 'zod';
import { type Explained, type Layer } from '../layer/settings';

/**
 * The Layers a standing note comes from, top first: settings' `LAYERS`, named here because
 * session.ts reads this module and settings reads session's (`LAYER_WORDS` keeps them the same).
 */
export const NOTE_LAYERS = [
  'core',
  'feel',
  'repo',
  'individual',
] as const satisfies readonly Layer[];

/** The most a Launch note says; the Launch box shows a count from `NOTE_COUNT_FROM` on. */
export const MAX_NOTE = 2000;
export const NOTE_COUNT_FROM = 1500;

export const LaunchNote = z.object({
  /** Who launched: their git user (`user.name`), as the prompt's heading names them. */
  by: z.string().min(1),
  text: z.string().min(1).max(MAX_NOTE),
  at: z.iso.datetime(),
});
export type LaunchNote = z.infer<typeof LaunchNote>;

export const StandingNote = z.object({ text: z.string().min(1), layer: z.enum(NOTE_LAYERS) });
export type StandingNote = z.infer<typeof StandingNote>;

/** Whose a standing note is, as the Launch box and the prompt say it. */
const LAYER_WORDS: Readonly<Record<Layer, string>> = {
  core: 'built in',
  feel: 'your Feel',
  repo: 'the repo',
  individual: 'yours',
};

export const standingWords = (n: StandingNote): string => LAYER_WORDS[n.layer];

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One line of the prompt's `## Standing notes` (`notesPrompt`): `- <text> (<whose>)`. */
export const STANDING_LINE = new RegExp(
  `^- .+ \\((${Object.values(LAYER_WORDS).map(escaped).join('|')})\\)$`,
);

/**
 * The standing notes `value` names, each with the Layer that wrote it: the first of `steps` (an
 * explain's, `settings explain launch.notes`) whose entry named it and took effect.
 */
export const standingOf = (
  value: unknown,
  steps: readonly Pick<Explained['layers'][number], 'layer' | 'applied' | 'written'>[],
): StandingNote[] =>
  (Array.isArray(value) ? value : [])
    .filter((text): text is string => typeof text === 'string' && text !== '')
    .map((text) => {
      const layer = steps.find(
        (s) => s.applied && Array.isArray(s.written) && s.written.some((w) => w === text),
      )?.layer;

      return { text, layer: NOTE_LAYERS.find((l) => l === layer) ?? 'core' };
    });

/** The heading the prompt's note starts with: Chat shows what follows as your note. */
export const LAUNCH_NOTE_HEADING = /^## Notes from (.+)$/m;
