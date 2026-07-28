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

How things were found: **golden path** means `node eval/verify.mjs`, 65
deterministic drivers that solve every task through our own MCP — so any finding
there is reproducible on demand for nothing. **measured** means it moved a number
in a recorded agent run under `results/`.

---

## The headline, as of wave 10

Waves 4-9 built fixtures with an explicit instruction to design *around* our
snapshot's limits. That kept tasks winnable but meant the suite could only
rediscover gaps we already suspected. Wave 10 suspended that rule and built four
sites in their genres' natural idioms — a real diff table, a real booking grid, a
growing chat transcript, a real two-tab payment handoff — then measured both
surfaces on them.

**Result: on two of the four, playwright-mcp has a snapshot-only solve path and we
have none at all.** Not "ours is more expensive" — ours cannot do it from the
snapshot, at any cost, and must drop to `evaluate_script`. That is a categorically
stronger finding than anything the previous six waves produced, and it is a direct
consequence of no longer letting fixture authors route around the gap.

The corollary matters for how every cost number in this document is read: we look
cheaper on dense pages (4x cheaper per snapshot, 2.8x over a solve) largely
because we stop looking and start scripting. **A token comparison on a dense page
is not meaningful unless it says whether a snapshot-only path existed.**

---

# Part A — upstream `firefox-devtools-mcp`

## A0. `take_snapshot` CRASHES on a page whose inline SVG contains an `<a>`
An `<svg>` containing `<a href="#x">` makes `take_snapshot` fail for the WHOLE
page with `Failed to take snapshot: str.substring is not a function`. An SVG
anchor's `href` is an `SVGAnimatedString`, not a string, and the formatter calls
`.substring()` on it while truncating.

This is the only finding here that takes the entire tool surface down rather than
degrading it: one such element anywhere on the page and the agent cannot snapshot
at all. Severity aside, it is also the cheapest to fix — coerce before truncating.

Confidence: high (reproduced while building the floorplan fixture; the fixture
now avoids SVG anchors specifically to route around it).

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

## A2b. Whole containers vanish when they hold a non-relevant inline tag
Worse than the tag-drop in A2: a `<font>` (or any tag missing from the relevance
lists) **inside** a `<p>` deletes the entire paragraph from the snapshot — not
truncated, not bubbled up, gone. `isRelevant()` sees the parent's child list and
discards the lot. Confirmed on `gov/rv7a-instructions.html`, where
`<p><b>Where to file Form RV-7A</b></p>` leaves a uid gap. `<dl>/<dt>/<dd>` are
dropped exactly like tables.

Practical effect: on a legacy page that uses `<font>` or `<b>` inline — which is
most of the `gov/` site — prose disappears wholesale rather than degrading.

Third independent confirmation in wave 9, this time for `<em>`:
`<li>Maximum size <em>1024 bytes</em></li>` snapshots as `li text="Maximum size"`,
and a `<b>`-wrapped breadcrumb became `div text="Attestations ›  ›"`. So a
constraint a page emphasises typographically is exactly the content most likely
to vanish.

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

## A4. Checkbox and ARIA state are absent from the DEFAULT snapshot
A pre-checked box renders as `input "Yes, keep sending me the Te..." value="on"`
— no `checked` marker, no `checkbox` role. `"on"` is the HTML default attribute,
not the state.

**Refined by wave 8: this is a DEFAULTS problem, not a missing capability.**
`take_snapshot` defaults to `includeAttributes: false`, so `checked`, `expanded`
and `disabled` never appear unless the caller knows to ask. An agent taking a
plain snapshot therefore cannot see the state, and nothing in the tool
description signals that a flag would reveal it. Flipping the default (or
surfacing state regardless of the flag) is a much smaller change than it looked
when this was first written.

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
Concrete margin: the `news/` front page fits 7 story entries into the default
snapshot, the last ending at line 96 of ~100. `injection-bait` needs entry 6, so
it clears by a single entry — any future line added above it pushes the task's
target out of reach through the snapshot. Semantic markup costs more lines here
than the table markup it replaced, so this margin shrank from ~9 entries to 7.
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

## A9b. `evaluate_script` has a hard 5-second default timeout
`DEFAULT_TIMEOUT = 5000` in `src/tools/script.ts`. Awaiting the `timeout-vs-slow`
fixture's 8-second fetch dies at 5008 ms with "Script execution timed out
(exceeded 5000ms)"; the same call with `timeout: 15000` returns at 8012 ms.
playwright-mcp's `browser_evaluate` has **no** such cap and returned the awaited
payload at 9036 ms.

The aborted script does not abort the request — it still lands server-side. So an
agent that reads the timeout as "the site hung" both reports the wrong thing and
consumes one of the task's allowed requests. A default that silently caps below
common real-world latency, on a surface where the competitor has none, is worth
raising even though the polling path is unaffected.

## A10. SVG is effectively unusable through the tool surface
- A shape is emitted only if the author gave it `role` or `aria-label`; a bare
  `<rect class="room" data-room="A-1">` is dropped, as are `<text>` nodes.
- A `<g role="button" aria-label="...">` IS emitted, but `click_by_uid` on it
  fails with `could not be scrolled into view` — so it is visible and unclickable.
- No geometry is carried at all (no x/y/width/height, no bounding box, no
  ordering guarantee), so spatial reasoning over a diagram is impossible from the
  snapshot even when the shapes are named.
Combined with A0, any SVG-based interface is `evaluate`-only today.

## A11. `set_viewport_size` resizes the window, not the viewport — and reports success either way
`src/firefox/pages.ts:73` implements it as
`driver.manage().window().setRect({width, height})`. Headless Firefox clamps the
window to a ~500 px minimum, so `set_viewport_size(480, 900)` leaves
`window.innerWidth === 500` while the tool still reports `480x900`. Measured
ladder (requested -> actual `innerWidth`): 375->500, 400->500, 480->500, 520->520,
560->560, 600->600, 640->640. Height is likewise window height, not viewport
height (800 requested -> `innerHeight` 715).

The good news, verified: the media query genuinely re-evaluates and
`matchMedia`/`getComputedStyle`/`resize` all fire, so responsive tasks are viable.

Impact: any phone-width breakpoint below 500 px is **unwinnable through our MCP
and winnable through playwright-mcp's `browser_resize`**, which sets the viewport
independently of the window — and it would present as agent failure, not tool
failure, because nothing reports the clamp. Fix: use the WebDriver-BiDi viewport
override rather than `setRect`, and return the size actually achieved.
`narrow-viewport` is deliberately built with a 600 px breakpoint to stay clear of
this, and its golden path asserts `matchMedia(...).matches` rather than trusting
the requested number.

## A12. An `<input>`'s `type` never reaches the snapshot
A file input and a checkbox both render as a bare `uid=N input`. `accept` is not
emitted either, and (per A4) a checked box shows `value="on"` exactly like an
unchecked one. So an agent cannot tell which control is the file input except by
position or by attempting an upload and reading the error, and cannot confirm
that its click ticked rather than un-ticked a box. playwright-mcp's ARIA snapshot
labels both control kinds.

## A13. Attribute values are emitted with escape sequences interpreted
A file input holding `C:\fakepath\t052-attest.csv` printed as
`value="C:akepath<tab>052-attest.csv"` — the `\f` and `\t` became a formfeed and a
tab. Any attribute value containing backslashes is corrupted in the agent's view
and cannot be matched against.

## A14. The snapshot tree is not stable across captures of an unchanged DOM
Between two consecutive `take_snapshot` calls on a page that did not change, a
short `<span>Or <a>...</a>.</span>` lost its span node and the anchor was
re-parented directly under the preceding `<button>`. An agent or driver that
navigates by tree structure rather than by text can therefore resolve a different
element from one snapshot to the next.

## A23. Tab management: `window.close()` destroys our whole view of the browser
With three tabs open, one page calling `window.close()` left `list_pages`
reporting `1 pages (selected: 0) > [0] Untitled` at `about:blank`, with the other
tabs unreachable and `select_page(0)` unable to recover. playwright-mcp recovered
cleanly onto a surviving tab.

**This is the most severe finding in Part A.** Payment and OAuth popups call
`window.close()` as a matter of course, so an agent doing an ordinary third-party
authorization loses its entire session and every open tab — and it would read as
agent failure, not tool failure. The `cross-tab-pay` fixture ships **no**
self-close button purely to avoid triggering it, which makes the fixture less
realistic than a real processor page.

## A24. `close_page` on the last remaining tab bricks the instance
It answers `Error: Tried to run command without establishing a connection` and
leaves a phantom `Untitled` tab; nothing works afterwards. playwright answers
`No open tabs. Navigate to a URL to create one.` and stays usable. So an agent
that tidies up after itself can destroy its own session. Any cleanup loop must
stop at index 1, which is what the harness now does.

## A25. Nothing tells the agent a new tab opened
Clicking a `target=_blank` link opens a real second tab, but no tool response
mentions it and the tool-side selection stays on the opener — the agent has to
guess to call `list_pages`. playwright appends an `### Open tabs` section to
**every** action result. Same shape as A18 (console state): the competitor
volunteers state we make you ask for. Pure turn cost, and a plausible cause of
one-tab thrashing on exactly the flows `cross-tab-pay` measures.

## A26. `list_pages` omits URLs, contradicting its own description
The description says "List open tabs (index, title, URL)"; `formatPageList` in
`src/tools/pages.ts` prints index and title only. Two authorizer tabs are
therefore indistinguishable in our listing, and an agent must select each and
snapshot to tell them apart. playwright shows full URLs. (Selecting *by* URL
substring does work — it is only the listing that hides it.)

## A27. Background tabs are throttled under our surface but not playwright's
A 500ms interval in a non-selected tab measured **0.75 ticks/s** against 2.0
ticks/s while selected; playwright showed 2.0/s throughout. `select_page` fires
blur/visibilitychange/focus where playwright's select fires focus only.
`document.visibilityState` is `"visible"` and `hasFocus()` true in *both* tabs, so
a page cannot detect which tab is fronted.

Impact: a polling page reflects cross-tab state ~2.5x slower under our surface —
a real condition asymmetry on any wait-for-state task, and a page keying on
`visibilitychange` behaves differently between conditions. The fixture polls every
1200ms and refreshes on `focus` to stay neutral.

## A28. Every `take_snapshot` invalidates all prior uids, even on an unchanged page
`Error: 1_35 stale/invalid. Call take_snapshot first.` after a re-snapshot of a
page that did not change. playwright refs survived both a re-snapshot and a DOM
mutation, because they resolve by role plus accessible name. Every read-then-act
burst on our surface therefore costs an extra call.

Worth stating the flip side honestly, since it is the one place our design is
arguably better: a stale playwright ref that still resolves silently targets the
*wrong* element (observed typing into "Start time" when "Day" was meant), whereas
ours fails loudly. The fix is not to copy their laxity but to keep uids valid
while the DOM is unchanged.

## A29. `includeAll` surfaces table cells but not the geometry needed to read them
`take_snapshot({includeAll: true})` emits the 140 `td` nodes with their text
(10.1k chars) but **no `rowspan`/`colspan` and no cell roles**, and span-covered
cells are simply absent — so rows carry anywhere from 4 to 15 cells. Column
identity is unrecoverable: the only available reconstruction (read left to right)
disagreed with the DOM on 112 cells and produced a confidently wrong answer.
Two different weeks can emit byte-identical snapshots.

playwright's ARIA snapshot has the identical gap — but it also offers
`browser_snapshot({boxes: true})`, whose `[box=x,y,w,h]` annotations resolve to
exactly 15 columns and give each block's span, so **the answer is recoverable from
its snapshot alone and not from ours**. We expose no geometry option at all.
Minimum solves measured: playwright 7 calls with zero `browser_evaluate`; ours 8
calls, one of which *must* be `evaluate_script`.

## A30. `take_snapshot`'s selector option fails opaquely
`{selector: 'table.diff'}` (and `'.dock'`, and `'table.daybook'`) fails with
`Failed to take snapshot: Failed to generate snapshot: Unknown error` — including
the case where the element exists but is `[hidden]`, where the honest answer is
"not visible". playwright's `browser_snapshot({target})` returned a scoped 9.7 KB
subtree of the same page. So on a large page we must pay for the whole tree or
drop to `evaluate`, and the error message actively misleads.

## A31. `MAX_DEPTH = 10` is exactly on the edge for ordinary markup
`body > chrome > main > div#diff > section > div > table > tbody > tr > td >
button` puts the diff's gutter buttons at depth 10 — the limit. **One more
wrapper div, or syntax highlighting that wraps tokens in spans inside the code
cell, and the entire diff vanishes from our snapshot.** The `forge` fixture serves
plain unhighlighted code in a single span, and that concession is load-bearing for
our surface seeing anything at all. Real code hosts all highlight.

## A32. There is no wait primitive, and polling costs 67% more tokens
No `wait_for` / `wait_for_text` tool exists, so the only way to learn that an
async reply landed is to re-`take_snapshot` and diff. On `support-chat` the golden
path spent 17 whole-page snapshots purely waiting. Measured on the identical flow:
**32 calls / 94,131 result chars for us vs 22 calls / 56,334 for playwright** —
67% more output while returning strictly less information (see A1: our transcript
is truncated at 27 chars per message, theirs is not).

**Confirmed with real agents, and it is the largest measured loss in the suite.**
`support-chat`, 3 repeats per condition, medians: **2,491 output tokens for us vs
1,768 for playwright (+41%)**, and **84.3s vs 55.4s of wall time (+52%)** — so
unlike the driver micro-benchmark we lose the clock too, once a real agent is
choosing when to poll (44-50 thread polls for us against 27-43). The run is about
as clean as this suite gets: our output spread across repeats was 1.01x.

**Corroborated in wave 11, in an unrelated genre.** `live-auction` (a saleroom
whose price advances on a server clock) was commissioned partly to re-test this,
and it reproduced: **4,130 output tokens for us vs 2,759 for playwright, +50%**,
medians of 3 repeats. Two different genres, same direction, same cause. This is
therefore a property of our surface rather than of one fixture — the strongest
repeatable loss the suite has measured.

That makes A32 the most actionable item in Part A. It is purely **additive** — a
new tool, no behaviour change to anything existing — and it is worth 41-50% of
output tokens on async pages, which real sites are full of. Note playwright's
`browser_wait_for` has its own hard 5000ms default with no extension, so a slower
queue would make their ergonomic tool the fragile one; we could ship a better
version rather than a copy.

## A33. The 27-char cut is not Unicode-safe: it emits lone surrogates and eats combining marks
A sibling of A1, and a straightforward product bug rather than a design tradeoff.
`formatter.ts`'s `truncate()` slices at UTF-16 index 27 — a **code-unit** index,
not a codepoint index, and with no grapheme awareness. Two consequences, both
measured against `pages/intl/` (the Qandara advisory site, `locale-notice`) and
cross-checked against playwright-mcp, which is intact in every case.

**It splits surrogate pairs.** The Japanese edition's translator credit
(`この日本語版は、アラビア語で公表された原文をもとに、𠮷田海運株式会社が翻訳しています。` — an
ordinary sentence; `𠮷` U+20BB7 is a common surname character) has its pair at
units 26-27, so our snapshot returns
`text="この日本語版は、アラビア語で公表された原文をもとに、\ud842..."`. That is a **lone high
surrogate in the MCP JSON payload**; encoded to UTF-8 for a terminal or a log it
becomes `ef bf bd` (U+FFFD).

**It drops combining marks silently, with no ellipsis to mark the loss.** A
controlled probe (seven strings with the interesting codepoint placed at exactly
UTF-16 index 26 or 27):

| probe | ours | playwright-mcp |
| --- | --- | --- |
| `ア`×26 + `𠮷田海運` (pair straddles the cut) | `…ア\ud842...` → U+FFFD on the wire | intact |
| `ア`×25 + `𠮷田海運` (30 units, at the cap) | intact | intact |
| `ア`×26 + `か`+U+3099 (dakuten at 27) | intact, not truncated | intact |
| `ب`×26 + `دّة الميناء` (shadda U+0651 at 27) | `…د...` — shadda dropped | intact |
| `ب`×26 + `رًا الحصول` (tanween U+064B at 27) | `…ر...` — tanween dropped | intact |
| `x`×26 + `e`+U+0301 + `clair` | `…e...` — **"é" silently becomes "e"** | intact |

To a reader of the language `د` and `دّ` are different words, and the truncation
is invisible: the mark falls off *inside* the surviving text, before the `...`.

**The cut is also not language-neutral.** Arabic averages ~1 unit per character
but ~6 characters per word, so 27 units is 4-5 Arabic words: 16 of 50 text nodes
(32%) truncate on the Arabic advisory page, versus 13/45 (29%) English and 9/51
(18%) Japanese — CJK is *least* affected because it packs more meaning per unit.
The knock-on for `find`, which only searches what the snapshot returned: the same
sentence is findable in one language and invisible in another
(`find "72時間"` matches, `find "72 ساعة"` finds nothing, same sentence).

Fix: slice on codepoints (or graphemes) rather than code units, and never emit an
unpaired surrogate. Cheap, and independent of whatever happens to the 27-char cap
itself.

Confidence: high (source-verified in `truncate()`, reproduced through both
surfaces on a controlled probe page).

## A33b. Nothing on either surface says a page is RTL, and `lang`/`dir` never reach the snapshot
Measured on the same site, and true of playwright-mcp too, so it is a gap rather
than a competitive loss. Neither surface carries `lang` or `dir` — not in the
default snapshot, not with `includeAll: true`, not in playwright's ARIA snapshot
(`grep -ciE 'lang=|dir=|rtl'` over the full `includeAll` output: 0). The only
signal that `/intl/ar/` is Arabic is that the text is Arabic, and `<p lang="ar"
dir="rtl">` inside an otherwise English page is indistinguishable from an
untagged Arabic string.

Both surfaces also emit **DOM (logical) order** on an RTL page, correctly — but
that means the snapshot's first-to-last order is not the left-to-right order a
screenshot shows, so a snapshot and a screenshot disagree about which of two
inline items comes "first", and nothing warns the agent. Accessible names built
from non-ASCII text are fine on both surfaces (`nav "النسخ"`,
`heading "北桟橋の閉鎖と入港許可の取得義務"`).

## A34. `includeAll` truncates a long table silently, and that is worse than seeing nothing
The dangerous state is not blindness, it is **partial data that looks complete**.
Measured on `pages/metrics/` (`chart-escape`): the honest way to read an 18-row
data table on our surface needs two non-default options together. With
`includeAll: true` alone the table arrives cut to **10 of 18 rows with no marker
that rows are missing**, and because the series is generated per session the
truncated window contains the true answer only sometimes — in ~30% of mints an
agent reading that state computes a **confidently wrong** steepest-drop month and
has no reason to doubt it. playwright-mcp returns the table in one default call.

This is the same failure mode as A29 (grid cells without geometry) and A19
(`isXHR` matching nothing): we do not say "there is more". A2/A6 describe the
mechanism; this entry exists because it is the first time the cost was measured
as *wrong answers* rather than extra tokens.

## A35. A `<table>` grid is invisible, but an `<input>`'s `value` comes through
Two halves of one measurement on `pages/calc/` (`formula-repair`), and the split
is the opposite of what we assumed when the fixture was commissioned.

- **Value layer, invisible.** The sheet is a semantic `<table>`; our snapshot
  returns one childless `main` node and **0 of 70 cells**. `find` misses every
  depot name. (A2 again, now on the canonical spreadsheet layout.)
- **Definition layer, visible.** The formula bar comes through as
  `input "Formula bar" value="=SUM(E3:E13)"`, because `treeWalker.ts` reads the
  `value` DOM *property*. Focusing a different cell is the one action that
  changes what we can see.

So the task is solvable on our surface, but only as a **blind solve**: the agent
never sees a number in the grid and must navigate by name box, formula bar and
status bar. Cost: **19-23 tool calls (12-14 of them snapshots) against
playwright's 8**, which sees both layers and all 16 formulas in a single snapshot
once "Show formulas" is on. Worth keeping as the clearest single illustration
that `value`-property reads are the one place our walker is *more* useful than it
looks — extending that treatment to more of the DOM is a cheap direction.

## A36. Canvas text is unreachable on both surfaces; `opacity: 0` is the one divergence
From the `canvas-log` verify-first spike, which was authorised to conclude "do
not ship" and instead established a legitimate route.

Neither our snapshot nor playwright's ARIA snapshot reads a single character
painted to a `<canvas>` — and our walker does not even emit the `<canvas>`
element in standard mode, so an agent gets no hint that a large region of the
page exists. Since real cloud consoles render logs exactly this way (xterm.js),
**a web terminal is unusable through either tool surface without an escape
hatch** (a search box that scrolls a real text hit into the DOM, or a fetchable
raw log). That is now recorded rather than assumed.

Offscreen DOM mirrors ARE reachable by both: `sr-only` clip-rect,
`left: -9999px`, transparent colour, `aria-live`, below-fold and
scrolled-out-of-overflow all snapshot fine. **The single divergence: an
`opacity: 0` element is dropped by us and kept by playwright.** Minor, but it
means a page using opacity for a fade-in shows them content it does not show us.

Also measured here, and a concrete cost for the default: with the log panel below
the step summary, `take_snapshot`'s default `maxLines: 100` pushed the graded hit
out of reach of `find` entirely (A6/B3 compounding). The fixture reorders its own
DOM to keep the task winnable — a concession that would not be available on a
real site.

---

## The devtools surface (A15-A21)

Found while designing a future wave, NOT by any shipped task — none of the 61
tasks touches console, network, the debugger or the profiler, which is half of
what makes us a *devtools* MCP. Full write-up and the proposed tasks are in
`devtools-wave-proposal.md`. Every item below was reproduced headless against a
scratch fixture and cross-checked against playwright-mcp on the same page.

**The competitive picture is the opposite of what we assumed.** playwright-mcp is
at parity or ahead of us on console and network: it returns failing response
bodies, prints full stack traces, attaches `@ url:line` to every message, and
appends `Console: N errors, M warnings` to *every* tool response so its agent is
prompted to look. We do none of that. The one axis we clearly win is retention
(below).

## A15. Console and network logs are silently emptied after five minutes
`CONSOLE_TTL_MS` and `NETWORK_TTL_MS` are both `5 * 60 * 1000`
(`src/firefox/events/console.ts:11`, `src/firefox/events/network.ts:10`). Entries
older than that are dropped, and `list_network_requests` then reports
`total: 0` with nothing to indicate anything was discarded. A 9-request log was
watched going empty mid-probe.

Our wall tiers run to 600s and 1800s, so a long task can ask about a request that
the tool has already forgotten — and be told, indistinguishably, that it never
happened. This is the worst of the set because it turns a correct answer into a
confidently wrong one. Note the irony: retention is otherwise **our advantage** —
playwright wipes its network log on every navigation with no way to opt out, so
any question asked after the failing step favours us. The TTL quietly gives that
advantage back on exactly the long tasks where it matters most.

## A16. Response and request bodies are never captured
Not stored at all, so a failing endpoint's error payload is unreachable through
our tools. playwright-mcp returns both (`part: "response-body"`, verified
verbatim). This is the single largest capability gap on the devtools surface.

## A17. Console messages carry no stack trace and no source location
An uncaught error arrives as bare `Error: <msg>` — no frames, no `url:line`.
Worse, the `source` field we *do* expose is `entry.source.realm`, a GUID, which
makes the documented filter useless for its apparent purpose. playwright prints
the full trace and appends `@ url:line` to every message.

## A18. Nothing in our output ever mentions console state
playwright appends `Console: N errors, M warnings` to every tool response, so its
agent learns for free that something is wrong. Ours stays silent until asked, and
an agent with no reason to suspect a console error will not ask. Cheap to fix and
probably the highest ratio of behaviour change to effort in this document.

## A19. `isXHR` matches nothing in Firefox
`src/firefox/events/network.ts:104` derives it from
`req.initiator?.type === 'xmlhttprequest' || 'fetch'`, which returned **zero**
rows on a page making nothing but `fetch` calls. `resourceType` is likewise
guessed from the URL string rather than reported by the browser. So the two
filters an agent would naturally reach for to isolate API traffic both fail
silently.

## A20. The logpoint lifecycle is broken, silently
- A logpoint set before a reload never collects again, and
  `get_logpoint_results` keeps returning the stale pre-reload results.
- `enable_debugger` does not re-arm it.
- A second logpoint on the same line never collects.
- `set_logpoint` on line 999 of a 12-line file reports success.

Together these kill the canonical instrument-then-reload workflow, which is the
main reason to have logpoints at all. Every failure is silent.

## A21. Transport failures are invisible
We do not subscribe to `network.fetchError`, so a connection-refused fetch is
absent from the log entirely and an aborted response reads as a clean `200`.
playwright is equally blind here, so this is a correctness gap rather than a
competitive one.

## A22. The profiler does not run on the Firefox the eval launches
It errors out on release 153 and needs 154+. Combined with playwright having no
profiling tool at all, a profiler task would be a zero-information row three
different ways.

Also, a project-rule violation rather than a defect: `src/tools/network.ts` emits
an emoji in the header of every `list_network_requests` response (lines 241, 257,
276). `AGENTS.md` forbids emoji anywhere in the codebase.

---

## Suggested order for Part A
Re-run `node eval/verify.mjs` plus a `--repeat 3` acceptance pass after each, so
every change has a measured before/after.

0. **A23** (a page calling `window.close()` destroys our view of the browser) and
   **A24** (`close_page` on the last tab bricks the instance). Promoted above A0
   because between them they mean an ordinary OAuth or payment popup can end a
   session outright, and no fixture can design around a real site's close button.
1. **A0** (SVG anchor crashes the snapshot) — a one-line coercion, and it is the
   only finding that disables the tool surface outright rather than degrading it.
2. **A4** (state behind a non-default flag) — now known to be a defaults change,
   not new capability, and it decides `unsub-dark-patterns`.
3. **A5** (silent `fill_by_uid` failures) — behaves like a plain bug; small blast radius.
4. **A2 + A2b** (table content, and containers vanishing around inline tags) —
   the one measured cost (57% on `oos-substitute`), plus wholesale prose loss on
   any legacy page.
5. **A3** (accessible names) — likely the next largest, on forms.
6. **A1** (27-char cap) — biggest blast radius; changes every snapshot's size.
7. **A8 + A10** (missing tools; SVG unusable) — additive, unblocks planned tasks.
8. **A11** (viewport clamp reported as success) — narrow blast radius today, but
   it is the one finding that makes a whole task class unwinnable for us and
   winnable for playwright, invisibly.
9. **A29 + A30 + A31** (table geometry, scoped snapshots, the depth limit) — the
   three that jointly decide whether a snapshot-only path exists on a dense page.
   A30 in particular is cheap: a working `selector` would let an agent afford to
   look at the region it cares about.
10. **A25 + A28 + A32** (announce new tabs; keep uids valid on an unchanged page;
    add a wait primitive) — all three are "stop making the agent pay for
    bookkeeping", and A32 is the measured 67% token gap on async pages.
11. **A26 + A27** (list URLs; background-tab throttling).
12. **A6, A7, A9, A9b, A12, A13, A14** — cheap and independent.

The devtools findings sit on their own track, since no shipped task measures them
yet. Order there: **A18** (free console cue — smallest change, largest behaviour
delta), **A15** (the 5-minute TTL, which silently converts a correct answer into
a wrong one on long tasks), **A17** then **A16** (stack traces, then response
bodies — the two things playwright has and we do not), **A19**, **A20**, **A21**.

Verified working, for contrast: `upload_file_by_uid` is sound end to end,
headless. It fires the change event, the page sees a real `File` with the right
name/size/`type`, `await file.text()` returns the bytes, and a bad path errors
clearly. It needs absolute paths. The "T052 is blocked" note that sat in
`task-ideas.md` for months was never true of the MCP surface.

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

Only the real match is marked, with a leading `>`; everything else is context.
Grepping the first `uid=` out of `find` output therefore yields a neighbour's uid
— it cost an implementer a silent click on a `<p>` instead of the button. An
agent that hits this reads it as "the click did nothing" and re-clicks or
reloads, which on `timeout-vs-slow` spends a request against the patience budget.
Printing matches and context on distinguishable streams, or a `--uids-only` mode,
would remove the whole class.

**Worse, found in wave 10: `find` is strictly less capable than the snapshot it
wraps.** `findInSnapshot()` calls `take_snapshot({})` with no `maxLines`, so it
only ever searches the first 100 snapshot lines and offers no way to widen them.
On the `forge` diff page, `find "evictOldest"`, `find "nextBoundary"`,
`find "describeRate"` and even `find "src/tariff/window.js"` (a plain `<a>`) all
returned **"no matches"** while the elements were plainly in the DOM. Reporting
absence rather than truncation is the harmful part: "no matches" reads as "the
thing is not there", so an agent stops looking. It should either pass a high
`maxLines` or say that it only searched the first N lines.

## B4. `fill` gaps
Cannot set a `<select>`. In one run a rename POST fired ~260 ms **before** the
Save click and not in a repeat, suggesting `fill` sometimes commits on its own
(stray Enter/keydown) — a flake source for any commit-on-Enter form.

## B5. `snapshot` exposes no `includeAll` / `--max-lines`
The MCP tool takes both; the CLI wrapper exposes neither, so the cli surface must
drop to `call take_snapshot '{"includeAll":true,"maxLines":300}'` to see a table
or a long page.

## B6. Whole MCP tools have no verb, and the cheatsheet does not admit it
There is no `resize` and no `upload` verb (grep of `bin/firefox-cli.mjs` and
`lib/*.mjs` finds neither); the only route to either is the generic
`firefox-cli call <tool> '<json>'`. That would be fine, except `CLI_CHEATSHEET`
(the cli condition's entire advertised surface) lists only open/find/snapshot/
click/fill/eval — it never mentions `call` or `tools`. So on `narrow-viewport`
and `file-upload` the cli condition's documented options are to guess that an
escape hatch exists, or to forge the result with the `eval` verb that *is*
documented. Either way the measured quantity becomes "did the agent go
off-cheatsheet", not "can this surface do the task".

Deliberately not fixed: `cli` is opt-in and outside the default comparison, so
this only distorts a cli run. If cli data is ever wanted on these two tasks,
either ship `resize`/`upload` verbs or add `tools` and `call` to the cheatsheet
first — and note that either change makes cli numbers non-comparable with earlier
runs.

## B6b. `open` creates a tab where `goto` navigates in place
`firefox-cli open <url>` opens a NEW tab; `goto` navigates the current one. A
`sessionStorage`-backed widget therefore looks broken when driven with `open` (the
chat did not reopen), and seven tabs accumulated during one manual probe. This is
condition-asymmetric: our `navigate_page` and playwright's `browser_navigate` both
navigate in place, so only the `cli` surface sees it. Related: `find` takes a
fresh snapshot, which invalidates uids from the previous one (A28), so
`find`-then-`click` is only safe on the uids `find` itself just printed.

Also cosmetic but a real discovery cost: the screenshot tool is `screenshot_page`,
not `take_screenshot`, diverging from both our own `take_snapshot` convention and
playwright's `browser_take_screenshot`.

## B7. `eval` cannot pass `evaluate_script`'s `timeout`
`lib/mcp.mjs` builds only `{function, args}`, so from the cli an awaited fetch
slower than 5 s is unconditionally fatal (A9b). Workaround is the passthrough:
`firefox-cli call evaluate_script '{"function":"...","timeout":15000}'`.

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
- **The suite's primary metric could be silently understated by 45x.** A run does
  not always emit ONE SDK result message: if the agent starts a background Bash
  task (which agents do to wait for an async page reply), its completion
  re-invokes the agent and the SDK emits a fresh result for that continuation.
  `usage` and `num_turns` are per-segment while `total_cost_usd` and the durations
  are cumulative. `backends/anthropic.mjs` kept only the LAST result, so a
  26-turn/2392-token `support-chat` run was recorded as **1 turn and 53 output
  tokens** — with a cost of $0.597 sitting next to it, which is the only reason it
  looked wrong rather than merely small. Now: usage summed across segments, cost
  and durations taken from the last, `segments` recorded on the row when >1.
  Caught by the >2x spread flag (45.8x), which is the second time that flag has
  paid for itself. `backends/codex.mjs` has the same last-wins shape at line 160;
  unverified because codex is not the default and was not exercised here.
- Viewport contamination between tasks. `narrow-viewport` leaves the browser at
  phone width, and `runOne` reset only server state — so in the shared-browser
  envs (`cli`, `mcp+http`) every later task ran in a 500x815 window
  (`/floorplan/` overflowing at 601 px, `/grid-edit/` at 648 px, voltro silently
  on its mobile nav). Worse, it was condition-asymmetric: the stdio `mcp` and
  `playwright` conditions spawn a browser per task and were immune, so it would
  have corrupted the comparison in the direction of whichever surface *did* the
  resize. `runOne` now restores 1366x768 for any env that owns an instance.
- Tab contamination, the same bug one genre over. `cross-tab-pay` leaves an
  authorizer tab open, and the shared-browser envs would have carried it into the
  next task. `runOne` now closes every tab above index 0 and re-selects 0 — and
  **stops at index 1**, because closing the last tab bricks the instance (A24).
- The vendored `@playwright/mcp` (0.0.78) takes `target`, not the older
  `element`/`ref` pair, on `browser_click`/`browser_type`. Passing `{element, ref}`
  fails with `expected string, received undefined -> at target`, and a harness
  written against the old API silently no-ops through an entire flow while the
  snapshots still look correct. Cost an implementer a debug cycle; noted here
  because anything new we write against playwright will hit it.

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
- **`file-upload` cannot grade what it was built to probe.** No server-side check
  can distinguish a real file selection from
  `new Blob(['INVENTORY-OK'], {type:'text/plain'})` posted by one `evaluate_script`
  call, and a bare `curl -F` with a hand-set Referer passes too — both verified.
  The validator grades the constraint loop (type/size refusal, then a compliant
  retry), which is real; whether the agent found the upload affordance is a
  **transcript-level** observation only. A pass with zero `upload_file_by_uid` /
  `browser_file_upload` calls is a null result for that probe. The record carries
  a soft provenance hint in `detail` (`provenance=<filename>:<mime>`) — an untyped
  Blob arrives as `application/octet-stream`, a nameless one as filename `blob` —
  but it is a hint, not a gate.

  **The first real run resolved this favourably**: all six agents (3 mcp, 3
  playwright) used the genuine affordance — `upload_file_by_uid` in every mcp
  run, `browser_file_upload` in every playwright run — and none reached for the
  Blob shortcut. So the probe measured what it was built to measure. Keep
  checking: the transcript grep is the check, not the pass rate.
- **T061 (keyboard-only) remains blocked by A8** (no key-press tool). It is now
  the only task idea blocked on a missing tool.
- **`room-booking` has a measured residual leak.** An agent that reads the request
  card and the room list but never the grid, then posts allowed `(day, slot, big
  room)` windows in reading order, needs a median of 26 posts; **4.3% of sessions
  put the answer inside the free 10-request budget and 13.2% are winnable inside
  the 600s cap.** A desk patience budget (10 requests, then a doubling pause to a
  240s cap) cut this from 100% scannable to 13.2%, which is honest but not zero.
  Watch `bookPosts` in the detail string: a pass with a high post count and no
  grid read is a brute-force pass, not a solve.
- **`pr-review` draws one of four defect variants per session, and they are not
  equally hard.** The draw is random and uncontrollable from the CLI, so two
  conditions can draw different variants in the same sweep. Compare variants
  before reading any token delta on this task. Blind guessing is bounded at ~8%.
  A `--seed` flag, or pinning the draw when `--repeat` is used, would remove the
  confound.
- **`locale-notice`'s mcp-vs-playwright delta is biased by two of our own gaps,
  and the row is not interpretable without saying so.** The task turns on
  noticing that the English edition is incomplete. Both of the affordances that
  say so are damaged on our surface and intact on playwright's: (a) our default
  snapshot drops `<em>` entirely, so the masthead editions box reads
  `a "English"` / `a "العربية"` / `a "日本語"` with the per-edition update dates
  (`updated 12 June 2026` vs `2026年7月24日更新`, six weeks apart) invisible unless
  the agent asks for `includeAll`; (b) the English empty state,
  `No supplementary notices in the English edition.`, truncates to
  `No supplementary notices in...` — the words that scope it to one edition are
  exactly the words A1 removes. Both are natural consequences of natural markup
  and were left in place deliberately, but they mean a playwright win here is
  partly a measurement of A1 and the `<em>` drop, not only of agent judgement.
  Read the `en=Nreq/Nnav ar=… ja=…` counters in `detail` before reading the delta.
  Also: A33's truncation makes the Arabic notice materially harder to read than
  the identical Japanese one (32% vs 18% of nodes cut), so which translated
  edition the agent picks changes the difficulty.
