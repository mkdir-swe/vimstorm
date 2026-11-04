# 0006 GitHub specs and informational ticket dependencies

Status: accepted product decision; staged for the implementation branch. Supersedes the local-files tracker convention and ADR 0003's enforced ticket-readiness gate.

GitHub issues hold specs and their implementation subissues, with acceptance criteria and native dependency relationships. Azure stories remain planning objects linked to that work rather than a duplicate implementation tracker. This follows the requested mattpocock/skills engineering flow and replaces the checked-in local-files tracker convention.

Ad-hoc General/Investigate sessions need no ticket, and standalone implementation tickets need no parent spec. ADRs and supporting domain documentation remain versioned with the repository. A later factory install supplies custom agents and workflows; core Abe does not introduce a parallel scheduler.

Readiness labels and blocking dependencies are informational and never disable implementation or add a confirmation gate. This explicitly supersedes the older native product decision enforcing ready-for-agent/unblocked launch.

The selected destination for native code, the spec and subissues is the project's existing public GitHub repository, with visibility unchanged. Existing ADRs remain historical records.
