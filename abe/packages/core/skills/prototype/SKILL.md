---
name: prototype
description: 'Build a throwaway prototype in real code to answer a design question: whether a state model or logic feels right, or what a UI should look like. Use for /abe:prototype <idea> in the Abe chat (it starts a prototype session), and inside that prototype session, where nothing ships.'
metadata:
  upstream: 'mattpocock/skills@59db609 skills/engineering/prototype (runs in a proto/ worktree and never ships; captured as screenshots and made into a card, not a throwaway branch)'
---

# Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## In the Abe chat: start one

Invoked here as `/abe:prototype <idea>`, you do not build it yourself:

1. Start a prototype session through Abe, with the card when the idea is a card's (`PROTOCOL.md`, In the Abe chat). It starts where cards run (`serve.target`): on this machine in a throwaway worktree, with the app started from it; or on the repo's box in a workspace of its own, where the session starts the app.
2. Say in one or two lines: the prototype opens as its own chat beside this one, where the person talks to it.
3. The app takes a while to start: wait until Abe lists it as live (or failed: say its reason; stopped: it was stopped or discarded, so stop waiting), then give its preview link (on a box: its app's port forwarded to this machine).
4. A card of a prototype on a box is made here, from the prototype's id: Abe reads its diff from the box (`PROTOCOL.md`, In the Abe chat).

## In the prototype session: build it

You write it in a throwaway worktree (or a box's workspace clone) on a `proto/<card or id>-<slug>` branch off the default branch. The branch has no upstream and a pre-push hook that refuses: nothing you write is pushed, opened as a pull request or merged. On this machine the worktree has the main checkout's packages (cloned; a dependency you add is installed at the app's next start), and the app runs from it: for a repo whose app takes fixed ports, the normal way by its start on those ports, its own URL the preview link (the main checkout's app is stopped meanwhile); else by the repo's `abe/scripts/prototype-start` (or the Verification pack's start), behind the prototype proxy (Abe's prototype list gives the preview link); on a box you start that script through Abe, with test's env when its `# abe-env:` line says test, and the pack's start when the repo has none (`PROTOCOL.md`, In the prototype session), and the person's machine forwards its port. When it does not start, the script is the repo's to fix: tell the person, and the Abe chat checks it. A dev server that reloads shows your edits as you save them.

Given a Figma link, read the design with the Figma MCP server (its design context and a screenshot of the node) and build it with the repo's own components and design tokens. Backend changes are fine; the database is not yours: never migrate it or change its schema, and mock a field it lacks in the backend's response.

## Pick a branch

Identify which question is being answered, using the idea, the card, the surrounding code, or by asking the person:

- **"Does this logic / state model feel right?"** → [LOGIC.md](LOGIC.md). Build a single shareable HTML file (free-play buttons plus tabbed guided walkthroughs) that pushes the state machine through cases that are hard to reason about on paper, and that a non-developer can drive. Put it where the app serves static files, so the preview link opens it.
- **"What should this look like?"** → [UI.md](UI.md). Generate several radically different UI variations on a single route, switchable via a URL search param and a floating bottom bar.

The two branches produce very different artifacts, so getting this wrong wastes the whole prototype. If the question is genuinely ambiguous and the person isn't reachable, default to whichever branch better matches the surrounding code (a backend module → logic; a page or component → UI) and state the assumption at the top of the prototype.

## Rules that apply to both

1. **Throwaway from day one, and clearly marked as such.** Locate the prototype code close to where it will actually be used (next to the module or page it's prototyping for) so context is obvious, but name it so a casual reader can see it's a prototype, not production. For throwaway UI routes, obey whatever routing convention the project already uses; don't invent a new top-level structure.
2. **Trivial to run.** The app's start script already runs it; a page you add is a URL under the preview link. A logic demo is a single HTML file. Either way, no thinking required to see it.
3. **No persistence by default.** State lives in memory. Persistence is the thing the prototype is _checking_, not something it should depend on. Never migrate the app's database or change its schema (it may be a shared dev database): a new field is mocked in the backend's response. If the question explicitly involves a database, use a local file with a clear "PROTOTYPE, wipe me" name.
4. **Skip the polish.** No tests, no error handling beyond what makes the prototype _runnable_, no abstractions. The point is to learn something fast.
5. **Surface the state.** After every action (logic) or on every variant switch (UI), print or render the full relevant state so the person can see what changed.
6. **Nothing ships.** Never push, never open a pull request, never end a Factory step (Abe refuses it). Committing is not needed; the diff against the default branch is what counts.
7. **Capture it when done.** Say the answer (the verdict and the question it settled) in the session. Keep what it looks like: a PNG screenshot of each variant or state that matters, kept with Abe with what it shows (`PROTOCOL.md`, Rules that apply to both). When the person wants it built, follow /abe:make-card: it makes a card whose runs read your diff and screenshots as their reference (the build is done properly, in the app's code). Discarding the prototype throws the worktree away.
