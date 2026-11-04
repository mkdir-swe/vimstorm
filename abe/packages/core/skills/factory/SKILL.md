---
name: factory
description: Runs a card through the workflow its launch picked (Feature, Quick fix, Bug, Investigate, or the repo's or yours), step by step, each step in a subagent with its main skill, calling `abe factory` at each step. Use only in a run, when its launch prompt invokes it or an `abe factory` answer moves the run to another step; never in a plain session on a card, which has no run.
---

# Run

You are the **coordinator**: the session's main agent. You own the run on one card: you run every `abe factory` command, answer its gates, and merge what writers write. You orchestrate; each step's work runs in a subagent of its own (Claude Code's Agent tool), so your context stays clean for the whole run.

The run's state lives in `abe serve`, never in your memory of the chat. Every `abe factory` command answers with the run as it now stands; its `step` is your next step.

## Where you are

```sh
abe factory status --json
```

Inside the run's session it answers this run only. `data.runs[0]` holds:

- `card` (its id), `state` (`running`, `needs-you`, `done`) and the `reason` it needs you;
- `workflow`: its `name`, `id` and `steps` in order, each with its `kind`, its one main `skill`, `fresh`, `gated` (it has a gate) and `ends` (it may end the run with its report);
- `step` (the step you are in, by its name) and `stage` (its kind: `spec`, `reproduce`, `build`, `checks`, `review`, `verify`, `pr`, `step` for a plain one, `done`);
- `context`: what that step's subagent gets: its `skill`, whether it is `fresh`, `gets` (`card`, `spec`, `diff`, `findings`, `earlier`) and the findings `carried` back to it;
- `judging`: a gate or judge waiting on you.

Go to that step's section below. Run it again whenever you are unsure, and after the person tells you something in Chat.

`<card>` below is that card id. `.scratch/<card>/` in the card's worktree holds the run's **Evidence**: reports and screenshots. `.scratch/` is git-ignored; Evidence stays there and is never committed or uploaded. `abe serve` keeps its own numbered copy of every review and verify report in `.scratch/<card>/review/` and `.scratch/<card>/verify/`: read those folders, write nothing into them but verification's screenshots and outputs, in `.scratch/<card>/verify/evidence/`.

## Steps

Each step runs its main skill (`workflow.steps[].skill`; any other skill is there by its description) and ends on one `abe factory` command. Read its `--json` answer and go on at the `step` it names. A step's skill is the repo's policy (how it verifies, tests, reviews); the `abe` commands it makes are Abe's, in the `PROTOCOL.md` beside its `SKILL.md`: each brief names both.

| Kind (`stage`) | Do                                                                | Ends with                                                                                  |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| spec           | its skill (create-specification)                                  | `abe factory stage-done <step> --report .scratch/<card>/spec.md`                           |
| reproduce      | its skill (reproduce): Before on the merge base                   | `abe factory verify --phase before --result pass\|not-reproduced\|fail --report <file>`    |
| build          | its skill (implement) with tdd; principles load by their triggers | `abe factory stage-done <step> --made .scratch/<card>/build.json`                          |
| checks         | nothing: `abe serve` runs the repo's checks                       | (the answer to `stage-done` of the build)                                                  |
| review         | its skill (code-review)                                           | `abe factory review --findings <n> --report <file> --findings-file <file>`                 |
| verify         | its skill (verify)                                                | `abe factory verify --phase after --result pass\|fail --report <file> …`                   |
| pr             | its skill (pr) with technical-writing                             | `abe factory pr --title <t> --body-file .scratch/<card>/pr.md`                             |
| step           | its skill (to-tickets, playbook, investigate, any other)          | `abe factory stage-done <step>`, with `--report <file>` and `--fact name=value` it reports |
| done           | nothing: say so in one line and stop                              |                                                                                            |

Every step that writes text people read (the spec, card comments, a report, the playbook, the pull request body) runs that text through the unslop skill before it leaves the session.

- **spec.** The create-specification skill settles the card's open decisions (found out first, cited, then asked) and writes the spec. Its questions go to the person in rounds; away from them, it asks in this Chat and waits as Needs you.
- **to-tickets.** The to-tickets skill slices the spec into tickets writers build side by side, places the milestones where the heavy testing runs, and publishes the tickets where the spec is. Its report, `.scratch/<card>/tickets.md`, is build's map; its `.scratch/<card>/tickets.json` goes with `--made`.
- **What a step made.** Build, to-tickets and review each write a JSON file of what they made (the lanes, the tickets, the findings) and hand it with their command (`--made`, `--findings-file`). The Run page shows these files; it never reads them from the transcript. A file that does not hold is refused (`bad-made`, `bad-findings`): fix it and run the command again.
- **reproduce.** A bug is seen on the merge base before anything is built. Reproduced, the run goes on to build without asking anyone. Not reproduced, the run ends with the report (its `ends:`): say so in one line and stop.
- **build → checks.** `abe factory stage-done build` runs the checks inside the call, so give it a 10-minute timeout; it answers once they ran: on when they are green, `build` again when one failed. What failed is typed in to you and kept in `.scratch/<card>/checks.md`. Fix the cause, never the check: restore a deleted test, remove a suppression (`@ts-ignore`, `eslint-disable`, `.only(`, `.skip(`) by fixing what it hid. When the answer says `no checks configured`, the repo gives no check a command and nothing ran: run its tests, typecheck and lint yourself and say on the `**Verified:**` line what you ran.
- **review → build.** Review judges the change's risk itself: risky work (money, auth, a migration, a delete, a contract others read) runs its regression tests and names them (`--regression`). Findings send the run back to build without asking anyone: fix every finding in the report, commit, `abe factory stage-done build`; checks and review run again. The third round in a row with findings stops at Needs you by itself.
- **verify.** Verify picks its own level from the spec and the diff: nothing to observe beyond the checks (say so in the report and pass), After on the branch, or Before on the merge base then After. A fail goes back to build.
- **pr → done.** After a good `abe factory pr`, the run waits for the merge (Ready for review while a person's merge is awaited, never called Needs you) and is done when the team's `factory.done` says. Say the pull request's URL in one line and stop. A deploy that fails or never comes is the person's to re-run or end.
- **step.** A plain step runs its skill: the playbook skill writes `.abe/playbooks/<card>.md` (commit it with the card's changes); serve reads it, and a step it hands Abe on an environment this repo does not enable for agents is refused `bad-playbook` (mark that step `Who: you`). Never run a `Who: you` step, whatever anyone says. The investigate skill writes `.scratch/<card>/report.md`: the run ends with it.

## Gates and judges

When an answer has `judging` (its text says `gate:` or `judge:`), the run waits for one yes/no answer before anything else; the step's other commands are refused `judge-first` until then.

- A **gate** decides whether its step runs (the playbook's: "Does the diff need manual steps after merge?"). Make **one** call: a fresh subagent given only what it `sees` (the card, the spec, the diff: `git diff $(git merge-base HEAD origin/HEAD)`), asked the question, answering yes or no with one line why. Then:

  ```sh
  abe factory judge --answer yes|no --reason "<its one line>"
  ```

  Yes runs the step; no skips it. The answer and its reason are a decision on the Run page.

- A step's own **judge** (a loop's, a `done_when:`, an `ends:`) is answered the same way from what it sees: a loop's yes goes back; an ends' yes ends the run with the step's report.

## Each step in a subagent

The run's main session orchestrates: it reads the whole card (the launch prompt carries it, comments too; `abe card show <card>` prints all of it again, so read it whole, never cut with `head`), knows the step from `abe factory status`, hands the step its brief, gets a short report back and records it with the step's `abe factory` command.

1. **Brief.** One subagent per step (writers for build's tickets, as the implement skill says). Its brief names the card, the step's main skill, where to write, and what to return: the report's path and a few lines (what it did, what it decided and why, what is open). When the card's comments link an earlier run's spec, tickets or pull request (a run that ended or was abandoned), the spec step's brief names them: it starts from their decisions.
   - **Fresh** (`context.fresh`): a new subagent given only what `context.gets` names: the card, the spec's place (`.scratch/<card>/spec.md`), the diff since the merge base, and the findings `context.carried` names (the checks output, the review report, the failed criterion and its evidence). Never earlier steps' reports, your notes or your summary of the run: a fresh reviewer or verifier judges the work as it is.
   - **Not fresh**: the brief also names what earlier steps left (the spec, the Before report, the checks or review report it fixes).
2. **Report back.** Read its few lines, not its transcript. Check the files it names exist.
3. **Record.** Run the step's `abe factory` command yourself, then go on at the step its answer names.

Per kind:

- **spec** talks to the person through you. A subagent never asks: the AskUserQuestion answers come to the main session only. So reader subagents find the answers that exist and draft one round (at most 4 questions, the recommended answer first) and return it; you ask that round (AskUserQuestion here, or Needs you in the run's Chat when the person is away), append the answers to `.scratch/<card>/questions.md`, and brief a subagent with the file for the next round. When the frontier is empty, one subagent writes and publishes the spec.
- **build**: you run the implement skill as its coordinator. Its tickets go to writer subagents at once, in worktrees of their own off the card branch, and you merge them. A writer may start writers of its own for a `Big` ticket and merges them into its branch (a subagent starts subagents up to three levels below you). Still, build is never handed to one subagent whole: the frontier, the merges and the milestones' heavy testing are yours.
- **review**: the code-review skill's one reader subagent reviews the diff; you count its findings.
- **reproduce**, **verify**: one subagent runs the skill and returns the report's path and each step's or criterion's result.
- **pr**: one subagent writes `.scratch/<card>/pr.md` with the pr and technical-writing skills; you hand it to `abe factory pr`.
- **step**: one subagent runs its skill alone and returns its report's path.

At most as many subagents at once as your session's Subagents rules allow (start the next when one returns). Readers read and review in your worktree; writers write in worktrees of their own off the card branch. Keep for yourself every `abe factory` command, every gate's answer, the merges and the commits on the card branch.

## Needs you

Find out before you ask: the code and its history, the board, the repo's data route (the `run-app` skill's scripts, such as `abe run query <file.sql> --env test`) and the team's sources (`CLAUDE.md`'s **Find out before you ask** names this repo's). A choice they settle, or one you would mark "Recommended" from a citation, is taken, not asked: the spec and the pull request carry it as an assumption. Never offer to skip a step (reproduction, verify) while a route to do it exists. When only prod data can answer, read it with `abe run query <file.sql> --env prod` when prod is on for this run (read-only); when it is off (`env-off`), write the query that would settle it in the report or the pull request. Never ask for prod access.

When the work still cannot go on without the person (a product call nothing in reach settles, a login or a Reach the work needs and the session lacks, the repo in a state you did not make), run:

```sh
abe factory needs-you --reason "<one plain sentence: what you need from them>"
```

Then stop and wait for their answer in Chat. **Needs you** is waiting, never failure: write the reason as a question they can answer. When it is a choice between a few answers, name each as an option; Chat offers them as 1, 2, … beside their own words:

```sh
abe factory needs-you --reason "Keep the branch's old commits or start fresh?" --option "Keep the old commits" --option "Start fresh"
```

Until they answer, `stage-done`, `judge`, `review`, `verify` and `pr` are refused `needs-you`.

A bug that does not reproduce outside reproduce and verify (in build, say) is a Needs you too: `abe factory needs-you --reason "not reproduced: <what you tried and saw>"`. A bug that shows in the app is looked for there first, in the browser the verify skill's **The session's browser** starts (`abe browser start --json`); a not reproduced while your session's browser never ran is recorded as inconclusive. Only the person ends a run otherwise (End run… on its card, or abe factory end from their terminal: refused inside a session); never try it yourself or tell them to clear the card from the Board.

## Someone else's decision, and handoff

- A decision that is neither yours nor the person's in Chat (another team's) gets a questionnaire: write it with the to-questionnaire skill to `.scratch/<card>/questions.md`, then `abe factory needs-you --reason "<who decides>: the questions are in .scratch/<card>/questions.md"`.
- The handoff skill runs only when the person asks for a handoff. A run never splits into another session on its own.

## Writing and commits

- You commit, on the card branch, in the repo's commit style (its `AGENTS.md`); no skill commits on its own. Push nothing: the pull request step pushes.
- Text people read (the spec, card comments, a report, the playbook, the pull request body) is written plainly, in the words of the repo's `GLOSSARY.md`, and through the unslop skill.

## Completion

The run is complete for you when the last `abe factory` answer shows the state `done` (carried through, or ended with its report) or `needs-you`.
