# Abe

The `abe` command and `abe serve`, the one long-running process that VimStorm, the agents and your scripts all talk to. Every action is `abe <noun> <verb> [--json]`, and `abe help` lists them.

```sh
cd abe && bun install
bun test                  # every package's tests
bun run typecheck         # strict tsc: the workspace, plus core and ui with no Bun/Node types
bun run lint              # eslint (type-aware) + prettier --check; lint:fix rewrites
bun run check             # all three
bun run build             # dist/abe-darwin-arm64, dist/abe-linux-arm64 (bun build --compile)
bun packages/serve/src/main.ts help   # the CLI from source
```

The reference is in [docs/reference](../docs/reference/README.md).

- [Abe](../docs/reference/abe.md) covers packages and import rules, the CLI contract, the command table, adding a command, event or port, [tests](../docs/reference/abe.md#tests).
- [Settings and logins](../docs/reference/settings.md), [the board](../docs/reference/board.md), [sessions](../docs/reference/sessions.md), [the Factory](../docs/reference/factory.md), [abe install](../docs/reference/factory-install.md), [verify and prototypes](../docs/reference/verify.md), [triage and Improve](../docs/reference/triage.md).
- [Boxes](../docs/reference/boxes.md) and [sessions in your environment](../docs/reference/cloud-sessions.md).
- The screens VimStorm draws are in [the shell bridge](../docs/reference/ui-bridge.md), [the Board's](../docs/reference/ui-board.md) and [Chat's](../docs/reference/ui-chat.md).
