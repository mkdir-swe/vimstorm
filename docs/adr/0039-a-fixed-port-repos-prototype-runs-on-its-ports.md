# 0039 · A fixed-port repo's prototype runs on its own ports

Status: accepted, 2 Nov 2026. This Mac only: a prototype on a box runs as before. Supersedes, for a repo whose app takes fixed ports, the prototype proxy as the preview link and the `prototype-start` hook as its start (abe/README.md, Prototypes). Supersedes ADR 0018's PT2 (never changes the backend) for every prototype. Amends ADR 0032: a prototype's worktree clones `node_modules` and does not link them. Amended by ADR 0041: the in-app Preview opens the app as a browser would.

A prototype ran in its `proto/…` worktree, its app started behind the prototype proxy on ports from `ABE_PORT_BASE`. That failed a repo whose app takes fixed ports:
- The frontend sits on `:4000` because the auth provider only redirects back to that origin. Behind the proxy, on another port, sign-in never came back.
- It could not run while the main checkout's app held `:4000`.
- A new worktree had no `node_modules` of its own: links into the main checkout, which some dev servers (vite) refuse to serve from, or a full install.
- The session was jailed like a card's, so the person's Figma server was off unless `session.mcp` said `yours`.

**A fixed-port repo's prototype starts the normal way.**
- Its code stays in its own worktree. Its app starts there by the repo's `start` hook, as `abe run start` does: backend and frontend, on the repo's real ports, with dev's Abe env file. Its `ABE_PORT_BASE` is still handed on for a backend that listens there.
- There is no proxy. The preview link is the app's own URL, the start's last stdout line (`http://localhost:4000`).
- A repo has fixed ports when `abe.yaml` says `ports.fixed`, or its install read them fixed. Any other repo keeps the proxy and `prototype-start`. Its ports never clash, and the proxy's log of what the page reached stays.
- Backend changes are allowed in any prototype. The database is whatever the start hook gets (a shared dev database, for a repo whose pack names none). The session is told never to migrate or change the schema: a field the design needs is mocked in the backend's response.

**Abe owns the main checkout's app.**
- The main checkout's app is the Abe chat's `abe run start`. A card session's app is held the same way: serve knows which session holds a repo's fixed ports (`LocalApps`).
- Starting or showing a prototype stops the app on the ports with its own `stop`, and the prototype's starts. Abe keeps how that app started: its script, arguments and environment.
- When the prototype stops or is discarded, Abe starts that app again the same way, if its session still runs.
- An app Abe did not start (a terminal's dev server) is never stopped. The prototype's start fails and says which port is in use and how to find what holds it.

**One prototype holds the ports at a time.**
- Starting or showing another stops the current one's app. Its worktree, chat and database are kept.
- Each prototype tile says whether its app runs (`Local · on :4000`) or not (`Local`).
- A restart keeps the ports. The last prototype to stop hands them back to the main checkout's app.

**Every prototype's packages on this Mac are cloned.**
- Before its session starts, every `node_modules` of the main checkout that lies in no other `node_modules` is cloned into the worktree at the same path. The clone is copy on write: APFS `clonefile(2)` of the whole folder, else `cp -cR`, else a plain copy.
- A clone keeps links as they are. So a workspace's relative link (`node_modules/@shop/ui → ../../packages/ui`) resolves inside the worktree. Nothing in the worktree points into the main checkout.
- When the worktree's manifests (each tracked `package.json` and the lockfiles beside it) differ from the main checkout's, the lockfile's install runs there (`npm install`, `pnpm install`, `yarn install`, `bun install`), its network the package registries only. The same check runs before each start, so a dependency the prototype adds is installed then.

**Every prototype session on this Mac loads the person's Figma server**, whatever `session.mcp` says. It is the server in their Claude Code config named `figma`, or one reaching Figma's MCP host. Their other servers still follow `session.mcp`. The session is told to read a Figma link's design through it (design context, screenshot) and build it with the repo's own components and tokens.

Target: under 10 s from `prototype start` to the page answering on its port, not counting the agent's own work. Then the dev server's hot reload takes over. Measured on the fixture shop with 2,000 to 70,000 files in `node_modules`: 1.1 to 1.5 s (`serve/src/prototype/code-prototype.test.ts`).

Considered:
- **The proxy on the fixed port.** The proxy would take `:4000` and forward it. But the app's own dev server still needs a port, its HMR socket and cookies are tied to the origin, and the main checkout's app still holds `:4000`.
- **The direct start for every repo.** It is simpler, but two prototypes of a repo with free ports could no longer run side by side. That repo would also lose the proxy's log of what the page reached.
- **Link `node_modules` from the main checkout, as a card does.** A workspace's links then point into the main checkout. Vite also refuses to serve files outside the worktree's root. `cp -cR` alone took 11 s for 70,000 files; one `clonefile(2)` of the folder took 2.5 s.

Known limits:
- ~~The in-app Preview stays locked to the app's origin.~~ Superseded by ADR 0041: the Preview opens the app on its fixed ports as a browser would (its backend, the auth provider's sign-in and back), its cookies kept on disk.
- Which session holds the ports is known only while serve runs. After a serve restart, an app it started before is found only as a port in use, and the prototype refuses to start.
- A clone is per file system. When the worktree is on another volume, the plain copy is slower.
