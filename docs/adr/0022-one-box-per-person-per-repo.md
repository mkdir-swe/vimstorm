# 0022 · One box per person per repo, holding several workspaces

Status: accepted for 3.0 (design), 25 Oct 2026. Supersedes 0016's amendment "each workspace gets its own box" and 0021's one-box-per-workspace assumption; 0021's box layer (`abe box`, EC2, Instance Connect) stands.

A box is your machine for one repo. Every story you launch on that repo gets a workspace (worktree + session) on the same box; a second repo gets a second box.

**Why.** One box per card meant a cold boot, an image build and a full `node_modules` per card, and a bill per card. The owner's try-out (25 Oct): "1 box per card seems like overkill".

**Trade-offs.**
- Workspaces on one box share CPU, memory and disk: a heavy build slows the others. Resizing the box is the answer, not a second box.
- Sleep is per box: it sleeps only when none of its workspaces is busy.
- One box per repo keeps a repo's tools, caches and secrets apart from another repo's.

**Consequences.** The `abe:card` tag moves from the box to its workspaces; launch steps skip Box starting / Building image when the repo's box is up; Boxes lists boxes with their workspaces.

**3.0 amendments (26 Oct).**
- No `box: own` opt-out and no per-box card cap: a box short of memory asks at a launch (Resize / Launch anyway / Cancel), never a second box and never Queued.
- Cost is per box (compute plus its root disk, asleep too); each workspace shows a rough share by busy minutes.
- A run pins what ends it (auto merge, `factory.done`) at its start: workspaces on one box share the box's Layer, which each launch hands anew.
- Local mode uses no box: everything runs on the Mac.
- Your aws login is the box's, once, in the box host's `~/.abe/logins/aws`, used by Abe's own checks for every workspace there and never mounted into one (agents see only Reach).
