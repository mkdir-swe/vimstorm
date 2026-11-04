/**
 * Shipped files: what Abe ships for its skills and workflows, what a repo owns once they are
 * copied in, what a session or the workflow loader sees for a repo, and the three-way update.
 */
export { PROTOCOL_FILE, SHIPPED_FILES, type ShippedFile } from './files';
export { merge3, type MergeLabels } from './merge';
export {
  ABE_ONLY_SKILLS,
  type AbeFolder,
  AbeInstalled,
  abeInForce,
  AbeUpdate,
  applyUpdates,
  copyInto,
  INSTALLED_RECORD,
  isInstalled,
  pluginFor,
  proposeUpdates,
  type ShippedText,
  UPDATE_HOWS,
  UpdateFile,
  updatesNotice,
  updatesOf,
  WorkflowUpdateData,
  workflowUpdateText,
  abeUpdatesWords,
} from './shipped';
export { VENDORED_SKILL_FILES, VENDORED_SKILLS } from './vendored';
