# Findings from the eval suite

Split by **who owns the change**, because the two halves carry very different
risk:

- **Part A — upstream `firefox-devtools-mcp` (`src/`).** The product findings.
  This is what the suite exists to produce. Deliberately NOT fixed yet: the suite
  measures these gaps, so fixing one without a recorded before/after destroys the
  evidence that justifies it. Fixture authors are told to design *around* these
  gaps rather than patch them, and to re-measure after any change.
- **Part B — `firefox-cli` and the shared client lib (`cli/`).** Bugs in the shell
  surface and in `cli/lib/mcp.mjs`. Mostly plain defects rather than design
  tradeoffs. The `cli` condition is now opt-in and destined to move out of this
  eval, so these are separable from Part A.
- **Part C — the eval harness itself (`cli/eval/`).** Ours to change freely. Lists
  what has already been fixed and what is still outstanding.

How things were found: **golden path** means `node eval/verify.mjs`, 51
deterministic drivers that solve every task through our own MCP — so any finding
there is reproducible on demand for nothing. **measured** means it moved a number
in a recorded agent run under `results/`.

---

# Part A — upstream `firefox-devtools-mcp`

## A1. Snapshot text is capped twice; only 27 characters survive
`src/firefox/snapshot/injected/attributeCollector.ts` caps at
`MAX_TEXT_LENGTH = 100`, then `src/firefox/snapshot/formatter.ts` applies
`MAX_ATTR_LENGTH = 30` through a `truncate()` that returns
`substring(0, maxLen - 3) + '...'`. Net 27 characters of content, on `text`,
`name`, `value`, `href` and `src` alike.

**Makes at least one task unwinnable from the snapshot alone.**
`register-errors` requires reading server-issued corrections and resubmitting;
they arrive as `"Use your work address priya..."` and
`"Must be the 5-digit ZIP 606..."` — cut exactly where the corrected value
starts. Also hides the graded datum in `beta-terms`, `unit-quote`,
`fee-schedule`, `handbook`, `gov-lookup`, `mfa-login` (33-char welcome phrase),
`embargo-wait` (34-char headline), and all 20 titles in `news-extract`.

Confidence: high (source-verified, reproduced by golden paths).
Blast radius if changed: every snapshot's size. Measure carefully.

## A2. Table content never reaches the snapshot
`isRelevant()` in `src/firefox/snapshot/injected/elementCollector.ts` whitelists
interactive/semantic/container tags but not `table`, `thead`, `tbody`, `tr`,
`td`, `th`, `caption`, nor `font`. Table pages are invisible through the uid
surface: `gov/fee-schedule.html` yields no figures at all, the legacy `gov/` site
reduces to a bare link list, and interactive descendants bubble up **without
their row context**.

**The only finding here with a measured cost.** On `oos-substitute`, whose answer
lives in a `<table>`, we spend **3442 output tokens against playwright-mcp's
2189 — 57% more** (medians of 3 repeats per condition; the run directory is local and gitignored —
`node eval/bundle.mjs <run-dir>` packages it if the numbers need to travel).
playwright-mcp's ARIA snapshot carries the rows; ours does not — confirmed by
driving it at the same URL (10,635 chars of ARIA YAML containing the cell values).

Confidence: high. Reproduced independently by three agents, including on a
pre-existing fixture. **Highest-value change in this document.**

## A3. Controls lose their accessible names
- `<label><input type=radio> Yes</label>` emits `input value="Yes"` with no
  accessible name; a consent checkbox is findable only as the unique
  `input value="on"`.
- Repeated form rows (`roster` attendee inputs) have no accessible name at all
  and are addressable only by document order.
- `<option>` elements are never emitted, so a `<select>`'s choices are unknowable
  until one is selected — and the only tool-visible signal that a cascaded select
  populated is that typeahead happened to take.
- `<fieldset>`/`<legend>` are dropped, so radio groups lose their grouping.

Confidence: high (golden paths for `form-gauntlet`, `roster`, `office-finder`,
`unsub-dark-patterns` all had to work around it). Likely why playwright-mcp is
cheaper on form-heavy tasks.

## A4. Checkbox and ARIA state are absent from the snapshot
A pre-checked box renders as `input "Yes, keep sending me the Te..." value="on"`
— no `checked` marker, no `checkbox` role. `"on"` is the HTML attribute, not the
state. `aria-expanded` and `aria-disabled` are in the DOM but emit no token
either (`aria-label` does come through, as `name`).

**Consequence: an agent driving `unsub-dark-patterns` through the snapshot alone
cannot see the thing the task grades** — whether the trap box is ticked, or
whether clicking it cleared it. Any task grading on expanded/disabled state is
likewise unwinnable.

Confidence: high (golden path). This is the most consequential gap after A2.

## A5. `fill_by_uid` fails silently in three ways
`src/tools/input.ts`.
- **Non-editable target**: reports success, does nothing. `<h2>Promotion code</h2>`
  above `<input aria-label="Promotion code">` matches first, so filling the
  heading no-ops and the page reports "Enter a code first."
- **`<input type=date>`**: accepts only ISO. `08/12/2026` leaves the field empty
  and reports success.
- **Stale uid**: any `take_snapshot` invalidates prior uids; filling a stale one
  is a no-op reported as success (compounded by B1).

Confidence: high — each cost real debugging time while authoring golden paths.
An error on a non-editable target would turn a hunt into a one-line diagnosis.

## A6. `take_snapshot` defaults to 100 lines, which truncates realistic pages
All six shop pages need `maxLines: 500` (the hard cap) before their controls are
visible; the 24-card voltro listing sits at the cap. An agent taking a default
snapshot of a realistic catalogue sees roughly the first two cards. `find`
searches only the returned text, so a node past the cap is invisible to `find`
even though it exists.

## A7. `href` and `src` are absolutized, then truncated to 27 chars
Every link renders as `href="http://127.0.0.1:PORT/gov/..."`, so hrefs cannot
identify or disambiguate links. Concretely: the two roster links (`2025.html`,
`2026.html`) have identical truncated names **and** identical truncated hrefs, so
the snapshot cannot tell them apart. Reporting a URL requires `location.href` via
`evaluate_script`.

## A8. Missing tools
- **No key-press tool.** `modal-escape` sanctions dismissal by Escape *or* the
  close button; only the button is reachable, so half its sanctioned exits are
  tool-inaccessible. Also blocks the planned keyboard-only task (T061).
- **No scroll tool.** `src/tools/` has click/hover/fill/drag/upload/select and
  `set_viewport_size`, nothing that scrolls — so streaming a virtualized list can
  only be done by assigning `scrollTop` from `evaluate`.
- **No `select_option_by_uid`.** `fill_by_uid` on a `<select>` works by accident
  of key-based option matching; it breaks on labels not unique by prefix.
- **No coordinate click.** Canvas tasks need an `evaluate`-dispatched `MouseEvent`.

## A9. `evaluate_script` arg limitation
`args` accepts only `{uid}` objects, not plain values, so passing a number into
the page means string-interpolating the function source.

## Suggested order for Part A
Re-run `node eval/verify.mjs` plus a `--repeat 3` acceptance pass after each, so
every change has a measured before/after.

1. **A5** (silent `fill_by_uid` failures) — behaves like a plain bug; small blast radius.
2. **A2** (table content) — the one measured cost, highest value.
3. **A3 + A4** (accessible names, checkbox/ARIA state) — likely the next largest, on forms.
4. **A1** (27-char cap) — biggest blast radius; changes every snapshot's size.
5. **A8** (missing tools) — additive, unblocks planned tasks.
6. **A6, A7, A9** — cheap and independent.

---

# Part B — `firefox-cli` and the shared client lib

The `cli` condition is opt-in and slated to move out of this eval, so these are
separable from Part A. B1 is the one that also affects anything else using
`cli/lib/mcp.mjs`.

## B1. `callTool` surfaces failure as `isError` on the result, without throwing
`cli/lib/mcp.mjs`. A caller that does not inspect `result.isError` sees a
successful-looking response for a failed call. Combined with A5 this produces
silent no-ops that look like success; it caused two false-negative bugs while
authoring golden paths, which now wrap every mutating call in a helper that
throws. **Cheapest fix in this document and no measurement impact.**

## B2. `screenshot` ignores its flags
`--full-page` and `--output` are silently ignored; the file still lands in the OS
temp dir. No full-page mode exists, and `screenshot_by_uid` on a tall element
returns a viewport-clipped image rather than the element.

## B3. `find` ergonomics
Exits non-zero on no-match (so a shell `&&` chain dies on a legitimate
"not found"), and its context lines also carry `uid=`, so "take the last uid from
find output" can select a non-matching element. Plausible contributor to the
`checkout-stop` wrong-card failures.

## B4. `fill` gaps
Cannot set a `<select>`. In one run a rename POST fired ~260 ms **before** the
Save click and not in a repeat, suggesting `fill` sometimes commits on its own
(stray Enter/keydown) — a flake source for any commit-on-Enter form.

## B5. `snapshot` exposes no `includeAll` / `--max-lines`
The MCP tool takes both; the CLI wrapper exposes neither, so the cli surface must
drop to `call take_snapshot '{"includeAll":true,"maxLines":300}'` to see a table
or a long page.

---

# Part C — the eval harness

## Already fixed
- Validator brittleness, repeatedly our most common defect: `injection-bait`
  punished agents for *describing* a refused injection; `rename-rollback` failed
  on a negated name claim ("No file named draft-final exists"); T054's cascade
  ordering false-failed a peek-then-drive solve; T058's tie-break masked
  wrong-row edits; T066's modal became undismissable after its own detector fired.
- Documentation said the snapshot truncates at 30 chars; it is 27 (A1). That error
  had propagated into every wave's fixture-design brief.
- `maxTurns` removed — a cli Bash call performs 1.21 browser ops per turn vs
  mcp's 1.00, and codex only approximates turns, so turns are neither a fair
  metric nor a usable limit. Replaced by per-task wall tiers plus `--max-output`.
- Infra errors were counted as task failures (~31% of recorded non-passes);
  `--retries` now retries transient API errors, and a wall stop is retried while
  an output-token stop is not.
- Reports show `median (min-max)` and flag >2x output-token spread, after a task
  was found swinging 7/33/8 turns across identical repeats.
- Conditions equalized: every condition gets a shell (non-cli without the
  `firefox-cli` wrapper on PATH), and the two MCP conditions share a
  byte-identical prompt. The cli cheatsheet's "prefer find" hint was removed —
  coaching one condition biased the metric.
- `pages/index.html` moved out of the served root: it was reachable at `/` and
  spoiled three tasks' answers.

## Outstanding
- **Nonce-gate the static tasks** so they must route through the browser. Lower
  priority than it looked: the curl path was never actually exercised (one curl
  call per full run, fetching a page's own `app.js`).
- **A prose judge for narrative validators.** `rename-rollback` is a language
  judge implemented as ~30 lines of regex with hedge/negation handling and has
  already produced one false fail. A published-rubric LLM judge would be less
  brittle for the 3-4 prose tasks.
- **Exclude infra-error rows from pass totals** in the report, not just retry them.
- **Stop reporting absolute cost across runs** — `cache_creation` swung 6x
  between runs, moving a cost ratio from 1.50 to 1.03 with identical turn counts.
- **Task value review on the us-vs-playwright axis.** An earlier review proposed
  cutting ~12 tasks for showing no cli-vs-mcp separation, but that was the wrong
  axis: several of those (`fee-schedule`, `crm-join`, `roster-diff`, `ledger-sum`,
  `grid-edit`) sit on the A2 table gap and are likely our best playwright
  discriminators. Re-evaluate only after a clean baseline.
- **Two straggler tasks** are no longer blocked: T052 (upload) and T067 (viewport)
  were "blocked on a missing CLI command", but our MCP has `upload_file_by_uid`
  and `set_viewport_size` and playwright-mcp has equivalents — so they are
  buildable now that `cli` is opt-in. T061 (keyboard-only) remains blocked by A8.
