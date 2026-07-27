# firefox-devtools-mcp: findings from the eval suite

Product findings about OUR OWN MCP server, gathered while building and verifying
the eval suite in this directory. Deliberately NOT fixed: the suite measures
these gaps, so fixing one without a recorded before/after destroys the evidence
that justifies it. See the TOOL-FIX FREEZE note in `staging/BRIEFING.md`.

Each entry says how it was found, what it costs, and how confident we are.
"Golden path" means `node eval/verify.mjs` — deterministic drivers that solve
each task through our own MCP, so a finding there is reproducible on demand and
costs nothing to re-check.

---

## 1. Snapshot text is capped twice; only 27 characters survive

`MAX_TEXT_LENGTH = 100` (`src/firefox/snapshot/injected/attributeCollector.ts`)
then `MAX_ATTR_LENGTH = 30` (`src/firefox/snapshot/formatter.ts`), whose
`truncate()` returns `substring(0, maxLen - 3) + '...'`. Net: 27 characters of
content per node, applied to `text`, `name`, `value`, `href` and `src` alike.

**This makes at least one task unwinnable from the snapshot alone.**
`register-errors` requires reading server-issued corrections and resubmitting;
they render as `"Use your work address priya..."` and
`"Must be the 5-digit ZIP 606..."` — truncated exactly where the corrected value
begins. Also hides the graded datum in `beta-terms`, `unit-quote`,
`fee-schedule`, `handbook`, `gov-lookup`, and all 20 titles in `news-extract`.

Confidence: high (source-verified constants, reproduced by golden paths).
Impact: agents must fall back to `evaluate_script` for any prose answer, which
is 20-26% of all browser operations in recorded runs.

## 2. Table content never reaches the snapshot

`isRelevant()` in `src/firefox/snapshot/injected/elementCollector.ts` whitelists
interactive/semantic/container tags but not `table`, `thead`, `tbody`, `tr`,
`td`, `th`, `caption` (nor `font`). Table-based pages are therefore invisible
through the uid surface: `gov/fee-schedule.html` yields no figures at all, and
the whole legacy `gov/` site reduces to a bare link list.

**This is the only gap so far with a measured cost against playwright-mcp.**
On `oos-substitute`, whose answer lives in a `<table>`, we spend 3442 output
tokens (median of 3) against playwright-mcp's 2189 — **57% more** — because
playwright's ARIA snapshot carries the rows and ours does not.
Measured: `results/run-2026-07-27T16-34-35-337Z`, 3 repeats per condition.

Confidence: high. Reproduced independently by three separate agents, including
on a pre-existing fixture, and confirmed by driving playwright-mcp at the same
URL (10,635 chars of ARIA YAML containing the cell values).

## 3. Controls lose their accessible names

- `<label><input type=radio> Yes</label>` emits `input value="Yes"` with no
  accessible name; a consent checkbox is findable only as the unique
  `input value="on"`.
- Repeated form rows (the `roster` attendee inputs) have no accessible name at
  all and are addressable only by document order.
- `<option>` elements are never emitted, so a `<select>`'s choices are unknowable
  until one is already selected — and the only tool-visible signal that a
  cascaded select has populated is that typeahead happened to take.

Confidence: high (golden paths for `form-gauntlet`, `roster`, `office-finder`
all had to work around it). Likely a contributor to playwright-mcp being cheaper
on form-heavy tasks, since ARIA snapshots name these controls.

## 4. `fill_by_uid` fails silently in three ways

- On a **non-editable target** it reports success and does nothing. A
  `<h2>Promotion code</h2>` above `<input aria-label="Promotion code">` matches
  first, so filling the heading silently no-ops and the page reports "Enter a
  code first." An error on a non-editable target would turn a hunt into a
  one-line diagnosis.
- On `<input type=date>` it accepts **only** ISO (`2026-08-12`); `08/12/2026`
  leaves the field empty and reports success.
- On a **stale uid** (any `take_snapshot` invalidates prior uids) it is a no-op
  that reports success — see finding 5.

Confidence: high (each cost real debugging time while authoring golden paths).

## 5. `callTool` surfaces failure as `isError` on the result, without throwing

`cli/lib/mcp.mjs`. A caller that does not inspect `result.isError` sees a
successful-looking response for a failed tool call. Combined with finding 4 this
produces silent no-ops that look like success; it caused two false-negative bugs
while authoring drivers, which now wrap every mutating call in a helper that
throws on `isError`.

Confidence: high. This one is arguably a plain bug rather than a surface
tradeoff, and the cheapest of the set to fix.

## 6. `take_snapshot` defaults to 100 lines, which truncates realistic pages

All six shop pages need `maxLines: 500` (the hard cap) before their controls are
even visible; the 24-card voltro listing sits right at the cap. An agent taking
a default snapshot of a realistic catalogue sees roughly the first two cards.
`find` searches only the returned text, so a node past the cap is invisible to
`find` even though it exists — and `firefox-cli` exposes no `--max-lines`.

Confidence: high (golden paths for all shop tasks).

## 7. `href` and `src` are absolutized then truncated to 27 chars

Every link renders as `href="http://127.0.0.1:PORT/gov/..."`, so hrefs cannot
identify or disambiguate links; links are selectable only by name, which is
itself capped at 27. Reporting a URL requires `location.href` via
`evaluate_script`.

Confidence: high.

## 8. Missing tools

- **No key-press tool.** `modal-escape` sanctions dismissal by Escape *or* the
  close button; only the button is reachable, so half its sanctioned exits are
  tool-inaccessible. This also blocks the planned keyboard-only task (T061).
- **No `select_option_by_uid`.** `fill_by_uid` on a `<select>` works by accident
  of key-based option matching — it would break on labels that are not unique by
  prefix.
- **No coordinate click.** Canvas tasks need an `evaluate`-dispatched
  `MouseEvent`.
- **ARIA state attributes never reach the snapshot** (`aria-expanded`,
  `aria-disabled` are in the DOM but emit no token), so any task grading on
  expanded/disabled state through the snapshot is unwinnable. `aria-label` does
  come through, as `name`.

## 9. `firefox-cli` bugs (the shell surface, now opt-in)

- `screenshot` silently ignores `--full-page` and `--output`; the file still
  lands in the OS temp dir. No full-page mode exists, and `screenshot_by_uid` on
  a tall element returns a viewport-clipped image.
- `find` exits non-zero on no-match, and its context lines also carry `uid=`, so
  "take the last uid from find output" can select a non-matching element. This is
  a plausible contributor to the `checkout-stop` wrong-card failures.
- `fill` cannot set a `<select>`; `fill` may commit an edit on its own (a rename
  POST fired ~260 ms before the Save click in one run, not in a repeat).

---

## Suggested order, if these get fixed

Fix in this order and re-run `node eval/verify.mjs` plus a `--repeat 3`
acceptance pass after each, so every fix has a measured before/after:

1. **Finding 5** (`isError` not thrown) — plain bug, no surface change, no effect
   on measurements.
2. **Finding 4** (silent `fill_by_uid` failures) — same character.
3. **Finding 2** (table content) — the one gap with a measured token cost, and
   the highest-value change to our snapshot.
4. **Finding 3** (accessible names) — likely the second-largest, on forms.
5. **Finding 1** (27-char cap) — highest blast radius; raising it changes every
   snapshot's size, so measure carefully.
6. **Finding 8** (missing tools) — additive, unblocks planned tasks.

Findings 6 and 7 are cheap and independent. Finding 9 is separable since the
shell surface is now opt-in.
