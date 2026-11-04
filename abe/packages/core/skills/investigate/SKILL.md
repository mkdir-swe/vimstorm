---
name: investigate
description: Answers a card's question with a cited report on its Run page, read from the code, its history, the docs and the team's sources; may push a throwaway spike branch the report links, never a pull request. Use at an Investigate run's step, or when asked to investigate, research or answer a question about a card.
---

# Investigate

The card asks a question, not for a change: why something happens, whether something can be done, what it would take, which option is better. The answer is a **report**, every claim cited, read on the run's Run page. Nothing ships: no pull request.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## 1. Pin the question

Read the card and what it links (`PROTOCOL.md`, Pin the question). Write the question in one sentence, and what an answer must say to be useful (a yes or no, a cause, options with their cost). When the card asks several things, list each.

## 2. Find out

Hand the wide reading to reader subagents, each with one part of the question: the code and its history (`git log -S`, blame), `GLOSSARY.md` and the ADRs, `docs/`, earlier cards and specs (and an earlier run's report, spec and pull request the card's comments link: start from what they found), logs, the repo's data route (the `run-app` skill's scripts, such as its `query` against test; `PROTOCOL.md`, Find out) and the team's sources your session reaches (its MCP servers). `CLAUDE.md`'s **Find out before you ask** names this repo's. The why and how skills help for "why is it like this" and "how does this work".

A claim that only running code can settle gets a **spike**: throwaway code, committed on the run's card branch (`card/<card>`); it is evidence, never merged. Push nothing: when the run ends, Abe pushes the branch and the run keeps its commits. Give each commit a subject that says what it tried. The report says what the spike showed and names the branch.

Ask the person only a product call nothing in reach settles: wait as Needs you with the question and its options (`PROTOCOL.md`, Find out). A question the code or the data answers is answered, with its citation; one you would answer with "Recommended" is taken, and the report says so. When only prod data can answer, read it through the data route against prod when prod is on for this run; when it is off, the report gives the query that would settle it. Never ask for prod access.

## 3. Write the report

Write `.scratch/<card>/report.md`, plainly, through the unslop skill:

```markdown
# <the question>

**Answer:** <one or two sentences>

## Findings

- <claim> (<citation: file:line, commit, ADR, issue, link, log path>)

## Options

<when the card asks what to do: each option, its cost and risk, the one you recommend and why>

## Spike

<when there is one: the branch, what it tried, what it showed>

## Open

<what is still unknown, and how to find out>
```

Every claim has its citation; a guess is written as one ("not confirmed: …"). Keep it to what the card asked.

## 4. End the run

End the step with `.scratch/<card>/report.md` as its report (`PROTOCOL.md`, End the run). Abe keeps the report on the run's Run page and the run ends (its workflow's `ends:`).

## Completion

Done when the report answers the card's question with every claim cited, any spike branch is pushed and named in the report, and Abe answered `ok` to the step's end.
