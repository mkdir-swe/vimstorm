# 0041 · A prototype's own app opens in the Preview as in a browser

Status: accepted, 3 Nov 2026. Amends ADR 0039 (its known limit "the in-app Preview stays locked to the app's origin" is gone). Sheets and the prototype proxy's Preview are unchanged.

A prototype of a fixed-port repo runs the person's own app on its real ports: the frontend on `http://localhost:4000`, its backend on another port (`:8888`), and sign-in through an outside provider. The provider's flow leaves the page at the top level (`https://<tenant>.<provider>/authorize…`) and comes back to `http://localhost:4000/callback`. The Preview, a BrowserView in `app` mode, blocked every load and navigation outside the page's origin. So the app could not reach its backend, and sign-in never came back (a spinner). The person had to open it in their browser (`o`).

**The Preview opens a prototype's app on its fixed ports as their browser would.**
- It is a BrowserView in `open` mode. It runs under no content rule list and no report script. The navigation delegate lets through any http(s) URL: the backend on another port, the provider, and the redirect back. A frame may also be `data:`, `blob:` or `about:`. Anything else (`file:`, `mailto:`, a custom scheme) is still told as blocked.
- The URL is used as given. `localhost` is never rewritten to `127.0.0.1`, since the provider redirects back only to that exact origin.
- The screen picks the mode. `prototype list` gives each prototype's `ports` (the fixed ports its app holds, ADR 0039). With some, the Preview is `open`; with none (behind the proxy, or on a box), it stays `app`.

**Its cookies are kept on disk, per origin.** An `open` page's WebKit data store is persistent and named by its origin (`vimstorm-open:http://localhost:4000`, as a stable UUID: `WKWebsiteDataStore dataStoreForIdentifier:`; before macOS 14, the app's default store). So the person signs in once. The sign-in outlives a reload, the Preview's close and reopen, the next prototype of the same repo (same ports, same origin), and the app's restart (a cookie with an expiry). A Sheet's page and an `app` page keep a non-persistent store each, never this one. When the same page changes to another store, it is made again.

**A popup loads in the same page.** `window.open` and `target=_blank` load in the Preview itself when the mode allows the URL, and are told as blocked otherwise. There is no second web view. A provider's redirect flow then completes in the Preview. A popup flow that posts back to its opener does not: use the redirect flow, or the browser (`o`).

Why: it is the person's own app, run from their own checkout's code, with the same trust as their browser, which opens the same URL unrestricted. The lock was there for pages an agent makes (Sheets) and for the proxy, which logs what the page reached. Neither applies to the app on its own ports.

Considered:
- **Allow-list the backend's ports and the provider's host.** But the provider's hosts are the provider's own (a tenant, its CDN, its fonts). They change, and are not in `abe.yaml`.
- **Open every prototype's Preview.** The proxy's log of what the page reached would then miss what the page fetched directly, and a box's app is not the person's own machine.
- **A second web view for popups.** It would be a window on top of GPUI's. A popup flow is rare next to the redirect flow, and the browser (`o`) handles it.

Known limits:
- The on-disk store is not deleted when a prototype is discarded. It is one store per origin, kept for the repo's next prototype.
- WebKit keeps the store under `~/Library/WebKit/<the app's bundle id>/`, not in VimStorm's state folder.
