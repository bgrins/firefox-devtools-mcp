# Implementer briefing — browser-agent eval fixtures

You are implementing ONE task (or one fixture group) for a browser-agent eval
suite in `~/code/firefox-devtools-mcp` (branch `firefox-cli`; never touch main).
All paths below are relative to the repo root.

The suite's purpose is measuring **the value of different tool surfaces**
(a `firefox-cli` shell vs the `firefox-devtools-mcp` stdio server vs
playwright-mcp) — not agent capability. A task must sit in the difficulty band
where the tool surface decides the outcome. Failures that indict a tool are the
product.

## What you may write

- Fixture files under `cli/eval/pages/<your dir>/` (HTML/CSS/JS/images).
- An integration spec at `cli/eval/staging/<ID>.md` (see required sections).
- Scratch self-test files at `cli/eval/staging/scratch-<ID>-*.mjs`
  (`staging/` is gitignored; scratch files are throwaway).

## What you must NOT do

- Do NOT edit `cli/eval/server.mjs`, `cli/eval/run.mjs`, `cli/eval/answers.mjs`,
  or `cli/eval/task-ideas.md`. The maintainer integrates your spec centrally.
- Do NOT edit any other task's fixture files.
- Do NOT git commit, stage, or push anything.
- Do NOT "fix" the CLI, the MCP server, or the runner. TOOL-FIX FREEZE (below).

## Orientation (read before writing anything)

1. `cli/eval/task-ideas.md` — find the `### <ID> — …` implementation plan; it is
   your contract (Fixture / Server / Ask / Validator). Deviate only with a
   documented reason in your spec.
2. `cli/eval/server.mjs` — the P-1 session/nonce infrastructure. Study 3-4
   existing handlers (`/api/canvas/reveal`, `/api/register`, `/api/files`,
   `/api/biglist/rows`).
3. `cli/eval/run.mjs` — `webTasks()`. Study the `register-errors`,
   `checkout-stop` and `rename-rollback` validators: session-graded, decoupled
   answer checks, markdown emphasis stripped before prose regexes.
4. `cli/eval/staging/T074.md` and `cli/eval/staging/T089.md` — the spec quality
   bar (T089 is gold; match its depth).
5. An existing fixture near yours for house style, e.g.
   `pages/forms/brochure.html` (forms), `pages/shop/voltro/index.html` (shop),
   `pages/gov/fee-schedule.html` (legacy gov style), `pages/news/index.html`.

## P-1 session/nonce infrastructure (already built in server.mjs)

- Every `.html` response without a valid `evalsid` cookie gets one
  (`HttpOnly; SameSite=Lax`) plus a fresh per-session nonce.
- HTML bodies have the literal token `__SESSION_NONCE__` substituted with the
  request session's nonce. Page JS reads it, e.g.
  `const NONCE = '__SESSION_NONCE__';`
- `POST /api/beacon` with `{nonce, kind, data}` → pushes `{sid, kind, data, at}`
  onto `state.beacons`; 403 on a bad/missing nonce. Validators read
  `ctx.pages.state.beaconsOf('<kind>')`.
- `getSession(req)` → `{sid, session} | null`. `requireSession(req, res, nonce)`
  → same, or writes a 403 JSON body and returns `null` (nonce comes from the
  body for POSTs, or the `X-Eval-Nonce` header for GETs).
- Per-session task state lives on the session object
  (`found.session.myThing ??= …`); `state.reset()` clears sessions/beacons and
  is called by the runner before every task, so anything you hang off a session
  is automatically reset.
- Helpers available in the handler chain: `readBody(req)` (64 KB cap),
  `json(res, status, obj)`, `url.searchParams`, `randomBytes`/`randomUUID`.
- Static files are served from `pages/` after the API chain; a request for a
  directory gets `index.html`. The static server CANNOT do auth redirects —
  gate the DATA via `fetch`, not the page shell.

## Hard rules

1. **Ground truth is never derivable from fixture source on disk.** Codes,
   messages, and figures the validator checks must be server-issued per session
   (or the validated fact must be server-observed, e.g. "the server saw a
   compliant submission"). Assume the agent can `cat` and `grep` every file in
   `pages/`. Pure-extraction tasks whose datum needs no interaction to be
   trustworthy (a long document, a messy table) may keep the datum in the page —
   but then it must exist in EXACTLY ONE place, with plausible decoys elsewhere,
   and the answer key lives in `answers.mjs`, never in the page.
2. Every page starts `<!doctype html>` and carries `<meta charset="utf-8">`
   (fixtures under `pages/gov/` use the site's legacy HTML-4.01 house style
   instead: `<font>`, tables, spacer gifs — match the neighbours).
3. **No emoji anywhere** — code, comments, strings, docs. No copyrighted
   content or real brands; invent everything. Do NOT add disclaimers saying the
   site is fictional, simulated, a test fixture, or for browser automation —
   that it is invented is implied, and a real site would never say it. Write
   the footer a real company would write (copyright line, privacy/terms links,
   registered address, support contact). The same goes for page titles,
   headings, and body copy: nothing may announce that the content is fake.
4. **Near-zero code comments.** Comment only non-obvious mechanics.
5. Realism: pages should look like a real site of their genre (nav, footer,
   filler content, plausible copy), not a test harness.
5b. **Every site needs its OWN design language.** Do not copy the styling of the
   fixture you were shown as a house-style reference — copy its *rigor* (real
   chrome, plausible copy, no test-harness tells), not its fonts, palette, or
   layout. Agents must have to re-orient on each site, so vary: type family and
   scale, colour palette, density, border/corner/shadow treatment, nav pattern
   (top bar / sidebar / breadcrumb / tabs), form layout (stacked / two-column /
   inline labels / floating labels), button shape and label wording, table vs
   card vs list presentation, and the terminology of common actions.
   Pick an identity that fits the fiction: a municipal site, a 2004 intranet, a
   modern SaaS console, a print-heavy editorial site, and a discount retailer
   should look nothing alike. State your chosen design language in one line in
   your spec.
   ALREADY CLAIMED — pick something different: Georgia/serif + sage green
   (`forms/brochure.html`), Helvetica/Arial + slate blue (`biglist`, `ledger`),
   Segoe UI + cool grey (`filemgr`, `shadow`, `bank`), Verdana + orange
   (`news/`), legacy HTML 4.01 tables + `<font>` (`gov/`), marketplace yellow
   (`shop/voltro`).
6. Deterministic: no wall-clock or random-dependent content unless the plan
   explicitly asks for it (per-session server-issued codes are fine — they are
   read back out of `ctx.pages.state` by the validator, never hardcoded).
7. SILENT BY DEFAULT. Any `<audio>` or `<video>` a fixture ships must carry
   `muted` AND set `volume = 0` in script, and must never autoplay unmuted.
   Headless Firefox on macOS still routes audio to the machine's speakers, so an
   unmuted fixture beeps at whoever is running the suite — during your own spike,
   during every acceptance sweep, and for anyone who ever runs the 70-task
   regression. This is not cosmetic: it happened, on a fixture that synthesised a
   sine tone. Muting costs the measurement NOTHING — a muted element still
   decodes, `currentTime` still advances, `timeupdate`/`ended` still fire, and
   WebVTT cues still activate — so there is no reason to test unmuted even
   briefly. If you genuinely believe a check requires audible output, do not do
   it; say so in the spec and let the maintainer decide.

## TOOL-FIX FREEZE — known gaps, design AWARE of them

These are deliberate probes. Do not work around them in the tool, and do not
build a task that is unwinnable because of them:

- The snapshot walker has `MAX_DEPTH=10` and truncates deep/iframe DOMs.
- The walker never descends into shadow roots.
- `find` misses text past 100 chars in a single node.
- Snapshot text is capped TWICE and only 27 characters of content survive:
  `MAX_TEXT_LENGTH = 100` in `attributeCollector.ts`, then
  `MAX_ATTR_LENGTH = 30` in `formatter.ts`, whose `truncate()` emits
  `substring(0, 30 - 3) + '...'`. So a graded datum must sit within the first
  27 chars of its text node, not 30. `href`/`src`/`value`/`name` take the same
  27-char cap, and hrefs are absolutized first, so a URL is never usable for
  disambiguation. An agent may echo a truncated string verbatim — never require
  a long contiguous string in an answer.
- Flattened snapshots lose button-to-card grouping (ambiguous "Add to cart").
- Native `window.confirm()` is auto-dismissed instantly by the BiDi session —
  use in-page modals for any dialog task.

## Anti-cheat lessons from earlier waves (apply them, they cost us rework)

- **`POST /api/beacon` accepts an arbitrary `kind`.** Any gate written as
  `beaconsOf('my-kind').length >= N` is forgeable with nothing but the page
  nonce. Grade on per-session counters your OWN endpoint maintains
  (`found.session.myThing`), and demote beacons to `detail`.
- **Anything under `pages/` is HTTP-reachable**, including generators and raw
  data files. Build scripts live in `cli/eval/gen/` and bulk data in
  `cli/eval/data/`, outside the served root; a generator that prints the answer
  key inside `pages/` is a one-request cheat.
- **A per-session value derived from the page-exposed nonce is reproducible**
  by anyone who knows the formula. Derive server-issued codes from
  `randomBytes`, not from the nonce.
- **A datum the validator reads out of the snapshot must sit within the first
  27 characters of its text node** (`MAX_ATTR_LENGTH` is 30 but `truncate()`
  spends 3 of them on the ellipsis). A realistic string like "Your price for
  this item is $274.50" truncates to "Your price for this item is..." and the
  number disappears. Keep graded text short and front-loaded.
- **`find` only searches the text the snapshot returned**, and the snapshot has
  a line cap, so a node past the cap is invisible to `find` even though it
  exists. Do not design a task whose only affordance sits at the bottom of a
  long page.

## Validator rules (brittleness is a bug — we have been burned)

- A CORRECT agent must never fail on formatting. Strip markdown emphasis
  (`text.replace(/[*_~`]+/g, '')`) before any prose regex.
- Never require a contiguous multi-token phrase or a rendered range like
  `10:00 am - 6:30 pm`; check the parts independently.
- Numbers: allow optional `$`, optional thousands separators/spaces, and guard
  against substring matches with lookaheads (see the `fee-schedule` validator).
- Multi-session shadowing: several sessions can exist per run (a curl probe, a
  re-minted cookie). Pick the session that actually COMPLETED the flow
  (see `register-errors`, `checkout-stop`), never blindly `[0]`.
- Only assert state that actually exists; log everything you checked in
  `detail` so failures are diagnosable.
- Prefer server-observed gates over answer-text gates; use both where the plan
  says so.
- **BIND FACTS TOGETHER; never AND independent substring tests.** This is the
  single most common defect in this suite's history. The 2026-07-28 review found
  a dozen validators grading a bag of substrings, so: a `news-extract` table with
  the points column rotated one row scored 20/20; `crm-join` passed an answer
  naming the wrong winning region; `roster-diff` passed with the added and removed
  lists completely swapped; `variant-matrix` passed an answer declaring the MOST
  EXPENSIVE combination the cheapest. In each case every required token appeared
  somewhere in an otherwise-correct table. Require the facts to co-occur in ONE
  clause or row — copy `rate-limited-lookups`' `pairOk` or `oos-substitute`'s
  `namesDecoyAsChoice` rather than inventing a scheme.
- **Grade what the ask asks for.** Several validators computed a value and then
  never read it (`price-compare`'s per-store figures, `roster-diff`'s categories,
  `cross-tab-pay`'s decoy, `locale-notice`'s two conditions), so a third of the
  requested output was ungraded. If the ask demands it, gate on it or drop it from
  the ask.
- **Every validator change ships with regression strings.** `verify.mjs` takes
  `wrong` as a string OR array (all must FAIL) and `alsoCorrect` as an array (all
  must PASS) on the task's driver. Add the string FIRST, watch `verify.mjs` go red,
  then change the validator. A tightening that was never seen to fail has not been
  shown to do anything — and half the fixes in the first attempt at this either
  closed nothing or created a new mis-grade.

## Required spec file: `cli/eval/staging/<ID>.md`

Exactly these sections, in this order, with these headings:

```
# <ID> — <Idea title> (suite task id: `<kebab-id>`)

<2-6 sentence description of the fixture and where the difficulty lives.>

## Server endpoint code
## answers.mjs entry
## run.mjs task entry
## Expected solution
## Success criteria
## Self-test notes
```

- Every code block must be **paste-ready**: correct indentation for its
  destination file, and a one-line note on where it goes (e.g. "insert above
  the `/api/roster-submit` handler"). If your task needs no server endpoint,
  write "None." under that heading.
- The `run.mjs task entry` block is a complete `webTasks()` array element
  (`{ id, ask, validate }` — there is deliberately no turn limit; runaway
  protection is the harness's `--max-wall` / `--max-output`), using the `base`
  template variable for
  URLs exactly like the existing entries.
- Success criteria: enumerate every pass condition, including the anti-cheat
  reasoning and how the graded session is picked.

## Self-test (both halves are mandatory; report results in the spec)

1. **Scratch server + curl.** Copy `cli/eval/server.mjs` to
   `cli/eval/staging/scratch-<ID>-server.mjs`, repoint its pages root
   (`join(dirname(fileURLToPath(import.meta.url)), '..', 'pages')`), paste in
   your endpoints, and run it on YOUR ASSIGNED PORT. Then verify with curl
   (cookie jar + nonce scraped out of the served HTML):
   - happy path end to end;
   - 403 on a forged nonce and on no session at all;
   - the graded ground truth is absent from disk
     (`grep -rniE '<the strings>' cli/eval/pages/` → no hits).
   Also worth writing a `scratch-<ID>-validate.mjs` that drives your exact
   validator function over both correct and incorrect answer phrasings
   (T089 did this and it caught real bugs).
2. **Real headless browser** via firefox-cli, against the scratch server:
   ```sh
   D=$(mktemp -d)
   FIREFOX_CLI_STATE_DIR=$D node cli/bin/firefox-cli.mjs launch --headless
   FIREFOX_CLI_STATE_DIR=$D node cli/bin/firefox-cli.mjs open http://127.0.0.1:<port>/<path>
   FIREFOX_CLI_STATE_DIR=$D node cli/bin/firefox-cli.mjs snapshot
   FIREFOX_CLI_STATE_DIR=$D node cli/bin/firefox-cli.mjs find "some text"
   FIREFOX_CLI_STATE_DIR=$D node cli/bin/firefox-cli.mjs click <uid>
   FIREFOX_CLI_STATE_DIR=$D node cli/bin/firefox-cli.mjs fill <uid> "value"
   FIREFOX_CLI_STATE_DIR=$D node cli/bin/firefox-cli.mjs eval '() => document.title'
   FIREFOX_CLI_STATE_DIR=$D node cli/bin/firefox-cli.mjs stop
   rm -rf $D
   ```
   Drive the whole intended solution path this way and confirm the page works,
   the beacons/state land, and the task is winnable through the snapshot/find
   surface (note honestly in the spec if some step needs `eval`).
   ALWAYS headless. ALWAYS stop the instance and kill the scratch server when
   done (`pkill -f scratch-<ID>-server` or kill the recorded PID).

Report in `## Self-test notes`, in T089's style: what you ran, what you
observed, the grep result, and anything that needs real-run QA.

## Deliverable

A one-paragraph summary to the maintainer: files written, the suite task id,
anything you deviated from the plan on, and any tool finding you hit (a snapshot
gap, a CLI limitation) — findings are valuable, do not fix them.
