# Notes for Claude sessions

## Check for an existing site map before mapping anything

The `api_*` tools write one bundle per site to `custom_apis/<slug>/` in this
repo (gitignored; override with `custom_apis_dir` in
`~/.config/chrome-controller-mcp/config.json`). **Those bundles are yours to
read.** Before you crawl a site, capture its traffic, or start reasoning about
its API from first principles, list that directory and see whether the answer
is already on disk:

```bash
ls custom_apis/
```

A mapping run costs minutes of live browsing and touches somebody's real
application under the user's own logged-in session. Re-deriving a map that
already exists is the expensive mistake here, not reading a stale file.

If a bundle for the site exists, read it first. No tool call and no browser is
needed; it is just JSON on disk:

| file | what it answers |
|---|---|
| `openapi.json` | The synthesized spec. Start here. Templated paths, inferred request/response schemas, security schemes. `x-observed: false` marks endpoints that were never actually called. |
| `endpoints.json` | The same catalog, richer: per-endpoint call counts, status codes, query params, auth headers, and where each was found. |
| `hosts.json` | Hosts and subdomains, with which source named each and whether it answered. |
| `requests/*.json` | Full request/response records: real headers, request bodies, response bodies, timing. The ground truth behind everything above. |
| `routes.json` | The crawl graph: pages visited, requests each fired, controls clicked. Earlier crawls are under `earlierRuns`. |
| `static/findings.json` | Every endpoint mined from the JS bundles, including the low-confidence ones the spec left out. |
| `screenshots/` | One PNG per crawled route. |
| `client/` | A generated client, if one has been written for this site. |
| `NOTES.md` | Hand-written notes for that specific API, if a session left any: auth mechanics, required-but-undocumented params, endpoints that lie. Read it before the spec; it holds what the tools could not infer. |

Use the bundle to answer questions directly. Only run the tools again when you
need something the bundle does not have: a route nobody crawled, a live value,
or a fresh capture because the site has changed since `session.json`'s
timestamp.

Two things worth knowing about the on-disk bundle:

- `api_spec` cannot be re-run against it. The spec is synthesized from the
  in-memory capture index, and the extension can only write files, never read
  them back (host→extension native messages are capped at 1MB). If the session
  is gone, the tool says so and the capture has to be re-run, but you can still
  read every file above yourself.
- **`auth.json` holds live, working credentials in plaintext**: session cookies
  and bearer tokens from the user's real browser session. That is deliberate, so
  a generated client works immediately. Never commit it, never paste it into a
  message, and never send it anywhere. Nothing under `custom_apis/` belongs in a
  repo.

## What a crawl cannot tell you

Learned while mapping a trading platform's web IDE. These are limits of the
approach, not bugs to fix:

- **A crawl maps the read surface, not the write surface.** It navigates and
  clicks, and the deny list deliberately skips anything labelled submit, delete,
  confirm or pay, so `create`/`update`/`delete` routes are largely invisible to
  it. On that site, the compile and file-read routes appeared in no fetched
  bundle and in no captured request, yet all of them worked.
- **If the site publishes API docs, the documented route names are a discovery
  source.** Private and public surfaces often share a router. Trying documented
  names against the captured session found the entire write path the map had
  missed. Do this before concluding an endpoint does not exist.
- **`static/findings.json` is a superset worth reading directly.** `api_spec`
  applies a score floor, so paths mined from JS but never called may be in
  findings and absent from `endpoints.json`.

## Endpoints lie in ways the spec cannot capture

An inferred spec records shapes that were *observed*. It cannot record these,
so when you find one, write it into the bundle's `NOTES.md`:

- **Required params that fail silently.** A missing param answering
  `success: true` with an empty list reads as "no data", not "you called it
  wrong".
- **Empty shells.** A response can carry the right keys with no payload, where
  the real data needs a second, different endpoint.
- **Silent downsampling.** Range/pagination defaults that return a token sample
  with nothing marking it as truncated.
- **Polymorphic fields.** The same key typed as a list here, a string there.
  Generic iteration over it produces nonsense rather than an error.
- **Endpoints that hang instead of answering** while server-side work is
  pending. Find the cheap status endpoint and poll that instead.

## The capture does not see everything the app does

`api_capture` records the HTTP request lifecycle. A modern app routinely moves
its most interesting traffic somewhere else, and the capture reports success
with the traffic simply absent, the same failure signature as a site that made
no requests. When a map looks implausibly thin for how much the UI clearly does,
check these before believing it:

- **Real-time push is invisible.** `resourceTypes` lists `WebSocket`, but only
  the HTTP lifecycle events are handled, no frame events, so socket traffic
  produces *no records at all*, not even the handshake. One IDE streamed every
  live result, log line and error over a push service; none of it appeared in a
  capture of more than a thousand requests.
- **The app may live in an iframe.** Run
  `document.querySelectorAll('iframe')` early. That same editor turned out to be
  a per-user hosted container in an iframe, authenticated by a query token
  instead of the session cookie: an entire API the tab-level capture was never
  going to describe.
- **The contract is often sitting in a page global.** An events enum on
  `window` handed over dozens of push message types, and the push client
  instance gave the socket URL, app key, auth endpoint and every subscribed
  channel name. One `javascript_tool` read beat any amount of clicking.
- **Client-side rendering means UI controls fire nothing.** Chart range buttons
  and series toggles redrew from data already in memory. Clicking the UI to find
  a charting API found nothing, because the charting API was the payload of an
  endpoint already captured.

## Ask the API what it supports

Error messages are a cheap, precise discovery channel, often better than
guessing from mined strings:

- An unknown route names itself: `Endpoint not found (backtests/report/read)`.
  A real route names its arguments: `Required parameter optimizationId is
  missing.`, sometimes with the type. Together these enumerate routes *and*
  contracts without a single successful write. 22 of 24 guessed routes on one
  site were confirmed this way in one pass.
- Only probe names that are harmless if they succeed. A bare call to a delete
  route is still a delete.
- **Validation errors describe positions, not rules.** `Invalid character ','
  found in input string at position 64` was a character *whitelist*
  (`[A-Za-z0-9 ._/-]`), which looked like a parser bug until a second character
  was rejected too. When a field rejects one character, probe the class rather
  than escaping the one you hit.
- **`success: false` does not always mean failure.** An async endpoint can
  report `{success: false, generating: true}` while it works normally. Poll it.

## Writes against a live account

`api_*` tooling runs under the user's real logged-in session. Reads are fair
game once a capture is authorized; **writes are not. Ask first, every time**,
and say which routes you intend to call. When you do get the go-ahead, run the
chain one step at a time and report each response rather than assuming inferred
request shapes are right; the first attempt often returns a validation error
that tells you the real contract.

Scope note: this file is only loaded for sessions whose working directory is
this repo. A session using the MCP server from some other project will not see
it, so if the "check for an existing map first" habit matters there, it belongs
in that project's `CLAUDE.md` or in the user's global one.
