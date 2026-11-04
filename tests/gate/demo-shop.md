# Release gate · demo-shop

The 3.0 release gate (#352, #232): one tester's pass through the product on its own env, run by
`qarig gate <env> tests/gate/demo-shop.md` against the env's live app (the shots build of the
release commit). Each `## G<n>` step says what a person does and why; its ```gate block is what the
runner does (verbs: `app/scripts/qarig_gate.py`). `judge` rows are the tester agent's verdicts
(`qarig judge <env> <row> PASS|FAIL '<what was seen>'`); `agent` hands the keys to the tester agent,
who answers in its own words with `qarig do` and then goes on with `--from` the next step.

Two testers run it whole at the same time on real envs: `qarig up gate-A --real` and
`qarig up gate-B --real --seed-offset 100` (demo-shop's `board/seed.json` numbers its cards 101…,
so A's are 1xx and B's 2xx; the GitHub org, gate repo and AWS profile they run as come from
`app/scripts/qarig.local.toml`, untracked: copy `qarig.local.example.toml`). `{card:N}` is seed card N on the env's own board: a card of the other
tester's numbers showing is a cross-over. Keys are the ones the release
commit ships; when a key moved, fix this file in the release commit, never by hand during a run.

Pass: every row PASS (judge rows judged PASS), the same step sequence in A and B, zero hand fixes.

## G0 · Setup

The env is up (`qarig up`), the live app shows the Abe view (`qarig live <env> --abe`). The app and
its serve are the release version, nothing is red, Problems lists only the known fake-board rows.

```gate
run status abe status
expect status (?i)abe serve \d+\.\d+\.\d+-[0-9a-f]+
see G0 view title main status balloons
wait factory in view within 30s
wait error in balloons gone within 30s
run problems abe settings problems
snap G0
```

## G1 · A prototype from the Abe chat

`:chat` opens the repo's Abe chat in the Chat column; `/abe:prototype` there starts a prototype
session: its own chat beside the Abe chat (`Prototype · …`), the app started from its throwaway
worktree and the preview's address in its header once it is up. The session builds the wish.

```gate
# the Board in main (the main checkout, no story): `:chat` opens and pins the Abe chat
do {@:}{wait:300}{type:chat}{wait:300}{@enter}{wait:1000}
wait 'Local · no sandbox' in chat within 2m
do {@super+2}{wait:500}
type /abe:prototype a free-shipping banner on the cart
do {@enter}
wait 'Prototype' in chat within 3m
# the preview's address (the prototype proxy, on loopback) shows once the app is live
wait 're:127\.0\.0\.1:[0-9]+' in chat within 5m
wait 'Needs you' in chat within 10m
see G1-prototype chat
judge the prototype session in trees/G1-prototype.txt says it added a free-shipping banner on the cart
snap G1-prototype
```

## Save · Make card

Asked in the prototype session, Make card makes a New card from it. Its own step so a run can go on
`--from Save` on the prototype session already open.

```gate
do {@super+2}{wait:500}
type make a card from this prototype
do {@enter}
wait 'Needs you' in chat within 10m
run protos abe prototype list --json
expect protos "made":\s*\d+
```

## Made · The made card

The card Make card made: New, tagged prototype, its `## Prototype` section linking the prototype,
and no spec issue in the repo.

```gate
run cards abe card list --json
run protos abe prototype list --json
capture newcard protos "made":\s*(\d+)
run newcard abe card show {newcard}
expect newcard (?i)prototype
run issues gh issue list --state all
see G1 main chat status
snap G1
```

## G2 · Launch → merge

The new card's Action menu › Launch agent…: the Launch box preselects Feature (`on: default`), the
launch note, ⏎. Each step within its budget and no other Needs you: launch (the tester's own box),
create-specification's questions in the run's Chat, the tester agent answers, the spec, its tickets,
build → checks → review → verify → PR → merge, the card in Done.

```gate
# the prototype session's chat has the keys: Esc gives them back, then `:board` shows the Board in main
do {@escape}{wait:300}{@escape}{wait:300}{@:}{wait:300}{type:board}{wait:300}{@enter}{wait:1000}
wait factory in view within 10s
wait BoardColumn in main within 10s
see G2-board view main status
# Make card's card is no one's: it shows on Team only: a click on the Team tab (Tab toggles, so not Tab), then filter
do {@click 139,50}{wait:500}{@/}{type:{newcard}}{@enter}{wait:500}
wait '#{newcard}' in main within 10s
# "Launch agent…" (the Launch box, takes the note), not "Launch agent" (launches at once: gate-A r3's note was lost, its ⏎ opened the story)
do {@super+enter}{wait:300}{type:Launch agent…}{@enter}{wait:500}
wait 'Launch' in layer within 10s
wait 'Feature' in layer within 10s
type keep the banner text editable
do {@enter}
wait 'Starting Claude Code' within 10m
snap G2-launch
wait 'Needs you' in chat within 15m
snap G2-questions
see G2-questions main chat status
agent answer each of create-specification's questions in Chat (the recommended answer unless it contradicts the prototype; once in your own words, to cover `o`); log each answer
```

## G3 · Spec and build

The questions answered: the spec naming the prototype and the launch note; the build runs through
its checks, review and verify to an open PR and the merge.

```gate
wait 'Spec' in chat within 30m
see G3-spec chat
judge the spec in trees/G3-spec.txt reads as the prototype's question answered and names the launch note
# a cloud run's Board card never says PR (its rail is the box's look): Chat's stage line does (gate-A r3)
wait 'to="PR"' in chat within 60m
run prs gh pr list --state all --json number,url,title
capture pr prs "number":\s*(\d+)
run pr gh pr view {pr} --json url,state,title
wait Merged within 30m
run merged gh pr view {pr} --json state,mergedAt
expect merged "state":\s*"MERGED"
run diff gh pr diff {pr}
judge the diff in runs/diff.txt contains the free-shipping banner
wait Done in main within 5m
run session abe session list --json
snap G3
```

## G4 · Reopen the finished session

Sessions (⌘5) › the finished session ⏎ (Reopen), a question: the same worktree and Claude Code
session as before, its transcript in Chat, an answer, no new session.

```gate
run before abe session list --json
do {@super+5}{wait:500}{@enter}{wait:1000}
wait 'Reopen' within 10s
do {@enter}
type what did you change?
do {@enter}
wait 'banner' in chat within 5m
run after abe session list --json
see G4 main chat status
judge runs/before.txt and runs/after.txt list the same sessions (worktree and Claude Code session id unchanged)
snap G4
```

## G5 · A teammate's change shows by itself

Sam moves story {card:102} to Active on the board and comments on the PR; nobody presses anything.
The Board shows it within 2 minutes while shown, Linked shows the comment; `drive.log` has no
refresh key in between.

```gate
# seed cards are no one's (Team only: a click on Team, as in G2; gate-A r3 sat on Mine); G2's `/` filter is still on (it would hide {card:102}): `/` then Esc clears it
do {@:}{wait:300}{type:board}{wait:300}{@enter}{wait:500}{@click 139,50}{wait:500}{@/}{wait:300}{@escape}{wait:500}
teammate azure move {card:102} Active --as noor
wait 're:BoardColumn #col:Active[^\n]*\n(?:\s+BoardCard [^\n]*\n)*?\s+BoardCard #card:{card:102} ' in main within 2m
# the PR comment after the Board check, so a run whose G3 captured no {pr} still checks the Board
teammate github comment {pr} 'looks good' --as noor
see G5 main status
do {@super+1}{wait:500}{@super+alt+a}
wait 'looks good' within 5s
snap G5
```

## G6 · Close-out

Down leaves nothing: no app, serve, fake, forward or tmux of the env, the box stopped, the repo copy
deleted, no serve appeared under the real HOME.

```gate
down
```
