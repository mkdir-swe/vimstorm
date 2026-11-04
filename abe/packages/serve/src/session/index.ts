/** Sessions in serve: a handler for each of core's rows, and what the process folder starts. */
import { type SESSION_COMMANDS, type HandlersFor } from '@abe/core';
import { type WorkflowCtx } from '../skills/workflows';
import { askHandlers, type AskCtx } from './ask';
import { hubHandlers, type HubCtx } from './hub';
import { moveHandlers, type MoveCtx } from './move';
import { queueHandlers } from './queue';
import { reopenHandlers, type ReopenCtx } from './reopen';
import { sessionHandlers, type SessionCtx } from './sessions';
import { skillsHandlers, type SkillsCtx } from './skills';
import { transcriptHandlers } from './transcript';

export { answerQuestions, startHolds, type AskCtx } from './ask';
export { openHub, type HubCtx } from './hub';
export { moveLocks, type MoveCtx } from './move';
export { launchSettings, startSessions, type Sessions } from './sessions';
export { type SkillsCtx } from './skills';
export { startTranscripts, type Transcripts } from './transcript';

export const SESSION_HANDLERS: HandlersFor<
  typeof SESSION_COMMANDS,
  SessionCtx & AskCtx & WorkflowCtx & MoveCtx & ReopenCtx & HubCtx & SkillsCtx
> = {
  ...sessionHandlers(),
  ...askHandlers(),
  ...queueHandlers(),
  ...transcriptHandlers(),
  ...moveHandlers(),
  ...reopenHandlers(),
  ...hubHandlers(),
  ...skillsHandlers(),
};
