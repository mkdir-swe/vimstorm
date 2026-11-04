# Playbook: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## Where and how

`abe serve` refuses a playbook that hands Abe a step on an environment agents may not reach (`Who: Abe` with a `Where:` this repo does not enable for them).

## Hand back

The playbook's subagent runs no `abe` command. In a Factory run the coordinator commits `.abe/playbooks/<card>.md` with the card's changes, then ends the step with `abe factory stage-done playbook`.
