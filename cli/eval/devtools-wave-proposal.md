# Devtools-surface wave — proposal (console / network / debugger)

Written 2026-07-27. Recommendation only; no fixtures, no server/runner/answers
edits, nothing added to `task-ideas.md`. Every behavioural claim below was
measured by driving both tool surfaces headless against a scratch fixture, not
inferred from source. Probe transcript summarized in section 6.

The gap is real: 61 web tasks, 28 sites, and not one of them calls
`list_console_messages`, `list_network_requests`, `get_network_request`, or any
debugger tool. This proposes five tasks that do, ranked, plus an explicit list of
the ideas that looked good and are not worth building.

---

## 1. The fairness question — verdict first

**It is not a walkover, and it is not a walkover in the direction the framing
assumes. On console and network, playwright-mcp is at parity or ahead of us.**
Only the debugger is exclusively ours, and the profiler is unavailable in the
Firefox the eval actually launches.

What playwright-mcp exposes under the eval's own launch flags
(`cli.js --browser firefox --isolated --headless`, 24 tools — verified by
`tools/list`): `browser_console_messages`, `browser_network_requests`,
`browser_network_request`, `browser_evaluate`, `browser_run_code_unsafe`.
No routing/tracing/storage tools (those need extra capabilities that the eval
does not pass), and `browser_console_clear` is `skillOnly` so it is not exposed.

Measured, same page, same failing endpoints, side by side:

| Capability | ours | playwright-mcp |
| --- | --- | --- |
| Console API messages | yes | yes |
| Console message source location | **no** (`source` is a realm GUID) | `@ url:line` on every message |
| Uncaught exception | `Error: uncaught-marker-from-inner` | same message **plus the full stack**: `at inner (…:14:25) / at outer (…:15:19) / at setTimeout handler*` |
| CSP violation text (incl. suggested `sha256-…`) | yes, full text | yes, plus `file`/`line` |
| Error/warning count surfaced unprompted | **no** | yes — every tool response carries `Console: 2 errors, 1 warnings` plus a pointer to new entries |
| Console survives navigation | yes (no clearing) | only with `all: true` |
| Console/network retained indefinitely | **no — 5-minute TTL silently empties both** | 200-entry ring, no TTL |
| Network list | yes | yes |
| Duration in the list | **yes** | no — only in per-request detail |
| Filter by status / range / method / duration sort | **yes** | URL regexp and a `static` boolean only |
| Response headers | yes | yes |
| **Response body** | **never** | `part: "response-body"` returns it |
| Request body | never | `part: "request-body"` |
| Network log survives navigation | **yes, cumulative** | **no — wiped on every navigation, and there is no `all` escape** |
| Transport-level failure (connection refused) | invisible | invisible |
| Aborted response | shown as a clean `200` | shown as a clean `200` |
| Debugger: script list, source, logpoints | **yes** | no equivalent |
| Profiler | tool exists, **errors on Firefox 153** (needs 154+; the eval launches release 153) | no equivalent |

So the honest design consequence: **do not build tasks that discriminate on
presence.** Three axes discriminate on quality and all three are measurable:

1. **Retention.** Their network log dies at every navigation; ours survives (but
   dies at 5 minutes). Any question asked *after* the failing step — which is
   how real debugging works — favours us. This is the strongest, cleanest
   discriminator we have and it is task #1.
2. **Depth.** They read failing response bodies and full stack traces; we read
   neither. Those are two tasks we should expect to lose, and both convert into
   a one-line product ask with a measured before/after.
3. **Cue.** Their every tool response says how many console errors exist. Ours
   never mentions it. On a silent failure, their agent is told to look and ours
   has to think of it. That asymmetry will show up as extra turns for us, and it
   is worth measuring precisely because the fix is trivial on our side.

**On tasks the other side cannot attempt.** A task playwright-mcp cannot even
try produces a 100%-vs-0% row, and that is not evidence of anything: it is a
capability inventory rendered as a score. It tells us nothing about whether the
capability is *worth* anything, which is the question this suite exists to
answer. Such a task has exactly two legitimate uses, neither of which is a
comparative eval row: (a) regression protection — "does `enable_debugger` still
work on today's Firefox" belongs in `verify.mjs` or the integration tests; and
(b) as the control half of a task where the competitor has a *general-purpose
workaround*, so the measurement becomes "purpose-built tool vs escape hatch, in
tokens". That second shape is real and it is why task #5 is built the way it is:
playwright can monkeypatch `window.fetch` via `browser_evaluate` and get the same
answer, so the row is a cost comparison rather than a capability boast. If we
cannot construct a workaround for them, the task should not ship.

**The profiler gets no task.** Three independent reasons, any one sufficient:
`profiler_is_active`/`start`/`stop` all return
`moz:profiler requires Firefox 154 or later (connected: 153.0)` against the
Firefox the `mcp` condition launches; playwright-mcp exposes no profiling tool at
the eval's flags, so it is an un-attemptable row; and `profiler_stop` writes a
Gecko profile JSON to the downloads directory, so "read the profile" is a
gigantic JSON-parsing exercise, not a browser-agent skill. Revisit only if the
eval pins Nightly **and** we ship a tool that answers a question (longest task,
top marker, main-thread busy time) instead of saving a file.

---

## 2. Probe-verified constraints any implementer must design around

These were all established by driving the tools; several would have invalidated
an otherwise reasonable task, in the same way `set_viewport_size`'s clamp and
`evaluate_script`'s 5s cap did in earlier waves.

- **Both logs have a hard 5-minute TTL** (`CONSOLE_TTL_MS`, `NETWORK_TTL_MS` in
  `src/firefox/events/*.ts`). After 5 minutes `list_network_requests` returns
  `total: 0` with no hint that anything was dropped. Observed live: a log with 9
  requests became empty mid-probe. Wall tiers in this suite go to 600s, so **a
  devtools task whose evidence is only produced once, at t=0, is a coin flip.**
  Every task below is therefore either short-flow or re-triggerable with a
  session-stable answer.
- **Logpoints do not survive a navigation, silently.** A logpoint set before a
  reload collects nothing afterwards — not an error, not a re-arm; further
  `get_logpoint_results` calls keep returning the pre-navigation results forever.
  Re-calling `enable_debugger` does not fix it; only a freshly set logpoint
  collects. So the canonical dev workflow ("set a logpoint, reload to catch it on
  load") yields nothing, and **any logpoint task must be triggerable by an
  interaction after the logpoint is set.**
- **Two logpoints on the same line: only the first collects.** The second returns
  `No results collected yet` forever. And `set_logpoint` at a nonexistent line
  (999 of a 12-line file) reports success.
- Logpoint line resolution is finicky. Lines 2, 3 and 5 of a small module all
  collected; one attempt on a `.then(…)` callback line was inconclusive. The
  implementer must confirm the exact chosen line collects, and should prefer a
  plain statement in a function body.
- **`isXHR: true` matches nothing.** Firefox's BiDi initiator type is not
  `fetch`/`xmlhttprequest`, so every `fetch()` is recorded `isXHR: false` and the
  documented filter returns 0 rows. Do not write a task that nudges toward it.
- `resourceType` is guessed from the URL string (`/api/` or `.json` → `xhr`),
  not reported by the browser.
- **Transport failures are invisible to both surfaces.** A `fetch` to a closed
  port never appears in either tool's list, and a response aborted mid-body
  appears as a clean `200` in both (ours also silently lacks `duration`). A task
  built on "which request failed at the transport level" is unwinnable for both
  and would grade luck. It is a product finding (we never subscribe to
  `network.fetchError`), not a task.
- `status`/`statusMin`/`statusMax` filters and `sortBy: "duration"` all work, and
  our durations are accurate (3005 ms measured on a 3000 ms endpoint).
- Response **headers** are fully available on both sides, including custom ones
  (`x-trace-token` came through verbatim in both). This is the vehicle that makes
  most of these tasks gradeable — see section 3.
- `get_script_source` works on both an external script and the document URL (for
  which it returns the inline script text). Scripts served inline from
  `server.mjs` behave identically, so the T042 precedent (content that exists
  nowhere under `pages/`) is available to debugger tasks too.
- The eval's `mcp` condition launches with `--enable-script`, so the debugger
  tools ARE exposed. `--enable-privileged-context` is NOT passed, so
  privileged-context and pref tools are out of scope for the eval as configured.
- `firefox-cli` has `console` and `requests` verbs but nothing for the debugger,
  and `CLI_CHEATSHEET` advertises neither — so this whole wave is
  cross-condition-unfair to the (opt-in, being-retired) `cli` condition. Run these
  tasks `--conditions mcp,playwright` only, or fix B6 first.

---

## 3. The off-disk grading problem, solved once

The hard objection is exact: a console message the fixture prints is, by
definition, in the fixture source. Three vehicles solve it, and every task below
names which one it uses:

- **V1 — response header.** A per-session `randomBytes` token in a response
  header of a specific request. Not on disk, not in the DOM, never rendered, and
  reachable through both surfaces' network inspection (verified). The validator
  compares against what the server issued to that session.
- **V2 — server-chosen behaviour.** *Which* thing breaks is drawn per session:
  which shard 500s, which payload field is omitted, which panel is slow. The
  fixture source contains all the branches and none of the answers, so reading
  `pages/` yields a menu, not a solution.
- **V3 — browser-computed value.** A number that only the browser produces: a
  measured duration, a CSP `sha256-…` suggestion, a `Date.now()` delta captured
  by a logpoint. It exists in no file and in no server response.

Anything printed to the console must be assembled at runtime from a V1/V2 value
(`console.warn('drop ' + key + ' ' + diag)`), never written literally in the
fixture.

**The residual curl hole, stated honestly.** HTTP is HTTP: an agent with a shell
can usually re-issue a request itself and read the same header the browser saw.
No server-side scheme distinguishes curl from Firefox. Three mitigations, in
order of strength, and none of them is a proof:

1. **Session-scoped answers plus graded-session selection.** A curl probe mints
   its own `evalsid` and gets its own V1/V2 draw. The validator grades the
   session that completed the flow through the browser (the standing
   `register-errors`/`checkout-stop` pattern), so a curl-derived answer is simply
   the wrong string. This is the one that actually bites, and it is why every
   task below makes the *interesting* value per-session rather than global.
2. **One-shot semantics.** The interesting response is produced once per session;
   a replay returns `410` and a decoy. This turns "just re-fetch it" from a
   shortcut into a wrong answer.
3. **Transcript grep** — the `file-upload` precedent. Whether the agent used
   `list_console_messages` / `browser_network_request` at all is a
   transcript-level observation, and for this wave it is the real probe. The pass
   rate is not.

And the corollary worth writing down: **if an agent solves a network-inspection
task with curl, that is itself the finding** — our network tools added nothing
over a shell on that task, which is exactly the kind of result this suite is for.
Record it, do not patch it away.

---

## 4. Ranked shortlist

Build cost note: tasks 1, 3 and 4 share one new site; tasks 2 and 5 share a
second. Two new fixture sites for five tasks, each needing its own design
language per the briefing (check `/` on a dev server for what is already taken —
the freight-registry, dark-ops-console, discount-grocer and print-academic looks
are all in use).

### T120 — Post-Navigation Network Forensics (P1) · suite id `shard-forensics`
- Fixture: new `pages/depot/` — Marlowe Depot Systems, a warehouse ops console
  (suggested design language: dense two-column industrial UI, condensed
  sans + steel/amber, tabbed sub-nav, tabular data with hairline rules; nothing
  like the existing shops or gov site). Three pages: `index.html` (sign-in),
  `shifts.html` (the landing dashboard after sign-in, ~12 requests total),
  `incidents.html` (a support form the ask does not need). Sign-in JS POSTs
  `/api/depot/signin`; on the FIRST attempt of a session the server answers 200
  but the page's follow-up `GET /api/depot/roster?shard=<n>` returns **502 with a
  `X-Depot-Trace` header**, the dashboard silently falls back to a cached roster,
  and the page navigates to `shifts.html` anyway. The dashboard renders fine and
  says nothing about the failure. Nothing about the 502 is visible in the DOM of
  the page the agent ends up on.
- Server: `POST /api/depot/signin` (nonce-gated) marks the session signed-in and
  picks `shard` from 4 candidates via `randomBytes`;
  `GET /api/depot/roster?shard=<n>` returns 502 for the session's chosen shard
  (always the same shard, and always the same session-stable
  `X-Depot-Trace: DT-<8 hex>` token, so a re-trigger yields the same answer) and
  200 for the other three. Server counts roster hits per session:
  `found.session.rosterHits`.
- Ask: "Sign in to {base}/depot/ as the seeded operator. The shift dashboard is
  showing yesterday's roster. Something failed during sign-in — say which request
  failed, with its status code, and report the trace id the server returned with
  it."
- Validator: server-observed `session.signedIn === true` AND the answer contains
  the session's `X-Depot-Trace` token (case-insensitive, emphasis stripped) AND
  names `502` AND names `roster`. `detail` records `rosterHits` — the number of
  times the agent had to re-cause the failure to see it, which is the retention
  gap expressed as a number.
- Why this discriminates: **verified** — playwright-mcp's `browser_network_requests`
  is wiped by the navigation to the dashboard and has no `all` option, so the
  failing request is simply gone; ours is cumulative and answers it with
  `list_network_requests {statusMin: 500}` plus one `get_network_request`. Their
  recovery is to navigate back and re-run sign-in, which is several turns and
  shows up in `rosterHits`. Both can pass; we should pass much cheaper. Note the
  page navigates *after* the failure specifically so
  `performance.getEntriesByType('resource')` is useless to both sides (verified:
  resource timing is per-document).
- How it is graded without the answer being on disk: V1 + V2. The trace token is
  `randomBytes` per session and appears only in a response header; which shard
  502s is a per-session draw. `grep -r DT- cli/eval/pages/` finds nothing.
- Risk: the 5-minute TTL. Put this on the short wall tier and keep the flow to
  three interactions; if an agent burns 5 minutes the evidence evaporates for us
  too. The re-triggerable-with-stable-token design is what keeps that recoverable
  rather than fatal.
- Effort: M · Depends: P-1

### T121 — Which Function Threw (P1) · suite id `silent-throw`
- Fixture: new `pages/quotient/` — Quotient Reconcile, a small accounting SaaS
  (suggested design language: light editorial serif headings + neutral grey
  chrome, sidebar nav, generous whitespace; distinct from `filemgr`/`shadow`).
  `reconcile.html` loads `app.js` (a real 8-function module: `applyFxRate`,
  `normalizeVendor`, `splitTaxLines`, `mergeAdjustments`, …). Clicking
  "Run reconciliation" fetches `/api/quotient/batch`, pipes the payload through
  the eight helpers, and renders a table. The button appears to do nothing: one
  helper throws a `TypeError` because the payload omits one field, and the
  exception is uncaught. The UI shows the spinner stopping and nothing else.
- Server: `GET /api/quotient/batch` (session-gated, ONE-SHOT per session) returns
  the batch with exactly one of eight fields omitted, chosen by `randomBytes`;
  records `{omitted, helper}` on the session. A second request returns `410` and
  a payload with a *different* field omitted (the decoy), so an out-of-band
  re-fetch produces a wrong answer.
- Ask: "Open {base}/quotient/reconcile.html and run the reconciliation. It fails
  silently. Report which function in the page's code throws and which field of
  the server's response is missing."
- Validator: answer names the session's recorded helper AND the omitted field
  name (both checked independently, emphasis stripped, no contiguous-phrase
  requirement). `detail` records the session's draw and how many times
  `/api/quotient/batch` was requested (>1 means the agent went out of band and
  will have the decoy).
- Why this discriminates: this is the "does a stack trace survive" question, made
  gradeable. playwright reads
  `TypeError: … at applyFxRate (http://…/app.js:41:18)` straight out of
  `browser_console_messages` — one call, done. We print
  `TypeError: batch.fx is undefined` with **no file, no line, no frame**, so our
  agent must either instrument (`enable_debugger` → `get_script_source` →
  logpoints, several calls) or wrap the handler with `evaluate_script`. Expected
  outcome: they pass cheap, we pass expensive or fail. Product ask, one line:
  carry `stackTrace` from `log.entryAdded` into `list_console_messages`.
- How it is graded without the answer being on disk: V2 + one-shot. All eight
  helpers and all eight field names are in `app.js` on disk; which one is broken
  this session is not, and the one-shot payload means the only trustworthy
  observation is the one the browser already made.
- Risk: an agent may brute-force by reasoning over `app.js` plus a curl of the
  payload — the one-shot decoy is what closes that, so it must be implemented
  exactly (410 + different omission, not 410 + nothing).
- Effort: M · Depends: P-1

### T122 — The Ref Only In The Response Body (P1) · suite id `body-only-ref`
- Fixture: same `pages/depot/` site, new page `manifests.html`. The manifest
  table renders permanently empty ("No manifests for this shift") because
  `GET /api/depot/manifests` returns **500 with a JSON body**
  `{"error":"manifest_store_locked","ref":"MR-<8 hex>","remedy":"…"}`. The status
  and the endpoint are discoverable from either surface; the `ref` exists ONLY in
  the body. The page never renders or logs it.
- Server: `GET /api/depot/manifests` — 500 with a session-stable `ref` from
  `randomBytes`, `session.manifestHits++`. The 500 is stable across repeats (so a
  re-trigger does not change the answer) but the body is never echoed anywhere
  else: not in a header, not in the DOM, not in the console.
- Ask: "The manifests page at {base}/depot/manifests.html is empty. Diagnose why
  — name the request and its status — and report the support reference the server
  sent back with the failure."
- Validator: **two independent sub-checks, both reported.** (a) diagnosis: answer
  names `500` and `manifests` — this is the pass condition; (b) `refFound`:
  answer contains the session's `MR-…` ref — recorded in `detail`, not required
  to pass. So the row is not a false "our agent failed", and the capability gap
  is measured exactly.
- Why this discriminates: `get_network_request` returns id/url/method/status/
  timings/headers and **no body, ever** (verified against the source and live).
  playwright's `browser_network_request` says, in its own output, `Call
  browser_network_request with part="response-body" to read the response body` —
  and it works (verified: it returned my probe body verbatim). Our only routes
  are re-fetching through `evaluate_script` (a second server hit, counted in
  `detail`) or nothing. Sub-check (b) should read 0% for us and ~100% for them
  until we capture bodies; once we do, this task is the before/after.
- How it is graded without the answer being on disk: V1-shaped but in the body —
  `randomBytes` per session, present in exactly one HTTP response.
  `grep -r 'MR-' cli/eval/pages/` finds nothing.
- Risk: a `fetch` re-issue through `evaluate_script` legitimately recovers the
  body, so (b) may not read a clean 0% for us. That is fine and it is the
  interesting number: `manifestHits > 1` in `detail` is the price of not having
  the capability. Do NOT make the endpoint one-shot here — that would convert a
  measured cost into an unwinnable row.
- Effort: M · Depends: P-1

### T123 — Silent Partial Import, Console-Only Diagnostic (P1) · suite id `partial-import`
- Fixture: same `pages/depot/` site, `intake.html`: paste-or-load a 40-line
  delivery manifest, click "Post to intake". The UI reports
  "Intake complete — 40 lines posted" unconditionally. In fact the server stored
  37; the three rejects are reported only via `console.warn` lines the page emits
  while streaming the response, each carrying the rejected line key and a
  per-session diagnostic code, e.g.
  `console.warn('intake reject ' + line.key + ' ' + resp.diag)`.
- Server: `POST /api/depot/intake` (nonce-gated, one-shot per session) picks 3 of
  40 line keys to reject via `randomBytes`, records them plus a
  `diag` code on the session, streams back per-line results, and stores 37.
  A repeat POST returns `409 already_posted`. `GET /api/depot/intake/count`
  (session-gated) is what the honest UI would have had and does not exist.
- Ask: "Post the delivery manifest at {base}/depot/intake.html. The page will say
  it posted everything — verify that, and if anything was dropped report how many
  lines were actually accepted, which line keys were rejected, and the diagnostic
  code."
- Validator: server-observed `session.intakeStored === 37` (the import really ran
  through the browser) AND the answer contains `37` (guarded number regex) AND
  all three session-chosen line keys AND the `diag` code. `detail` logs the
  session draw, the answer's hits/misses, and whether the POST was attempted more
  than once.
- Why this discriminates: this is the most common real debugging scenario in the
  suite — a UI that lies about success — and it is the one place playwright has a
  structural edge on *noticing*: every single one of their tool responses carries
  `Console: 0 errors, 3 warnings` and a pointer to the new entries, so their
  agent is told to look without asking. We never mention console state anywhere,
  so our agent has to think of `list_console_messages` unprompted. Second-order:
  their messages carry `@ url:line` so the three warnings are trivially
  attributable; our `source` field is a realm GUID and carries no location. Both
  should pass; the interesting numbers are turns-to-first-console-call and total
  tokens. Product ask: attach console error/warning counts to our tool responses.
- How it is graded without the answer being on disk: V2 + V1. Which three of 40
  keys are rejected and the `diag` code are per-session `randomBytes` draws,
  printed to the console only, and the count gate is server-observed state that
  only a real in-browser POST produces.
- Risk: residual curl equivalence (an agent can POST the intake itself and read
  the streamed JSON). Mitigations: one-shot per session, and the `intakeStored`
  gate is checked on the session that the browser used. Transcript grep for a
  console call is the real probe, per section 3.
- Effort: M · Depends: P-1

### T124 — The Rate Nobody Displays (P1) · suite id `mid-flight-rate`
- Fixture: same `pages/quotient/` site, `quote.html`: a freight quoting widget.
  Enter weight and lane, press "Price it", get a total. `app.js` computes
  `total = base * rate` where `rate` comes from the response and is **never
  stored and never displayed** (`const {rate} = await r.json();` … the object is
  not retained; the DOM shows only `total`). Rounding makes `total / base`
  ambiguous across several plausible rates, so back-computing does not identify
  it. The ask targets the SECOND quote of the session, so the agent must
  instrument before acting.
- Server: `POST /api/quotient/quote` (nonce-gated) issues a per-call
  `rate` drawn from `randomBytes` (4 decimal places, chosen so that
  `round(base*rate)` collides with at least two other candidate rates), records
  every issued rate in order on the session.
- Ask: "Open {base}/quotient/quote.html. Price these two shipments (…, then …).
  Report the exact rate multiplier the page applied to the SECOND quote."
- Validator: session has >= 2 recorded quotes AND the answer contains the second
  recorded `rate` to 4 dp (tolerant number regex). `detail` records both rates so
  an off-by-one (reporting the first quote's rate) is diagnosable.
- Why this discriminates: this is the only task in the wave that exercises
  `enable_debugger` / `list_scripts` / `get_script_source` / `set_logpoint` /
  `get_logpoint_results`, and it is deliberately built so **playwright has a
  workaround**: they can `browser_evaluate` a `window.fetch` wrapper (or
  `browser_run_code_unsafe`) before the second click and capture the rate. So the
  row is "purpose-built tool vs general escape hatch, in tokens", not a
  capability boast. If we are not clearly cheaper here, the debugger tools are
  not earning their surface area — which is a finding worth having.
- How it is graded without the answer being on disk: V3/V1 — the rate is minted
  per call by `randomBytes` and exists only in one HTTP response body and in the
  page's transient stack frame. Note the fixture's `app.js` stays a normal file
  under `pages/` (line numbers must be stable for logpoints); its *source* being
  readable is fine because the graded value is runtime-only.
- Risk / VERIFY-FIRST: the highest of the five. The implementer must, before
  designing the fixture layout: (a) confirm a logpoint on the exact chosen line
  of the shipped `app.js` collects on a click (line resolution is finicky, and a
  `.then(…)` callback line was inconclusive in my probe); (b) respect that a
  logpoint set before any navigation is dead afterwards, so the whole path must
  be load → enable → set → click → read with no reload in the loop; (c) not set
  two logpoints on one line. The task is unwinnable through the debugger if any
  of those is violated, and it would present as agent failure.
- Effort: L · Depends: P-1

---

## 5. Considered and rejected

- **A profiler task** (any shape) — `moz:profiler` errors on Firefox 153, which
  is what the eval launches; playwright has no equivalent at the eval's flags; and
  `profiler_stop` produces a file, not an answer. Zero information, three ways.
- **"Which request failed" where the failure is transport-level** (connection
  refused, aborted mid-body) — **verified blind on both surfaces**: the refused
  request appears in neither tool's list, and an aborted response reads as a
  clean `200` in both. Unwinnable for both; grades luck. Keep it as a product
  finding instead.
- **A request-body inspection task** — same shape as T122 and we are missing
  request bodies too; a second task on one axis is padding. Folded into T122's
  `detail`.
- **Anything routed through `isXHR: true`** — the filter matches nothing in
  Firefox (verified 0 rows for a page full of `fetch`). A task nudging toward it
  would punish us for a plain bug. File the bug.
- **A CSP-violation task** (report the `sha256-…` the browser suggests) — I built
  it and probed it because the browser-computed hash is the single cleanest
  off-disk datum available. Rejected: **playwright surfaces the CSP violation
  too**, with `file`/`line` attached, so it discriminates on nothing but the free
  console-error cue that T123 already measures. Keep it in reserve as a cheap (S)
  filler if a fifth task falls over.
- **A console-noise / filtering task** ("300 messages, find the one that
  matters") — our `level`/`textContains`/`sinceMs` filters are good and their
  `level` filter plus file-offload is comparable; the residual difference is
  output volume, which is not worth a fixture.
- **A `clear_console_messages` hygiene task** — their `browser_console_clear` is
  `skillOnly` and not exposed, but their default per-navigation console window
  gives them the same effect for free. Measures nothing.
- **Privileged-context / webextension tasks** — `--enable-privileged-context` is
  not passed by the runner, so those tools do not exist in the measured
  condition; and "install an extension to read the page" is not a user scenario.
  Un-attemptable for playwright either way.
- **A breakpoint/step-through task** — we ship no pause/resume/step/call-stack
  tools, only logpoints. There is nothing to measure yet.
- **Re-measuring a known finding** — no task here depends on tables (A2), the
  27-char cap (A1), checkbox state (A4) or the viewport clamp (A11). T121's
  fixture in particular should render its results as cards, not a `<table>`, so
  the row measures the console/debugger axis and not A2 a fourth time.
- **Resurrecting a graveyard idea** — checked: nothing in the killed list (T004,
  T006, T009, T016, T017, T023, T025, T032, T034, T035, T046, T048, T057, T065,
  T071, T073, T076, T094, T095, T097, T099) touches console, network or the
  debugger, so nothing here is a revival.

---

## 6. Tool defects found while probing (for `findings.md`, suggested A15–A21)

All reproduced headless against a scratch fixture; none fixed, per the
tool-fix freeze.

- **A15. Console and network logs are silently emptied after 5 minutes.**
  `CONSOLE_TTL_MS`/`NETWORK_TTL_MS = 5 * 60 * 1000`. `list_network_requests`
  then reports `total: 0` with no indication that anything expired. Wall tiers
  reach 600s, so evidence can vanish mid-task. playwright keeps a 200-entry ring
  with no TTL. Highest-impact of these.
- **A16. Response bodies are never captured**, for any request, and neither are
  request bodies. `get_network_request` returns headers/timings only.
  playwright-mcp returns both on demand (`part: "response-body"`), and even
  advertises it in its output. This is the single largest capability gap on the
  network surface.
- **A17. Console messages carry no source location and no stack trace.**
  `log.entryAdded` supplies `stackTrace` and a source url/line; we keep neither.
  An uncaught exception arrives as `Error: <message>` and nothing else, where
  playwright gives the full frame list with function names, files and columns.
  Worse, the `source` field we *do* expose is `entry.source.realm` — a GUID — so
  the documented `source` filter is unusable.
- **A18. Nothing in our responses ever mentions console state.** playwright
  appends `Console: N errors, M warnings` (plus a pointer to new entries) to
  every tool response, so its agent learns about a silent failure without asking.
  Cheap fix, direct effect on turns for any diagnostic task.
- **A19. `isXHR` is dead in Firefox.** `initiator.type` is never
  `fetch`/`xmlhttprequest`, so every `fetch()` records `isXHR: false` and
  `list_network_requests {isXHR: true}` returns nothing. `resourceType` is also
  guessed from the URL string rather than reported.
- **A20. Logpoint lifecycle is broken across navigation, silently.** A logpoint
  set before a reload never collects again; `get_logpoint_results` keeps
  returning the stale pre-navigation list; re-calling `enable_debugger` does not
  re-arm it. Also: a second logpoint on an already-instrumented line silently
  never collects, and `set_logpoint` on a nonexistent line number (999 of a
  12-line file) reports success. This breaks the most common real debugging
  workflow (instrument, then reload to catch load-time code).
- **A21. Transport-level failures are invisible.** We never subscribe to
  `network.fetchError`, so a request that cannot connect is absent from the log
  entirely (not even pending), and a response aborted mid-body is recorded as
  `200` with no `duration`. playwright is equally blind here, so it is not a
  competitive gap — but "the request that failed is the one you cannot see" is a
  bad property for a devtools MCP.
- Cosmetic, but it violates the project's own rule: `src/tools/network.ts` emits
  a satellite-antenna emoji (U+1F4E1) in the header of every
  `list_network_requests` text response.

Reproduction rig: a ~60-line scratch server (a 500 with a custom header, a 3s
endpoint, an aborted response, a closed-port fetch, a CSP-blocked inline script,
an uncaught throw two frames deep) driven through `firefox-cli call <tool>` and
through `@playwright/mcp` over stdio with a minimal JSON-RPC client. Worth
rebuilding as a permanent probe if this wave ships.
