# 0009 Tracking on GitHub, Evidence local

Status: accepted for 2.0 (design), 22 Oct 2026; 1.0 unchanged.

Tracking (specs, issues, sub-issues, pull requests, decisions) is always on GitHub, never local. Evidence (screenshots, verification reports, scratch report files) is always local: per card under `.scratch`, git-ignored, disposable, read as markdown in Abe. Before/after images never go to GitHub.

- The pull request carries the result: one verification line (including the regression tests run) and a Notes section of at most five bullets. A big decision gets an ADR; an important small one a short "we saw X, did Y" in Notes.
- The Decider sets the verification level: None, After, or Before+after. Before is taken only when needed (a bug's reproduction) on the merge base with the same steps; a bug that does not reproduce there goes to Needs you.
- Verification uses whatever fits: the browser (one Chrome per workspace through chrome-devtools-mcp, its screen live in a VimStorm tab), database look-ups, APIs, logs. Agents can read all of it (ADR 0010).
- Amended 23 Oct 2026: no evidence branch. Cloud work's Evidence stays in your environment's `.scratch` (ADR 0016), read in VimStorm over the attach; verification's Chrome runs in the session's container, streamed to a tab. Deterministic checks run before verification (ADR 0008).
