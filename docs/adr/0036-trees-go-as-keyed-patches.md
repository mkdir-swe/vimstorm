# 0036 · Trees go as keyed patches

Status: accepted, 31 Oct 2026. Changes ADR 0013 T3's contract on both sides: the bridge's frames, `UI_CONTRACT` 1 → 2.

ADR 0013 T3 has Abe describe each screen as a tree of design-system components, and the window draw that tree. Until now each change sent the slot's whole tree. A long Chat's tree is hundreds of KB, and it was sent again for each transcript entry. The window decoded every line whole, even when one turn had changed.

**Once the window holds a slot's tree, the bridge sends only what changed: a `patch` frame.**

- `{"v":2,"type":"patch","screen","rev","base","slot"?,"ops"}`. `base` is the rev of the `tree` or `patch` that gave the window the tree this patch applies to.
- `ops` apply in order. Each op is at a `path` of child indexes into the tree as the ops before it left it. It either puts a `node` in place of the node at that path, or splices that node's children (`splice: [from, remove]`, `add`).
- The bridge matches children by key: a child's `id`, else its kind. An entry appended to a long Chat is then one splice of one turn.
- The bridge walks into a node's children only for the kinds the window keeps children of (`PARENTS` in `ui/src/runtime/patch.ts`). Any other node that changed goes whole.
- A screen's first tree, another screen in the slot, and a change at the root go as a `tree` frame, as before.
- The window applies a patch on its bridge reader thread and hands the slot an ordinary tree, so nothing after the reader changes. The reader holds each slot's last tree.
- A patch whose `base` is not the tree held, or whose path is not in it, is not applied. The window sends `{"type":"again","slot"}`, and the bridge sends that slot's whole tree next.

**A version mismatch is refused, never half-drawn.**

- The bridge answers an app frame of any other `v` with `unsupported-version`, saying both versions.
- The window stops the bridge on a frame of another `v`, or on that refusal. It says why and does not restart it.
- A v1 window would read patches as unknown frames, and a v2 window can't take v1 trees as patches, so the two releases are updated together.

**The contract carries patches.** `abe/packages/ui/contract/patches/*.json` holds `{base, frame, want}` cases taken from real screens: a Chat growing by one entry and by several, the Board's tabs and filter, Sessions' filter, and Welcome's tabs. The TS contract test checks that each frame parses and gives `want`. The Rust contract test checks the same on the typed tree and on the JSON. Each side's parent kinds must agree, and these tests catch it when they don't.

Considered:

- **JSON Patch (RFC 6902) on the tree's JSON.** It addresses by array index and has no keyed matching, so a turn put in the middle would be seen as every later turn changed. It is also a generic format for a closed set the window already knows.
- **Each turn as its own frame with its own id.** That would mean a second addressing scheme beside the tree, and every screen that grows a list would have to split itself. Keyed matching gets the same effect from the tree as it stands.
- **Hash each subtree, and send only the subtrees whose hash moved.** Every frame would pay for hashing the whole tree. Comparing against the tree the bridge last sent costs about the same as serializing it once, which it did before anyway.

Known limits:

- Keys are ids, and a node without one is matched by kind. A list of unkeyed rows that shifts is sent as its changed rows.
- The bridge still views and checks the whole tree per step. The patch saves the line and the window's decode, not the screen's view.
