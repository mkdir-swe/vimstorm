/**
 * The skills core took from two MIT upstreams and ships as its own: mattpocock/skills
 * (engineering and productivity) and cursor/plugins (pstack). Each was copied in once and adjusted
 * by hand where it did not fit; its `SKILL.md` names the upstream repo, commit and path in
 * `metadata.upstream`. No pull command: a newer upstream is taken by hand. Both licenses are in
 * `skills/THIRD-PARTY-NOTICES.md`, shipped with them.
 */
import wayfinderSkill from '../../skills/wayfinder/SKILL.md' with { type: 'text' };
import implementSpecSkill from '../../skills/implement-spec/SKILL.md' with { type: 'text' };
import codebaseDesignSkill from '../../skills/codebase-design/SKILL.md' with { type: 'text' };
import codebaseDesignDeepening from '../../skills/codebase-design/DEEPENING.md' with { type: 'text' };
import codebaseDesignDesignItTwice from '../../skills/codebase-design/DESIGN-IT-TWICE.md' with { type: 'text' };
import diagnosingBugsSkill from '../../skills/diagnosing-bugs/SKILL.md' with { type: 'text' };
import diagnosingBugsScriptsHitlLoopTemplate from '../../skills/diagnosing-bugs/scripts/hitl-loop.template.sh' with { type: 'text' };
import domainModelingSkill from '../../skills/domain-modeling/SKILL.md' with { type: 'text' };
import domainModelingAdrFormat from '../../skills/domain-modeling/ADR-FORMAT.md' with { type: 'text' };
import domainModelingGlossaryFormat from '../../skills/domain-modeling/GLOSSARY-FORMAT.md' with { type: 'text' };
import grillingSkill from '../../skills/grilling/SKILL.md' with { type: 'text' };
import researchSkill from '../../skills/research/SKILL.md' with { type: 'text' };
import wizardSkill from '../../skills/wizard/SKILL.md' with { type: 'text' };
import wizardTemplate from '../../skills/wizard/template.sh' with { type: 'text' };
import improveCodebaseArchitectureSkill from '../../skills/improve-codebase-architecture/SKILL.md' with { type: 'text' };
import improveCodebaseArchitectureHtmlReport from '../../skills/improve-codebase-architecture/HTML-REPORT.md' with { type: 'text' };
import handoffSkill from '../../skills/handoff/SKILL.md' with { type: 'text' };
import toQuestionnaireSkill from '../../skills/to-questionnaire/SKILL.md' with { type: 'text' };
import writingForAgentsSkill from '../../skills/writing-for-agents/SKILL.md' with { type: 'text' };
import writingForAgentsSkillMechanics from '../../skills/writing-for-agents/SKILL-MECHANICS.md' with { type: 'text' };
import waitWhatSkill from '../../skills/wait-what/SKILL.md' with { type: 'text' };
import createVerificationSkillSkill from '../../skills/create-verification-skill/SKILL.md' with { type: 'text' };
import createVerificationSkillReferencesFeatureMapExampleReadme from '../../skills/create-verification-skill/references/feature-map-example/README.md' with { type: 'text' };
import createVerificationSkillReferencesFeatureMapExampleCreateNote from '../../skills/create-verification-skill/references/feature-map-example/create-note.md' with { type: 'text' };
import createVerificationSkillReferencesFeatureMapExampleSearch from '../../skills/create-verification-skill/references/feature-map-example/search.md' with { type: 'text' };
import maintainVerificationSkillSkill from '../../skills/maintain-verification-skill/SKILL.md' with { type: 'text' };
import technicalWritingSkill from '../../skills/technical-writing/SKILL.md' with { type: 'text' };
import unslopSkill from '../../skills/unslop/SKILL.md' with { type: 'text' };
import whySkill from '../../skills/why/SKILL.md' with { type: 'text' };
import whyReferencesEpistemics from '../../skills/why/references/epistemics.md' with { type: 'text' };
import whyReferencesInvestigatorPrompt from '../../skills/why/references/investigator-prompt.md' with { type: 'text' };
import whyReferencesSourcePlaybook from '../../skills/why/references/source-playbook.md' with { type: 'text' };
import whyReferencesSourcesCodeArchaeology from '../../skills/why/references/sources/code-archaeology.md' with { type: 'text' };
import whyReferencesSourcesDatabricks from '../../skills/why/references/sources/databricks.md' with { type: 'text' };
import whyReferencesSourcesDatadog from '../../skills/why/references/sources/datadog.md' with { type: 'text' };
import whyReferencesSourcesIncidentPostmortem from '../../skills/why/references/sources/incident-postmortem.md' with { type: 'text' };
import whyReferencesSourcesLinear from '../../skills/why/references/sources/linear.md' with { type: 'text' };
import whyReferencesSourcesNotion from '../../skills/why/references/sources/notion.md' with { type: 'text' };
import whyReferencesSourcesSentry from '../../skills/why/references/sources/sentry.md' with { type: 'text' };
import whyReferencesSourcesSlack from '../../skills/why/references/sources/slack.md' with { type: 'text' };
import whyReferencesSynthesizerPrompt from '../../skills/why/references/synthesizer-prompt.md' with { type: 'text' };
import howSkill from '../../skills/how/SKILL.md' with { type: 'text' };
import howReferencesExplainerPrompt from '../../skills/how/references/explainer-prompt.md' with { type: 'text' };
import howReferencesExplorerPrompt from '../../skills/how/references/explorer-prompt.md' with { type: 'text' };
import typescriptBestPracticesSkill from '../../skills/typescript-best-practices/SKILL.md' with { type: 'text' };
import typescriptBestPracticesReferencesPatterns from '../../skills/typescript-best-practices/references/patterns.md' with { type: 'text' };
import principleAttackThePremiseSkill from '../../skills/principle-attack-the-premise/SKILL.md' with { type: 'text' };
import principleBoundaryDisciplineSkill from '../../skills/principle-boundary-discipline/SKILL.md' with { type: 'text' };
import principleEncodeLessonsInStructureSkill from '../../skills/principle-encode-lessons-in-structure/SKILL.md' with { type: 'text' };
import principleFixRootCausesSkill from '../../skills/principle-fix-root-causes/SKILL.md' with { type: 'text' };
import principleFoundationalThinkingSkill from '../../skills/principle-foundational-thinking/SKILL.md' with { type: 'text' };
import principleLazinessProtocolSkill from '../../skills/principle-laziness-protocol/SKILL.md' with { type: 'text' };
import principleMakeOperationsIdempotentSkill from '../../skills/principle-make-operations-idempotent/SKILL.md' with { type: 'text' };
import principleMigrateCallersThenDeleteLegacyApisSkill from '../../skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md' with { type: 'text' };
import principleMinimizeReaderLoadSkill from '../../skills/principle-minimize-reader-load/SKILL.md' with { type: 'text' };
import principleModelTheDomainSkill from '../../skills/principle-model-the-domain/SKILL.md' with { type: 'text' };
import principleProveItWorksSkill from '../../skills/principle-prove-it-works/SKILL.md' with { type: 'text' };
import principleSequenceVerifiableUnitsSkill from '../../skills/principle-sequence-verifiable-units/SKILL.md' with { type: 'text' };
import principleSubtractBeforeYouAddSkill from '../../skills/principle-subtract-before-you-add/SKILL.md' with { type: 'text' };
import principleTestBehaviorNotImplementationSkill from '../../skills/principle-test-behavior-not-implementation/SKILL.md' with { type: 'text' };
import principleTypeSystemDisciplineSkill from '../../skills/principle-type-system-discipline/SKILL.md' with { type: 'text' };
import wayfinderProtocol from '../../skills/wayfinder/PROTOCOL.md' with { type: 'text' };
import implementSpecProtocol from '../../skills/implement-spec/PROTOCOL.md' with { type: 'text' };
import maintainVerificationSkillProtocol from '../../skills/maintain-verification-skill/PROTOCOL.md' with { type: 'text' };
import notices from '../../skills/THIRD-PARTY-NOTICES.md' with { type: 'text' };

/** Every vendored skill's files, `skills/<name>/…`, grouped by skill, and the upstreams' notices. */
export const VENDORED_SKILL_FILES: readonly { path: string; text: string }[] = [
  { path: 'skills/wayfinder/SKILL.md', text: wayfinderSkill },
  { path: 'skills/wayfinder/PROTOCOL.md', text: wayfinderProtocol },
  { path: 'skills/implement-spec/SKILL.md', text: implementSpecSkill },
  { path: 'skills/implement-spec/PROTOCOL.md', text: implementSpecProtocol },
  { path: 'skills/codebase-design/SKILL.md', text: codebaseDesignSkill },
  { path: 'skills/codebase-design/DEEPENING.md', text: codebaseDesignDeepening },
  { path: 'skills/codebase-design/DESIGN-IT-TWICE.md', text: codebaseDesignDesignItTwice },
  { path: 'skills/diagnosing-bugs/SKILL.md', text: diagnosingBugsSkill },
  {
    path: 'skills/diagnosing-bugs/scripts/hitl-loop.template.sh',
    text: diagnosingBugsScriptsHitlLoopTemplate,
  },
  { path: 'skills/domain-modeling/SKILL.md', text: domainModelingSkill },
  { path: 'skills/domain-modeling/ADR-FORMAT.md', text: domainModelingAdrFormat },
  { path: 'skills/domain-modeling/GLOSSARY-FORMAT.md', text: domainModelingGlossaryFormat },
  { path: 'skills/grilling/SKILL.md', text: grillingSkill },
  { path: 'skills/research/SKILL.md', text: researchSkill },
  { path: 'skills/wizard/SKILL.md', text: wizardSkill },
  { path: 'skills/wizard/template.sh', text: wizardTemplate },
  { path: 'skills/improve-codebase-architecture/SKILL.md', text: improveCodebaseArchitectureSkill },
  {
    path: 'skills/improve-codebase-architecture/HTML-REPORT.md',
    text: improveCodebaseArchitectureHtmlReport,
  },
  { path: 'skills/handoff/SKILL.md', text: handoffSkill },
  { path: 'skills/to-questionnaire/SKILL.md', text: toQuestionnaireSkill },
  { path: 'skills/writing-for-agents/SKILL.md', text: writingForAgentsSkill },
  { path: 'skills/writing-for-agents/SKILL-MECHANICS.md', text: writingForAgentsSkillMechanics },
  { path: 'skills/wait-what/SKILL.md', text: waitWhatSkill },
  { path: 'skills/create-verification-skill/SKILL.md', text: createVerificationSkillSkill },
  {
    path: 'skills/create-verification-skill/references/feature-map-example/README.md',
    text: createVerificationSkillReferencesFeatureMapExampleReadme,
  },
  {
    path: 'skills/create-verification-skill/references/feature-map-example/create-note.md',
    text: createVerificationSkillReferencesFeatureMapExampleCreateNote,
  },
  {
    path: 'skills/create-verification-skill/references/feature-map-example/search.md',
    text: createVerificationSkillReferencesFeatureMapExampleSearch,
  },
  { path: 'skills/maintain-verification-skill/SKILL.md', text: maintainVerificationSkillSkill },
  {
    path: 'skills/maintain-verification-skill/PROTOCOL.md',
    text: maintainVerificationSkillProtocol,
  },
  { path: 'skills/technical-writing/SKILL.md', text: technicalWritingSkill },
  { path: 'skills/unslop/SKILL.md', text: unslopSkill },
  { path: 'skills/why/SKILL.md', text: whySkill },
  { path: 'skills/why/references/epistemics.md', text: whyReferencesEpistemics },
  { path: 'skills/why/references/investigator-prompt.md', text: whyReferencesInvestigatorPrompt },
  { path: 'skills/why/references/source-playbook.md', text: whyReferencesSourcePlaybook },
  {
    path: 'skills/why/references/sources/code-archaeology.md',
    text: whyReferencesSourcesCodeArchaeology,
  },
  { path: 'skills/why/references/sources/databricks.md', text: whyReferencesSourcesDatabricks },
  { path: 'skills/why/references/sources/datadog.md', text: whyReferencesSourcesDatadog },
  {
    path: 'skills/why/references/sources/incident-postmortem.md',
    text: whyReferencesSourcesIncidentPostmortem,
  },
  { path: 'skills/why/references/sources/linear.md', text: whyReferencesSourcesLinear },
  { path: 'skills/why/references/sources/notion.md', text: whyReferencesSourcesNotion },
  { path: 'skills/why/references/sources/sentry.md', text: whyReferencesSourcesSentry },
  { path: 'skills/why/references/sources/slack.md', text: whyReferencesSourcesSlack },
  { path: 'skills/why/references/synthesizer-prompt.md', text: whyReferencesSynthesizerPrompt },
  { path: 'skills/how/SKILL.md', text: howSkill },
  { path: 'skills/how/references/explainer-prompt.md', text: howReferencesExplainerPrompt },
  { path: 'skills/how/references/explorer-prompt.md', text: howReferencesExplorerPrompt },
  { path: 'skills/typescript-best-practices/SKILL.md', text: typescriptBestPracticesSkill },
  {
    path: 'skills/typescript-best-practices/references/patterns.md',
    text: typescriptBestPracticesReferencesPatterns,
  },
  { path: 'skills/principle-attack-the-premise/SKILL.md', text: principleAttackThePremiseSkill },
  { path: 'skills/principle-boundary-discipline/SKILL.md', text: principleBoundaryDisciplineSkill },
  {
    path: 'skills/principle-encode-lessons-in-structure/SKILL.md',
    text: principleEncodeLessonsInStructureSkill,
  },
  { path: 'skills/principle-fix-root-causes/SKILL.md', text: principleFixRootCausesSkill },
  {
    path: 'skills/principle-foundational-thinking/SKILL.md',
    text: principleFoundationalThinkingSkill,
  },
  { path: 'skills/principle-laziness-protocol/SKILL.md', text: principleLazinessProtocolSkill },
  {
    path: 'skills/principle-make-operations-idempotent/SKILL.md',
    text: principleMakeOperationsIdempotentSkill,
  },
  {
    path: 'skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md',
    text: principleMigrateCallersThenDeleteLegacyApisSkill,
  },
  {
    path: 'skills/principle-minimize-reader-load/SKILL.md',
    text: principleMinimizeReaderLoadSkill,
  },
  { path: 'skills/principle-model-the-domain/SKILL.md', text: principleModelTheDomainSkill },
  { path: 'skills/principle-prove-it-works/SKILL.md', text: principleProveItWorksSkill },
  {
    path: 'skills/principle-sequence-verifiable-units/SKILL.md',
    text: principleSequenceVerifiableUnitsSkill,
  },
  {
    path: 'skills/principle-subtract-before-you-add/SKILL.md',
    text: principleSubtractBeforeYouAddSkill,
  },
  {
    path: 'skills/principle-test-behavior-not-implementation/SKILL.md',
    text: principleTestBehaviorNotImplementationSkill,
  },
  {
    path: 'skills/principle-type-system-discipline/SKILL.md',
    text: principleTypeSystemDisciplineSkill,
  },
  { path: 'skills/THIRD-PARTY-NOTICES.md', text: notices },
];

/** The vendored skills' names (their folders), in order. */
export const VENDORED_SKILLS: readonly string[] = [
  ...new Set(
    VENDORED_SKILL_FILES.map((f) => f.path.split('/')).flatMap((p) =>
      p.length > 2 && p[1] !== undefined ? [p[1]] : [],
    ),
  ),
];
