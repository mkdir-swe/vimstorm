/** Every screen the bridge can open, by name (`open`'s `screen`, `abe ui render <screen>`). */
import { type ScreenName } from '@abe/core';
import { anyScreen, type AnyScreen, type Word } from './runtime';
import { pinnedScreen } from '../chat/pinned';
import { boxesScreen } from '../boxes/boxes';
import { pipelinesScreen } from '../pipelines/pipelines';
import { sessionsScreen } from '../sessions/sessions';
import { factoryScreen } from '../board/factory';
import { statusScreen } from '../shell/status';
import { withViews } from '../shell/views';
import { reviewScreen } from '../review/review';
import { welcomeScreen } from '../welcome/welcome';
import { runScreen } from '../run/run';
import { cardScreen } from '../board/card-page';
import { prototypeScreen } from '../prototype/prototype';

/** Each drawn with your view tweaks (`views`, #85). */
export const SCREENS: Readonly<Record<string, AnyScreen>> = {
  status: anyScreen(withViews(statusScreen)),
  // the overview
  factory: anyScreen(withViews(factoryScreen)),
  // the Chat slot's: Chat pinned to the shown workspace (#119)
  chat: anyScreen(withViews(pinnedScreen)),
  // the bottom pane's tabs (#119): Sessions (#107), Boxes (#104), Pipelines (2.2, ⌘7)
  sessions: anyScreen(withViews(sessionsScreen)),
  boxes: anyScreen(withViews(boxesScreen)),
  pipelines: anyScreen(withViews(pipelinesScreen)),
  // the Git Log's PR review (the `review` slot): VimStorm's Git tool window draws its pane
  review: anyScreen(reviewScreen),
  // the window with no project open (#212): your cards by state and your recent projects
  welcome: anyScreen(withViews(welcomeScreen)),
  // a card's run (3.0 #21): the stripe's `run` place in a card's workspace, the `main` slot
  run: anyScreen(withViews(runScreen)),
  // the story as a page: a workspace's Card page, or a card with no workspace from the Board
  card: anyScreen(cardScreen),
  // a prototype's tile (Design B): its Preview, Code and Logs pages, the `main` slot
  prototype: anyScreen(withViews(prototypeScreen)),
  // core's names, which `abe help ui render` lists: each one, and no other
} satisfies Record<ScreenName, AnyScreen>;

export const screenOf = (name: string): AnyScreen | undefined =>
  Object.hasOwn(SCREENS, name) ? SCREENS[name] : undefined;

/** Every screen's words, as Command mode lists them. */
export const WORDS: readonly Word[] = Object.values(SCREENS).flatMap((s) => s.words);
