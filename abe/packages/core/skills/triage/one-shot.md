# Triage

Triage reads each item of a backlog (a card on the board, or an open issue) and gives it exactly one verdict with a one-line reason. A person reads the verdicts and decides what to do: launch the ready ones, send the needs-info ones back to their product owner. Triage itself changes nothing.

Judge each item from its own text: title, type, tags, description and acceptance criteria. Read it as the agent that would build it: could that agent start now, without asking anyone, and finish in one sitting?

A card triage asked before carries its comments since then (`### Since triage asked`): the question and what its product owner answered. That answer is part of the item. A card still tagged `needs-info` waits on its answer: it stays `needs-info`, asking what is still missing.

## The four verdicts

- `ready`: an agent can do it as written. The behaviour wanted is clear, it is checkable (acceptance criteria, or a bug's steps and what should happen instead), and it is one change a reviewer can read in one sitting.
- `needs-info`: it is the right size for an agent, but something only its product owner knows is missing: what should happen, for whom, or how to tell it is done. Ask that one question.
- `too-big`: it is several changes in one item: more than one feature, area or repo to build together, or work that needs a spec and its own sub-tickets first. Say where it splits.
- `not-for-agent`: it is not code work an agent can finish and verify on its own: a decision or judgement call for people, manual testing, access only a person has, design work, or an item that asks a question rather than wanting a change.

When two fit, take the earlier one in this order: `not-for-agent`, `too-big`, `needs-info`, `ready`.

## The reason and the question

- The reason is one line naming what decided it, in the item's own words: "acceptance criteria name the error message and the header", "no expected behaviour for a wrong code", "checkout, payments and emails in one card".
- A `needs-info` verdict asks exactly one question, the one that unblocks the item. Make it specific and answerable by its product owner in a sentence: "Should a reset link expire, and after how long?", not "Please add more detail."
- Write for the person who owns the item: plain words, no jargon from this skill.

Done when every item has one verdict, a reason, and, for `needs-info`, its question.
