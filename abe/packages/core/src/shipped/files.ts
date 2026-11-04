/**
 * Every file Abe ships for its skills and workflows, as text (`packages/core/skills/`,
 * `packages/core/workflows/`): imported once here, so the compiled `abe` carries them and core
 * reads no file. Each says who owns it in a repo and which plugin loads it. A copied skill's
 * `PROTOCOL.md` (the `abe` commands its steps make) is Abe's: the repo's `SKILL.md` holds its
 * policy only.
 */
import abeHub from '../../skills/abe/SKILL.md' with { type: 'text' };
import codeReview from '../../skills/code-review/SKILL.md' with { type: 'text' };
import createSpecification from '../../skills/create-specification/SKILL.md' with { type: 'text' };
import factory from '../../skills/factory/SKILL.md' with { type: 'text' };
import implement from '../../skills/implement/SKILL.md' with { type: 'text' };
import improve from '../../skills/improve/SKILL.md' with { type: 'text' };
import improveOneShot from '../../skills/improve/one-shot.md' with { type: 'text' };
import install from '../../skills/install/SKILL.md' with { type: 'text' };
import installBoardRef from '../../skills/install/references/board.md' with { type: 'text' };
import installChecksRef from '../../skills/install/references/checks.md' with { type: 'text' };
import installDoneRef from '../../skills/install/references/done.md' with { type: 'text' };
import installEnvFilesRef from '../../skills/install/references/env-files.md' with { type: 'text' };
import installLoginsRef from '../../skills/install/references/logins.md' with { type: 'text' };
import installPrototypeRef from '../../skills/install/references/prototype.md' with { type: 'text' };
import installReadRef from '../../skills/install/references/read.md' with { type: 'text' };
import installSkillsRef from '../../skills/install/references/skills.md' with { type: 'text' };
import installSourcesRef from '../../skills/install/references/sources.md' with { type: 'text' };
import installVerifyRef from '../../skills/install/references/verify.md' with { type: 'text' };
import installWorkflowsRef from '../../skills/install/references/workflows.md' with { type: 'text' };
import installWorktreeRef from '../../skills/install/references/worktree.md' with { type: 'text' };
import installPorts from '../../skills/install/scripts/ports.sh' with { type: 'text' };
import investigate from '../../skills/investigate/SKILL.md' with { type: 'text' };
import makeCard from '../../skills/make-card/SKILL.md' with { type: 'text' };
import playbook from '../../skills/playbook/SKILL.md' with { type: 'text' };
import pr from '../../skills/pr/SKILL.md' with { type: 'text' };
import prototypeLogic from '../../skills/prototype/LOGIC.md' with { type: 'text' };
import prototype from '../../skills/prototype/SKILL.md' with { type: 'text' };
import prototypeUi from '../../skills/prototype/UI.md' with { type: 'text' };
import reproduce from '../../skills/reproduce/SKILL.md' with { type: 'text' };
import retro from '../../skills/retro/SKILL.md' with { type: 'text' };
import retroOneShot from '../../skills/retro/one-shot.md' with { type: 'text' };
import tddMocking from '../../skills/tdd/mocking.md' with { type: 'text' };
import tdd from '../../skills/tdd/SKILL.md' with { type: 'text' };
import tddTests from '../../skills/tdd/tests.md' with { type: 'text' };
import toTickets from '../../skills/to-tickets/SKILL.md' with { type: 'text' };
import triage from '../../skills/triage/SKILL.md' with { type: 'text' };
import triageOneShot from '../../skills/triage/one-shot.md' with { type: 'text' };
import verify from '../../skills/verify/SKILL.md' with { type: 'text' };
import bug from '../../workflows/bug.yaml' with { type: 'text' };
import feature from '../../workflows/feature.yaml' with { type: 'text' };
import investigateWorkflow from '../../workflows/investigate.yaml' with { type: 'text' };
import quickFix from '../../workflows/quick-fix.yaml' with { type: 'text' };
import codeReviewProtocol from '../../skills/code-review/PROTOCOL.md' with { type: 'text' };
import createSpecificationProtocol from '../../skills/create-specification/PROTOCOL.md' with { type: 'text' };
import implementProtocol from '../../skills/implement/PROTOCOL.md' with { type: 'text' };
import improveProtocol from '../../skills/improve/PROTOCOL.md' with { type: 'text' };
import investigateProtocol from '../../skills/investigate/PROTOCOL.md' with { type: 'text' };
import makeCardProtocol from '../../skills/make-card/PROTOCOL.md' with { type: 'text' };
import playbookProtocol from '../../skills/playbook/PROTOCOL.md' with { type: 'text' };
import prProtocol from '../../skills/pr/PROTOCOL.md' with { type: 'text' };
import prototypeProtocol from '../../skills/prototype/PROTOCOL.md' with { type: 'text' };
import reproduceProtocol from '../../skills/reproduce/PROTOCOL.md' with { type: 'text' };
import retroProtocol from '../../skills/retro/PROTOCOL.md' with { type: 'text' };
import toTicketsProtocol from '../../skills/to-tickets/PROTOCOL.md' with { type: 'text' };
import triageProtocol from '../../skills/triage/PROTOCOL.md' with { type: 'text' };
import verifyProtocol from '../../skills/verify/PROTOCOL.md' with { type: 'text' };
import { VENDORED_SKILL_FILES } from './vendored';

/**
 * One file Abe ships, by its path under a repo's `abe/` (`skills/<name>/…`, `workflows/<id>.yaml`).
 * `owner`: `repo` is copied in by the install and the repo's from then on; `abe` is Abe's own,
 * never copied, and a repo's file at its path is not read. `plugin`: the sessions whose plugin
 * holds it (`session` every one, `hub` the Abe chat's), null for none.
 */
export type ShippedFile = {
  path: string;
  text: string;
  owner: 'repo' | 'abe';
  plugin: 'session' | 'hub' | null;
};

const repo = (plugin: ShippedFile['plugin'], path: string, text: string): ShippedFile => ({
  path,
  text,
  owner: 'repo',
  plugin,
});
const abe = (plugin: ShippedFile['plugin'], path: string, text: string): ShippedFile => ({
  path,
  text,
  owner: 'abe',
  plugin,
});

/** A copied skill's other half: Abe's side of it (the `abe` commands), Abe's own beside the repo's. */
export const PROTOCOL_FILE = 'PROTOCOL.md';

/** Every shipped file: each session's skills, the Abe chat's, Abe's one-shots, the workflows. */
export const SHIPPED_FILES: readonly ShippedFile[] = [
  // every session's: the run's driver first, then the Factory's skills
  abe('session', 'skills/factory/SKILL.md', factory),
  repo('session', 'skills/create-specification/SKILL.md', createSpecification),
  abe('session', 'skills/create-specification/PROTOCOL.md', createSpecificationProtocol),
  repo('session', 'skills/to-tickets/SKILL.md', toTickets),
  abe('session', 'skills/to-tickets/PROTOCOL.md', toTicketsProtocol),
  repo('session', 'skills/reproduce/SKILL.md', reproduce),
  abe('session', 'skills/reproduce/PROTOCOL.md', reproduceProtocol),
  repo('session', 'skills/investigate/SKILL.md', investigate),
  abe('session', 'skills/investigate/PROTOCOL.md', investigateProtocol),
  repo('session', 'skills/implement/SKILL.md', implement),
  abe('session', 'skills/implement/PROTOCOL.md', implementProtocol),
  repo('session', 'skills/tdd/SKILL.md', tdd),
  repo('session', 'skills/tdd/tests.md', tddTests),
  repo('session', 'skills/tdd/mocking.md', tddMocking),
  repo('session', 'skills/code-review/SKILL.md', codeReview),
  abe('session', 'skills/code-review/PROTOCOL.md', codeReviewProtocol),
  repo('session', 'skills/verify/SKILL.md', verify),
  abe('session', 'skills/verify/PROTOCOL.md', verifyProtocol),
  repo('session', 'skills/pr/SKILL.md', pr),
  abe('session', 'skills/pr/PROTOCOL.md', prProtocol),
  repo('session', 'skills/playbook/SKILL.md', playbook),
  abe('session', 'skills/playbook/PROTOCOL.md', playbookProtocol),
  // a developer's prototype, which wayfinder's prototype tickets call too
  repo('session', 'skills/prototype/SKILL.md', prototype),
  abe('session', 'skills/prototype/PROTOCOL.md', prototypeProtocol),
  repo('session', 'skills/prototype/UI.md', prototypeUi),
  repo('session', 'skills/prototype/LOGIC.md', prototypeLogic),
  // taken from upstream once, adjusted by hand (`vendored.ts`); their notices are Abe's
  ...VENDORED_SKILL_FILES.map((f) =>
    f.path.split('/').length > 2 && !f.path.endsWith(`/${PROTOCOL_FILE}`)
      ? repo('session', f.path, f.text)
      : abe('session', f.path, f.text),
  ),
  // the Abe chat's: its guide, the install's skill, the skills the person invokes there
  abe('hub', 'skills/abe/SKILL.md', abeHub),
  abe('hub', 'skills/install/SKILL.md', install),
  abe('hub', 'skills/install/references/read.md', installReadRef),
  abe('hub', 'skills/install/references/logins.md', installLoginsRef),
  abe('hub', 'skills/install/references/board.md', installBoardRef),
  abe('hub', 'skills/install/references/sources.md', installSourcesRef),
  abe('hub', 'skills/install/references/env-files.md', installEnvFilesRef),
  abe('hub', 'skills/install/references/worktree.md', installWorktreeRef),
  abe('hub', 'skills/install/references/checks.md', installChecksRef),
  abe('hub', 'skills/install/references/workflows.md', installWorkflowsRef),
  abe('hub', 'skills/install/references/skills.md', installSkillsRef),
  abe('hub', 'skills/install/references/verify.md', installVerifyRef),
  abe('hub', 'skills/install/references/prototype.md', installPrototypeRef),
  abe('hub', 'skills/install/references/done.md', installDoneRef),
  // the start and stop scripts' helpers: the process group and its ports
  abe('hub', 'skills/install/scripts/ports.sh', installPorts),
  repo('hub', 'skills/triage/SKILL.md', triage),
  abe('hub', 'skills/triage/PROTOCOL.md', triageProtocol),
  repo('hub', 'skills/improve/SKILL.md', improve),
  abe('hub', 'skills/improve/PROTOCOL.md', improveProtocol),
  repo('hub', 'skills/retro/SKILL.md', retro),
  abe('hub', 'skills/retro/PROTOCOL.md', retroProtocol),
  repo('hub', 'skills/make-card/SKILL.md', makeCard),
  abe('hub', 'skills/make-card/PROTOCOL.md', makeCardProtocol),
  // the one-shots' prompts: Abe runs them itself
  abe(null, 'skills/triage/one-shot.md', triageOneShot),
  abe(null, 'skills/improve/one-shot.md', improveOneShot),
  abe(null, 'skills/retro/one-shot.md', retroOneShot),
  // the workflows: Feature on default, Quick fix on Task, Bug on Bug, Investigate with no `on:`
  repo(null, 'workflows/feature.yaml', feature),
  repo(null, 'workflows/quick-fix.yaml', quickFix),
  repo(null, 'workflows/bug.yaml', bug),
  repo(null, 'workflows/investigate.yaml', investigateWorkflow),
];
