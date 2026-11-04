# 0013 Abe in TypeScript on a Rust shell

Status: accepted for 2.0 (design), 22 Oct 2026; 1.0 unchanged. Supersedes, for 2.0, ADR 0002's native Rust core (`abe-core`, `abe-ports`) and its rejection of a TypeScript sidecar. Built: since 26 Oct 2026 the Rust core is deleted and no Abe logic is left in Rust.

Rust is the native shell: drawing, Neovim, the terminal, git data, keys and the browser view. TypeScript is all of Abe: the Factory, the Decider, the rules, agent launch, Azure / GitHub / AWS, skills and scripts.

- T1: the split above. Nothing of Abe's logic stays in Rust.
- T2: Abe runs as one Bun process beside the app, talking to it over the existing single-instance socket.
- T3: Abe's screens are described in TypeScript as a tree of design-system components; Rust draws a fixed, closed set of those components. A UI change needs no Rust rebuild.
- T4: 2.0 Abe starts from old TS Abe (a separate repo, retired 25 Oct 2026) where it fits. 1.0's Rust Abe stays untouched until 2.0 replaces it.
- T5: Abe's tests are `bun test`.

## Why

- All code the owner needs to understand is TypeScript.
- Rust's compile, build and test are what is slow; Abe changes far more often than the shell.

## Consequences

- `abe-core` and `abe-ports` are kept for 1.0 only and are not extended toward 2.0.
- The component set is a contract between the two sides: a new kind of component is a Rust change, a new screen is not.
- The shell keeps its cargo tests for what it draws; Abe's rules and flows move to `bun test`.

## Shell language (decided 22 Oct 2026)

The shell stays Rust (GPUI) and stays thin: the editor grid, the terminal, drawing, keys, the closed component set, the browser view and the Bun bridge. Rust is too verbose for agents to write quickly, so everything that changes often moves to TypeScript and new Rust is written only when a component is added. Considered and rejected: a webview shell (Tauri / Electron, UI in TS/HTML: fastest to write but less native and snappy; kept as the fallback), Swift / AppKit (shorter than Rust but a full rewrite and macOS only) and Go / Zig (no mature native UI). Estimate at the time: the ~98k-line IDE shell stays, ~10–15k Rust is added once, the ~134k lines of Rust Abe leave 2.0, and 2.0 Abe is ~60–80k lines of TypeScript plus tests, 40–50% adaptable from TS Abe.
