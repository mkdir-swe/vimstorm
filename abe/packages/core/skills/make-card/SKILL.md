---
name: make-card
description: Drafts a card for the board (title, Why, What, acceptance criteria) from what the person said, a conversation or a prototype, and makes it. Use for /abe:make-card in the Abe chat or a prototype session, and as Abe's card-draft one-shot.
---

# Make card

A card is what a developer (or a run) reads to build something. Draft it from what you have: the person's words, this conversation, or the prototype this session built.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## The card

- **title**: what the user gets, in at most eight words, no trailing full stop (`Show VAT under the cart total`).
- **why**: one or two sentences: who needs it and what goes wrong without it.
- **what**: one to three sentences: what changes on screen and in behaviour, in the person's words.
- **criteria**: one observable behaviour each, checkable by looking at the app (`The VAT line shows the market's rate`). Three to six. No implementation, no "should".

From a prototype, read the diff for what it means to a user, not for how it is coded: the prototype is a mock-up of an idea, not the code to ship. Say what the app does, never which selector or file.

## Making it

- **In the Abe chat**: show the person the draft in a few lines, then make the card from a description file (`PROTOCOL.md`, Making it): the file holds `## Why`, `## What` and `## Acceptance criteria` with one `- [ ]` per criterion. Say its number.
- **In a prototype session**: keep a screenshot of what matters first, write the same description to a file, then make the card from the prototype (`PROTOCOL.md`, Making it). Abe adds the `## Prototype` section and keeps your diff and screenshots in the org store as the card's reference: every run of the card reads it. Say the card's number; the person launches it from the Abe chat or the Board.
- **As a one-shot** (Abe's card draft): answer only the JSON asked for.

## Writing

Plain, short and specific. Write it the way the person would say it to a developer:

- Every sentence carries a fact. Drop filler (`This feature will`, `In order to`, `It is important that`), hype (`seamless`, `robust`, `enhance`) and hedges.
- Active voice, present tense, the user as the subject where you can.
- One idea per sentence; prefer a list to a long sentence.
- No em dashes, no exclamation marks, no emoji.
- The person's language: write in the language they wrote in.

When the person asks for changes, keep everything they did not ask to change, word for word.
