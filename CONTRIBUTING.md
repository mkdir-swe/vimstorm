# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or an idea

Open an issue with the Bug or Idea form. For a bug, include `abe --version`, `abe status` and what `abe tools check` and `abe settings problems` say, and check that nothing you paste holds a token, an account id or a private name.

## Sending a pull request

There is no CLA and no sign-off: by sending a pull request you offer it under the [Apache-2.0 license](LICENSE) (its section 5).

1. Fork, then branch from `main`.
2. Read [AGENTS.md](AGENTS.md): how the code is laid out and the rules it keeps. It is written for coding agents and people alike. The terms are in [GLOSSARY.md](GLOSSARY.md); a change to something an [ADR](docs/adr/) decided starts with that ADR.
3. Keep a pull request to one change, with its tests (a row in the module's existing table test, not a new file).
4. Run the checks for what you touched (below). CI runs the same ones.

### Commits

One line, no trailers: `<Summary>. (#N)`, with the issue number when there is one.

```text
Show the box's release in the Boxes tab. (#42)
Fix a typo in the cloud guide.
```

### Checks

```sh
cd abe && bun install && bun run check     # typecheck, lint, every test
cd app && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings
cd app && cargo test --lib --bins          # the app's unit tests
```

The app's window tests (`cargo test --test app`, `--test perf`, `--test theme`) and the Lua engine tests (`tests/run.sh`) need a real Neovim with the app's plugins (`app/scripts/warmup.sh` once). Run the modules you touched, for example `cargo test --test app tree::`. Tests never use your own Abe state, settings or logins: see [the reference's tests section](docs/reference/abe.md#tests).

TypeScript is strict, with no `any`. Text in the app follows the [reference](docs/reference/README.md): update it when you change what a user sees or types.

## Security

Please report a vulnerability privately through GitHub's "Report a vulnerability" on the Security tab, not in an issue.
