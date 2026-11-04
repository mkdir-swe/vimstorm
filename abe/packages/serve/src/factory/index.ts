/** The Factory in serve: a handler for each of core's rows, and what the process folder starts. */
import { type FACTORY_COMMANDS, type HandlersFor } from '@abe/core';
import { factoryHandlers, type FactoryCtx } from './factory';
import { endHandlers } from './factory-end';
import { prHandlers, type PrCtx } from './factory-pr';
import { runRecordHandlers, type RunRecordCtx } from './run-record';

export { repoChecks, type Checks } from './checks';
export { startFactory, type Factory } from './factory';
export { startPrStage, type PrCtx, type PrStage } from './factory-pr';
export { recordParts, type RecordParts, runReportText } from './run-record';
export { stepSummarizer, type StepSummarizer } from './step-summary';

export const FACTORY_HANDLERS: HandlersFor<
  typeof FACTORY_COMMANDS,
  FactoryCtx & PrCtx & RunRecordCtx
> = {
  ...factoryHandlers(),
  ...prHandlers(),
  ...endHandlers(),
  ...runRecordHandlers(),
};
