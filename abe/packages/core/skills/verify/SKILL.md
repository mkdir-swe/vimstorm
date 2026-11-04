---
name: verify
description: Verifies a change at the level it picks from the spec and the diff (none, After, or Before on the merge base then After) by driving the features it touches through the repo's Verification pack (its verify-<app> skill, headless Playwright for a web app), keeps the proof each driven feature's surface asks (a screenshot and a recording, or a transcript) as Evidence under `.scratch/<card>/`, and records each phase with Abe. Use at the Factory's verify stage, or when asked to verify or show that a change works.
---

# Verify

Verification is the proof a change works where it shows: in the browser, an API answer, a database row, a log line. You pick its **level** yourself, from the spec (or the card) and the diff since the merge base:

| Level        | When                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None         | Nothing to observe beyond the checks: the change keeps behaviour the same (a refactor, tooling, docs). Record an After pass whose report says so and lists every feature as not driven, with why. |
| After        | The change adds or alters behaviour that shows somewhere: a screen, an API answer, a row, a log line. One phase, on the card branch.                                                              |
| Before+after | The change's point is a difference from today (a bug, a regression, a slow path) and no reproduce step ran before it: Before on the merge base, then After with the same steps.                   |

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

In a Bug run the reproduce step did Before already (`.scratch/<card>/verify-before.md`, its steps in `.scratch/<card>/verify-steps.md`): run After only, with those steps. Say the level and why in the After report's first line.

Everything this skill makes is **Evidence**: it stays in `.scratch/<card>/` of the card's worktree, never in a commit, a comment or the pull request. Each driven feature's screenshots and recording go in `.scratch/<card>/verify/evidence/<feature>/`, other outputs in `.scratch/<card>/verify/evidence/`; Abe keeps its own numbered copy of each report directly in `.scratch/<card>/verify/`, so write nothing else there.

## 1. Plan the steps

Read the repo's **Verification pack**: its skill `.claude/skills/verify-<app>/SKILL.md` (`<app>` the checkout folder's name: how to launch, a doctor check, how to drive the app, the evidence to keep, cleanup), and its **Feature map**, `features/README.md` with one file per feature. Then read the card's acceptance criteria (`PROTOCOL.md`, Plan the steps) and the diff since the merge base.

Pick the features the change touches: a mapped feature whose user path, screens, endpoints or end state the diff reaches. Every other mapped feature is **not driven**, with the reason (the diff reaches none of its code, or what else keeps it out).

Write the steps to `.scratch/<card>/verify-steps.md`: one numbered step per acceptance criterion, each saying which feature it drives (or where else it is checked: an API, the database, logs, a test), what is done, and what result means it holds. Take each feature's recipe from its file in the map, not from memory.

A change to data (the rows a page, a report or an answer shows: a new column, a filter, a join, a mapping) adds data steps beside the drive: its queries in every environment the run reaches, dev, test, and prod when prod is on for this run (`PROTOCOL.md`, Plan the steps). Prod shows the change's real reach (how many rows, per market, which values are empty or placeholders), so when prod is on it is never left out, and a card or spec that names prod (its done-when, a criterion) has that step on prod. A data step gives each environment's result side by side. What prod can't show before the deploy (a column the change adds) is checked on the data it is built from there, and the report names what is left for after the deploy.

Risky work (money, authentication or permissions, a migration or a delete, a contract other systems read, anything a revert cannot undo: you judge it from the diff) adds a regression step: the tests and checks that cover the other flows the change reaches, named one by one.

Done when every acceptance criterion has a step with its expected result, and every mapped feature is either driven by a step or listed as not driven with why.

## 2. Before (Before+after, when no reproduce step ran)

Make a worktree at the merge base of the card branch and the default branch through Abe (`PROTOCOL.md`, Before). In that worktree, launch the app the way the pack's Launch says, using the merge base's own `.claude/skills/run-app/scripts` and pack. Drive the steps that show the problem, exactly as written, and save their Evidence under `.scratch/<card>/verify/evidence/<feature>/before-*` in the card's worktree (absolute paths, so nothing lands in the base worktree). Clean up the way the pack says.

Write the Before report, `.scratch/<card>/verify-before.md` (below), then record it from the card's worktree (`PROTOCOL.md`, Before).

At Before, a pass means the problem reproduced as the card says. When it did not, record it not reproduced, with what you tried in the report: the run stops at Needs you, and the work goes no further until the person answers. A not reproduced is taken only once you also looked with the session's browser (below), and, for a bug in data, for the rows it happens to with the repo's data route (the `run-app` skill's `query`); without them the run says the verdict is inconclusive. When the app or a step cannot run on the merge base at all, record a fail with what broke: the run stops at Needs you too.

## 3. After

In the card's worktree, launch the app the way the pack says and run its doctor. Drive each touched feature by its recipe, one at a time, saving a screenshot of the end state that proves it and a recording of the drive in `.scratch/<card>/verify/evidence/<feature>/`, and noting for each the page's URL (from the browser) and the account it was signed in as (the role or test user's name the run-app sign-in used, never its password or token) (a feature with no UI, `surface: cli` or `api` in its feature file's front matter or else its pack's: a text transcript, request/response or step log, `.txt`, `.log`, `.cast` or `.json`, a recording optional). Clean up when done. For risky work, run each regression step and note each test or check by name with its result.

With a **prototype reference** (`.scratch/<card>/prototype/screenshots/`): compare each After screenshot with the prototype's of the same screen, and say in the report where it differs on purpose (the spec decided otherwise) and where it does not.

Write the After report, `.scratch/<card>/verify-after.md`, and its HTML twin for the Run page, `.scratch/<card>/verify-after.html` (see "The HTML report"; required when the repo has a Feature map), then record the After with both (`PROTOCOL.md`, After).

Risky work names the regression tests run in the record. A step that failed records a fail: the run goes back to build, and the report says which step failed and what was seen, which is what the build fixes. A pass moves the run on to `pr`.

A pass is refused while the report's `## Features` can't stand (when the repo has a Feature map): a mapped feature it does not list, one the map has not, a verdict with no `Judged by:`, a driven feature without its surface's proof there (a screenshot and a recording for `web`, a transcript for `api` or `cli`), a not driven one with no reason; and while its HTML report is not given or does not say the same verdicts (a feature with another verdict, or in one but not the other, each named). `PROTOCOL.md`, After, names each refusal. Fix the report or drive what it lacks, then record it again.

**A feature you can't prove as refused.** Every way out records verify:

- Driven with no browser (an HTTP endpoint, a command) in a web pack: add `surface: api` (or `cli`) to that feature file's front matter, commit it on the card branch, and record again; its transcript proves it. Say so on the report's `Pack:` line. When git holds the pack out (below), you can't: take the next way and write the change on the `Pack:` line.
- Truly not drivable or provable here: list it `not driven` with why, and record the result the rest shows. The run moves on; the why shows on the Run page and in the pull request.
- Never ask the person to choose something that records nothing. When you need them, wait as Needs you (`PROTOCOL.md`, After) with options that each end in a recorded verify (declare the surface and record, record it not driven, record a fail back to build).

## Driving the app

Each command runs in a sandbox: an app started inside one command is gone, or out of reach, by the next, and no browser starts there. So run each of the pack's scripts through Abe's runner, which runs it outside the sandbox (in a box's workspace, or locally for a local session), where the app keeps running and its browser reaches it. `PROTOCOL.md`, Driving the app, says how to call it and what it answers; these rules hold however it is called:

- The pack's start, seed and stop (`.claude/skills/run-app/scripts/<name>`) run in the card's worktree; Before's by the absolute path of its script in the merge base's worktree.
- Another card's app may hold the repo's fixed ports. Wait (a few minutes, then start again) until it stops; never kill its processes.
- The pack's own helpers, `.claude/skills/verify-<app>/scripts/<name> <args>`, run the same way (Before's by its absolute path too). A web app's helper drives headless Playwright with its own browser, against the local app only: the URL the start script printed (its last line). Never point a drive at a deployed, shared or prod host.
- Drive only with the pack's helpers and the Playwright the pack pins (its helper installs that version in its own cache, outside every checkout). Never load Playwright, or any other code, from another checkout or a path outside the card's worktree, Before's and that cache: another checkout is unreadable to a local session, and its version is not the pack's. A step no helper covers goes into the pack's helper (a journey of its drive), fixed as below, never into a script of your own.
- One runner per run: one script at a time, one browser, one instance, locally and on a box. A second beside one still running is refused; wait for the first to end. The stop always runs.
- A start that warns compose publishes fixed host ports runs all the same; say it in the report, since two cards at once clash on those ports, and fix the pack (publish from `ABE_PORT_BASE`).
- A start that warns it started all the same means the app started against a backend nobody said is local or test, or with cloud credentials: show the person that line as it is, before anything else, and say in your report that it ran so.
- The pack's scripts get the session's database (`DATABASE_URL`), its port base and no token; locally also the dev Abe env file's values (`.abe/abe.dev.env`) and its aws profile's short-lived keys, or test's when run with test's env (then no database of Abe's). A script that runs docker compose runs it in the card's own project (`COMPOSE_PROJECT_NAME`: its own containers and data, the ports inside as the compose file has them), on the local Docker only: a remote `DOCKER_HOST` or docker context is refused (tell the person; never point it elsewhere), and the card's end takes its project down. On a box the box runs it (no Docker in the workspace): the services are reached by their names, the workspace joined to their network.
- Stop the app with the pack's stop: whatever a session's scripts left running is stopped when the session ends anyway, so never `kill` or `pkill` it yourself. Check the app through the pack's drive and scripts, not with a `curl` of your own.

## The session's browser

For a not reproduced at Before (a bug that shows in the app), also look with the session's own headless browser: Abe starts it (one per session, in your run's browser profile, signed in already when the run names one; `PROTOCOL.md`, The session's browser), and your `chrome-devtools` tools drive it (`navigate_page` to the URL start printed, `take_screenshot` with `filePath` an absolute Evidence path in the card's worktree). A start refused for the browser profile is a step a person must fix: wait as Needs you with what it said. When the tools cannot connect to Chrome, it is not running: start it again. Recording the After pass, or a Before that did not reproduce, stops it; else stop it yourself.

## A stale pack, a changed feature

When the change alters a mapped feature (its user path, screens or end state, or a feature it adds or removes), run the **maintain-verification-skill** skill on the card's branch after the After drive: it fixes `verify-<app>` and its Feature map and commits on the card branch, so the fixes ship with the card's pull request; it opens no pull request of its own. When a step of the pack is simply wrong (a script that moved, a command that changed), do what works, then fix that step in `verify-<app>` and commit the fix on the card branch. Either way, say so in the After report's last section, so the pull request's Notes carry it.

When git holds the pack out of the card's commits (`git ls-files -v .claude/skills` shows `S`, or `git check-ignore -q .claude/skills` succeeds: the card's worktree holds the main checkout's working copy of it), a fix to it ships with nothing: change nothing in that copy, run no maintain-verification-skill, and write the fix on the `Pack:` line as a change for the main checkout's pack (`.claude/skills/verify-<app>/` there), each step and what it should say, so the person makes it there.

## In a subagent

This skill works the same when the Factory runs this stage in a subagent: everything goes through Bash and Abe's commands. Ask nothing directly; when you need the person, wait as Needs you (`PROTOCOL.md`, In a subagent). maintain-verification-skill's source readers are its own subagents only where you can start one; otherwise read each feature's source yourself, one after another.

## The reports

Evidence is named by its path from `.scratch/<card>/`.

`.scratch/<card>/verify-before.md` (Before+after only):

```markdown
# Verify before: AB#<id> <title>

Merge base <short sha>

1. <feature or where>: <what is done> → <what was seen> · verify/evidence/<feature>/before-1.png

Result: reproduced | not reproduced (<what was tried>)
```

`.scratch/<card>/verify-after.md`:

```markdown
# Verify after: AB#<id> <title>

Level: None | After | Before+after (<why, one line>) · <branch> <short sha> · Risky: yes | no

1. <feature or where>: <what is done> → <what was seen> · verify/evidence/<feature>/after-1.png · ▶ 0:03

Result: pass | fail (step <n>: <what was seen>)

## Features

- `<feature>` pass. Judged by: <what was seen that proves it, and how it was checked>. Evidence: verify/evidence/<feature>/after-1.png, verify/evidence/<feature>/drive.webm. Where: local | dev | test · <url> · as <account>
- `<feature>` not driven. Why: <the reason>

## Regression

- <test or check name>: pass | fail

## For the pull request

**Verified:** <one line: the level, which features were driven and how, the regression tests for risky work>
Pack: <what maintain-verification-skill or a fix changed in `verify-<app>`, or nothing>
```

`## Features` lists every mapped feature once, by its file's name in the map: a driven one with its verdict (`pass` or `fail`), how it was judged, its Evidence (its surface's proof: a screenshot and a recording for `web`, a transcript for `api` or `cli`) and, for `web`, where it was driven (`Where:` the environment, each page's URL, the account), as its HTML section says; one not driven with why. Abe adds a `Browser profile: <name>` line under each report's title in its copy.

Every claim points at its Evidence file or the command whose output shows it. The After report's steps are numbered as the acceptance criteria are, one each, in their order: the Run page and the pull request's `## Proof` read step N as criterion N's proof (the command's output or HTTP answer that shows it, in a fenced block right under the step; its screenshot; its chapter `▶ m:ss` in the recording when there is one). `## Proof` also says where each feature was driven, from the HTML report's `data-env`, `data-url` and `data-account`. A step that failed starts `✗` or is named by the Result line.

## The HTML report

The Run page draws Verify's step from an HTML fragment built only from the verify kit's parts. Abe sanitises it: it keeps those parts and strips everything else (scripts, styles, `on…` handlers, other attributes and classes, other tags with their content, any source that is not a file of this run's Evidence). Write one `<section>` per mapped feature, in the Feature map's order, saying what `## Features` says: the same features, each with the same verdict, or the pass is refused:

```html
<section class="ab-verify-feature" data-feature="cart" data-verdict="pass" data-env="local">
  <h4 class="ab-verify-head">Cart total follows quantity</h4>
  <div class="ab-verify-pair">
    <figure class="ab-verify-shot" data-url="http://localhost:5173/cart" data-account="buyer">
      <img src="verify/evidence/cart/before.png" alt="The cart on main" />
      <figcaption>Before, on main: three mugs, the total counts one.</figcaption>
    </figure>
    <figure class="ab-verify-shot" data-url="http://localhost:5173/cart" data-account="buyer">
      <img src="verify/evidence/cart/after.png" alt="The cart on this branch" />
      <figcaption>After, this branch: the total counts three.</figcaption>
    </figure>
  </div>
  <figure class="ab-verify-recording" data-url="http://localhost:5173/cart" data-account="buyer">
    <video src="verify/evidence/cart/drive.webm" poster="verify/evidence/cart/after.png"></video>
    <img src="verify/evidence/cart/drive.gif" alt="" />
    <figcaption>Playwright raises the quantity 1 → 3; the total follows.</figcaption>
  </figure>
  <div class="ab-verify-judged">
    Read the total from the page after each change: each equals price × quantity + shipping.
  </div>
</section>
<section class="ab-verify-feature" data-feature="cli-export" data-verdict="pass">
  <h4 class="ab-verify-head">Export writes the totals</h4>
  <figure class="ab-verify-transcript" data-src="verify/evidence/cli-export/run.txt">
    <figcaption>The export script, its output</figcaption>
  </figure>
  <div class="ab-verify-judged">The last line holds 86.97, the cart's total.</div>
</section>
<section class="ab-verify-feature" data-feature="search" data-verdict="not-driven">
  <h4 class="ab-verify-head">Search</h4>
  <p class="ab-verify-not-driven">The diff touches no search code.</p>
</section>
```

- `data-feature` is the feature's file name in the map; `data-verdict` is `pass`, `fail` or `not-driven`; `data-env` is where the app ran: `local` (its own database), `dev` or `test` (a script run with test's env).
- Where each proof was taken, required on every shot and recording of a `web` feature: `data-url`, the page's URL as the browser showed it (`http` or `https`, no sign-in in it, at most 500 characters), and `data-account`, who the browser was signed in as: the role or test user's name the run-app sign-in used (`buyer`, `admin`), never a password or token, at most 80 characters. The Run page draws both under the shot, and `## Proof` names them.
- Parts, each optional, in any order: a before/after pair at Before+after only (`ab-verify-pair`, two shots: Before's `before-*` screenshot from the merge base first, then After's; a pair whose first shot is not a `before-*` one is drawn as two shots, so two After shots are two `ab-verify-shot`s), a single shot (`ab-verify-shot`), a recording (`ab-verify-recording`), how it was judged (`ab-verify-judged`), why it was not driven (`ab-verify-not-driven`), and for a feature whose surface is `cli` or `api` a transcript (`ab-verify-transcript`, its file in `data-src`; never paste its text).
- Every `src`, `poster` and `data-src` is a path from `.scratch/<card>/` to a file you saved there: no URLs, no absolute paths, no `..`. An image is `.png`, `.jpg`, `.webp` or `.gif`; a recording `.webm`, `.mp4` or `.mov`; a transcript `.txt`, `.log`, `.cast` or `.json`.
- A recording's `.gif` plays in place on the Run page, with pause; without one its control opens the video in the local player. When `ffmpeg` is there, make it from the recording's telling moment, 20 seconds at most: `ffmpeg -y -ss <start> -t 20 -i drive.webm -vf "fps=6,scale=720:-1" drive.gif` (`-ss` where the change shows; leave it out to start at the top). A longer GIF is too big to play in place: the Run page shows its still and Open video instead.
- Words go in the parts only, plain or with `code`, `strong`, `em`, `p`, `br`. No `style`, no other classes, no links.

## Completion

Done when every step from step 1 has a result and its Evidence in `.scratch/<card>/verify/evidence/`, the After report lists every mapped feature under `## Features` and its last section holds the `**Verified:**` line, its HTML twin has a section per mapped feature with its `## Features` verdict, the browser and the app the pack started are stopped, and Abe has answered `ok` to the After's record (or to a Before recorded not reproduced).
