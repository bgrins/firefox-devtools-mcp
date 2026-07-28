# Handoff

Everything a new agent or engineer needs to pick this up. Written 2026-07-28.

Read this file, then `BRIEFING.md` (the rules any fixture author must follow), then
`findings.md` (the actual output of the project). `task-ideas.md` holds the wave
history and the task backlog; it is long, and its status block at the top is the
running log — read that, not the whole file.

---

## 1. What this is, and what it is for

A suite of 74 tasks that run an AI agent against 38 locally served simulated
websites and grade it on **what the site's server actually observed**, not on what
the agent claimed it did.

The purpose is **not** to score models. It is to compare **browser tool surfaces**:
our own `firefox-devtools-mcp` against `@playwright/mcp`, in order to find concrete
improvements to make to ours. `findings.md` is the deliverable; the eval is the
instrument that produces it. If you find yourself optimising the score instead of
mining for findings, you have lost the thread.

Everything is invented content served from loopback. No task touches the live web.

This work lives on the `firefox-cli` branch of a public fork
(`github.com/bgrins/firefox-devtools-mcp`), not on `mozilla/firefox-devtools-mcp`.
It is intended to be extracted onto a clean branch that compares us against
playwright-mcp only, so avoid deepening the coupling to `firefox-cli` (the `cli`
condition is already opt-in and slated to move out).

## 2. Where things are

| Path | What |
|---|---|
| `cli/eval/server.mjs` | The fixture server. Node builtins only — no install needed. Holds every graded secret. |
| `cli/eval/pages/` | 38 fixture sites, 277 HTML files. |
| `cli/eval/run.mjs` | Task definitions: the `ask` an agent gets, and the `validate` function that grades it. |
| `cli/eval/answers.mjs` | The answer key. Excluded from result bundles by design. |
| `cli/eval/verify.mjs` | The cheap gate: solves all 74 tasks deterministically and checks each validator. |
| `cli/eval/verify-drivers/` | One deterministic solver per task, driven through our own MCP. |
| `cli/eval/bundle.mjs` | Packages a finished run into a portable, self-describing zip. |
| `cli/eval/findings.md` | **The product output.** Parts A (snapshot/interaction tools), B (CLI), C (harness), D (devtools surface). |
| `cli/eval/review-2026-07-28.md` | Full suite review: 178 findings, 42 confirmed defects. Largely still open. |
| `cli/eval/devtools-wave-proposal.md` | A designed-but-unbuilt wave for the console/network/debugger surface. |
| `cli/eval/BRIEFING.md` | The contract every fixture author must follow. Mandatory reading before writing a fixture. |
| `cli/eval/task-ideas.md` | Wave history (status block), task backlog, graveyard of killed ideas with reasons. |
| `.claude/workflows/eval-task-wave.js` | The multi-agent workflow that builds a wave. Encodes the process below. |
| `cli/eval/staging/` | Scratch space. **Gitignored** — nothing durable belongs here. |
| `cli/eval/results/` | Run output. **Gitignored.** |

## 3. Running it

```sh
# Look at the sites. No install, no API key, no Firefox needed.
node cli/eval/server.mjs --port 8907
#   /          an index of every fixture
#   /_preview  a contact sheet: every fixture live in an iframe, with a width control
# Both are dev-only and 404 during a real run, because the index spoils answers.

npm install                                   # everything below needs deps

node cli/eval/verify.mjs                      # THE GATE. ~2 min, no API spend.
node cli/eval/verify.mjs --task <ids>         # subset
node cli/eval/run.mjs --suite web --list-tasks
node cli/eval/run.mjs --suite web --parallel --parallel-tasks 4     # full sweep, ~$15-25
node cli/eval/run.mjs --suite web --task <ids> --repeat 3 --retries 3
node cli/eval/bundle.mjs [run-dir]            # portable results zip
```

**Run `verify.mjs` after touching any fixture, validator or server change.** It is
free and it is the only thing standing between a well-meaning edit and a silently
broken task. It also enforces two hard invariants: no fixture may ship an unmuted
`<audio>`/`<video>` (an unmuted one plays through the machine's speakers during
every sweep), and every validator must accept a correct answer *and* reject the
known-bad strings recorded for it.

## 4. The process that works

Waves are built by `.claude/workflows/eval-task-wave.js`. It exists because the
naive approach — one agent writes a task — produced cheatable tasks and brittle
validators every time. The stages, and why each is there:

1. **Implement**, one agent per fixture group, in parallel. Each writes fixture
   pages plus a spec at `staging/<ID>.md` containing paste-ready server, answers
   and task blocks. Implementers do **not** edit the shared files.
2. **Verify-first** where a task depends on a tool behaving. Ask the agent to drive
   the tool before designing around it. This is the highest-yield step in the whole
   process: it found that `set_viewport_size` silently clamps, that
   `evaluate_script` has a hidden 5s cap, and that `drag_by_uid_to_uid` reports
   success while doing nothing. An agent is explicitly allowed to conclude "do not
   ship this task" — that has happened and produced a better finding than the task
   would have.
3. **Adversarial review**, a second agent per group, told to attack cheatability,
   validator correctness, brittleness, realism and plan fidelity. It catches
   blockers in most waves.
4. **Fix pass**, a third agent, when the review finds blockers or majors.
5. **Central integration** by one agent: paste the specs into `server.mjs`,
   `answers.mjs`, `run.mjs`. Extract the fenced blocks **programmatically** rather
   than retyping — several contain `\uXXXX` escapes that get silently mangled.
6. **Golden paths**: `verify.mjs` green twice. Once catches load races, twice
   catches flakiness.
7. **Acceptance**: `--repeat 3 --retries 3`, then record medians with ranges.
8. **Record** in `task-ideas.md`'s status block and fold tool findings into
   `findings.md`. **Commit** (terse, one line, no AI attribution).

## 4b. Fixing defects — a DIFFERENT process from building a wave

Do not reuse the wave workflow to fix validators. It was tried on 2026-07-28 for
the review's 42 confirmed defects, and roughly half the patches came back either
not closing their hole or introducing NEW mis-grades — 12 new false passes and 22
new false fails, caught only by a late adversarial pass. 18 of ~55 landed. These
rules exist so nobody repeats it.

1. **Write the failing assertion first.** Add the mis-graded string to the task's
   driver as `wrong` (must fail) or `alsoCorrect` (must pass), run `verify.mjs`,
   and confirm it goes **RED** naming that string. Only then fix the validator.
   A fix whose test never failed first has not been demonstrated to do anything.
2. **Serialise edits to `run.mjs`, `answers.mjs` and `server.mjs`.** They are a
   single-writer resource. Parallel agents cannot speed this up — they can only add
   a spec-then-integrate indirection, and every defect in the failed attempt was a
   defect of that indirection (wrong line numbers, byte-identical anchors claimed by
   two groups, patches referencing variables absent from the target file). If you
   must fan out, partition by FILE, never by topic.
3. **Batch 3-5 fixes, gate, commit.** Never let a fix pass grow to where nothing
   can land until all of it is judged. A green `verify.mjs` between increments is
   what makes a bad fix cheap to abandon.
4. **The deliverable is a green gate, not a patch.** Any agent touching a validator
   reports `verify.mjs` output. "I wrote a patch and tested it in my own harness"
   is not acceptable — the bespoke harnesses were uniformly weaker than the gate.
5. **One decision per finding.** If you use a schema, do not let a per-item verdict
   coexist with a separate blockers list; they contradicted each other and three
   tasks were misread as safe.
6. **Never loosen a validator to make the suite green.** If a fix causes a failure
   you cannot resolve inside its own scope, revert it and record it as unlanded.
7. **Keep the adversarial pass.** It refuted 24 of 64 claims in the review and
   caught every unsafe patch. The failure was doing it too late and in too large a
   unit, not doing it at all.

A review that produces N findings produces a QUEUE. Rank it, work it in small
verified increments, and expect the tail to be wrong: in the 2026-07-28 review, 24
of 64 severe claims did not survive verification, and the ~100 cosmetic items were
never verified at all.

## 5. Reading results honestly

This list is short but every entry cost real confusion to learn.

- **Output tokens and cost are the comparable efficiency metrics.**
- **Turns are not comparable across conditions.** A shell-driven condition packs
  ~1.21 browser operations into a turn versus 1.00 for a per-tool MCP surface.
- **Absolute cost is not comparable between runs.** Prompt-cache volume swings
  enough to move a ratio from 1.03 to 1.50 at identical turn counts.
- **Always report median with range and the spread flag.** A single sample is
  worthless: one task was observed at 7/33/8 turns across identical repeats. The
  `>2x spread` flag has caught two real bugs that a bare median hid.
- **Pass rate sits near the ceiling by design** — the tasks are built so
  *efficiency* discriminates. A failure is therefore the interesting event; read
  the `detail` string, which names every sub-check.
- **A token comparison on a dense page is meaningless unless you say whether a
  snapshot-only path existed.** We look cheap on dense pages largely because we
  stop looking and start scripting.

## 6. What we have learned about the tool surface

Full detail in `findings.md`; the shape of it:

- **We win where the answer needs scripting anyway** and playwright's verbose
  snapshot is pure overhead: `pr-review` −66%, `room-booking` −38%, `canvas-log`
  −34%, `formula-repair` −19%.
- **We lose on wait-for-state**: `support-chat` +41%, `live-auction` +50%. Two
  unrelated genres, same cause — no wait primitive, so waiting means
  re-snapshotting the whole page (A27). This is the largest repeatable loss and the
  fix is purely additive.
- **We lose where reading a table needs non-default options**: `chart-escape` +66%.
- **On two tasks playwright has a snapshot-only solve path and we have none at
  all** — not more expensive, impossible (A24, A31).
- **The devtools surface is not our advantage.** playwright is at parity or ahead
  on console and network: it returns failing response bodies, prints stack traces,
  and volunteers `Console: N errors` on every response. See Part D.

**The single most important methodological lesson**: the eval's own agent runs will
not find a broken tool if agents can route around it. All six `kanban-triage` runs
on both surfaces used the button, not drag — so `drag_by_uid_to_uid` was completely
broken and the pass rates showed nothing. Only the deliberate capability spike found
it. **Keep commissioning verify-first spikes against tools no task exercises.**

## 7. State as of 2026-07-28, and the worklist

**Suite:** 74 web tasks + 3 smoke, 38 sites, `verify.mjs` 74/74 green. Head is
`a242a37` on `firefox-cli`, pushed. **16 tasks now carry regression assertions** —
the exact strings that were once mis-graded, wired into the gate so a future change
that re-breaks them fails the run and names the string.

**Fixed in the 2026-07-28 defect pass (21 items):** 18 validator/fixture fixes
(`617cb74`), the `/api/beacon` default-deny (`4cfde87`) which was the shared root
cause behind the forgeable `roster-submit` / `form-progress` / `biglist-fetch`
gates, and `pr-review` + `chart-escape` clause scoping (`a242a37`). Notably fixed:
`form-gauntlet` and `roster`, the two worst cheatability defects (both were passable
without doing the work), and `oos-substitute`, a false fail that punished correct
reasoning.

### 7a. Open defects — in value order

Each of these is CONFIRMED and reproduced; see `review-2026-07-28.md` §2 and its
addendum for exact line numbers and proof strings. Roughly half of a first fix
attempt had to be discarded, so **read §4b before starting** and work them in
small test-first increments.

**Tier 1 — a wrong answer passes.** These are the ones that make the suite report
capability it did not measure.
1. `price-compare` — the store conjunct is satisfied by the *product* name, so an
   answer crediting the wrong store passes; `perStore` is loaded and never read; a
   sold-out decoy passes as the winner. A first fix attempt did NOT close it (the
   verdict window absorbed the per-store list) and added 12 false fails — do not
   reuse it.
2. `news-extract` — no row binding, so a table with the points column rotated one
   row scores 20/20. The first attempt's line-windowed rows failed any answer with
   two rows on one line.
3. `variant-matrix` — declaring the most expensive combination the cheapest passes.
4. `crm-join` — naming the wrong winning region passes if the right region and
   figure appear anywhere.
5. `roster-diff` — the added and removed lists can be completely SWAPPED and pass;
   categories are demanded by the ask and never graded; `newTitle` collides with an
   unchanged decoy's existing title.
6. `canvas-pick` — a blind 48-cell sweep passes; the palette is inline in the page.
   The first attempt was defeated by re-minting the session (10/10 blind runs) and
   introduced a permanent unrecoverable void.
7. `shadow-unlock`, `modal-escape` — forgeable gates; `modal-escape` also lacks the
   provenance gate twelve sibling endpoints have.

**Tier 2 — a correct answer fails.** These penalise good agents today.
8. `faceted-search` — normal reviewing prose fails unless the literal word
   "reference" precedes the target. **Blocked on testability**: the false fail needs
   an answer quoting 3+ rejected references and the driver surfaces only 2, so the
   driver must be extended before a fix can be demonstrated.
9. `live-auction` — a correct early decline fails and the byte-identical answer
   passes 152s later. **Blocked on testability**: frequency-gated to the 1-in-9
   `ceiling=1800` draw, so it needs `--seed` or a server mode first.
10. `intake-carryover`, `handbook`, `brochure-minimal`, `ledger-csv`,
    `consent-reject`, `locale-notice`, `qty-limit`, `injection-bait` — each has a
    specific over-strict rule; `locale-notice` is also a live false pass on the one
    answer the fixture was built to catch.

**Tier 3 — ungraded halves and telemetry.** `cross-tab-pay` (decoy computed and
ignored), `kanban-triage` (the "leave Routine alone" half cannot be graded — the
start column is overwritten), `formula-repair` (`?formulas=1` stamps every cell so
`inspected` proves nothing), `room-booking` and `abstract-length`.

**Cross-cutting, still open.** The remaining hand-rolled `PREFIX-HEX` comparisons
(`brochure-minimal`, `promo-zindex`, `canvas-pick`, `draft-resume`, `checkout-stop`,
`abstract-length`) are still case- and dash-exact; use
`/[^\S\n\r]+|[‐-―−-]+/g`, NOT `/[\s…]+/g`, or a per-line list bridges
a newline into the code. `breadcrumb-sibling` / `search-decoy` clause boundaries need
the reviewer's measured remedy (`&& !namesStart(c)`), which recovers 3 of 4 false
fails at no discrimination cost — plain removal of `:` as a boundary was measured to
ADD false fails.

**Honest gaps in what was landed.** `form-gauntlet`'s `opens=` and `unsub`'s
`removal.fromPage` are satisfiable from a shell (`Accept: text/html`, `curl -e`) —
they are route telemetry, not browser proof, and the comments say so. `gridword` and
`canvas-pick` sessions can still be re-minted, so a guess count is spoofable
downward. `ledger-sum`'s `folios >= 4` threshold is undocumented.

### 7b. Then, in order

1. **The cosmetic tail** — `review-2026-07-28.md` §4, roughly 100 items by site.
   Explicitly **unverified**: single-reported, never reproduced, and 24 of 64 severe
   claims in the same review were refuted, so expect a similar error rate. Verify
   each before acting. Worth doing regardless: `X-Eval-Nonce`, `__SESSION_NONCE__`
   and `evalsid` appear in 139 fixture files — a header literally named "Eval" is
   the biggest realism tell in the suite, and it is a mechanical rename.
2. **Then pick one of:**
   - **Fix Part A and measure before/after.** The tool-fix freeze (§8) exists to
     preserve a "before"; there is now a rich one. Order is in `findings.md`. A27
     (wait primitive) is purely additive and worth 41-50% on async pages. A33 (drag
     reports success while doing nothing) is the most severe defect found.
   - **Build the devtools wave**, fully designed in `devtools-wave-proposal.md`
     (T120-T124). Read its fairness section first: it is honest that a task the
     other side cannot attempt proves nothing.
   - **More capability spikes.** Untested surface: keyboard input (no tool at all,
     A10), scroll (no tool), `select_option`, coordinate clicks.

**Do not** default to building more site genres. Waves 10 and 11 did that and the
findings converged hard onto the same short list; wave 12 showed that picking by
*untested capability* yields far more per unit of effort. And note the wave-12
lesson: an agent run will NOT surface a broken tool if agents can route around it,
so the spikes matter more than the fixtures.

## 8. Standing decisions and their reasons

- **TOOL-FIX FREEZE.** Do not fix `src/` findings while using the suite to measure
  them, unless you record a before/after. Fixing one without measurement destroys
  the evidence that justifies it. Fixture authors design *around* the gaps.
- **Server-observed grading over agent claims**, always. A task graded on prose
  alone can be passed by asserting success.
- **Ground truth never derivable from anything under `pages/`.** Mint per session
  from `randomBytes` in `server.mjs`.
- **`cli` is opt-in**, not a default condition. Default backends are
  `firefox-devtools-mcp` and `playwright-mcp`.
- **Nothing may say or imply a site is a test fixture.** A real site would not, and
  the agent should not get the hint.
- **No emoji anywhere**, per `AGENTS.md`. No AI attribution in commits.

## 9. Traps

- `run.mjs` auto-runs `main()` on import. To reuse `webTasks()`, slice it out of the
  source and eval it — `verify.mjs` shows the idiom.
- Spec code blocks containing `\uXXXX` escapes must be extracted programmatically.
  Retyping turns them into raw Unicode characters: invisible and wrong.
- A run can emit **more than one SDK result message** when the agent uses a
  background task. `usage` is per-segment while cost and durations are cumulative.
  This once recorded a 26-turn run as 1 turn and 53 output tokens.
- Any task that resizes the viewport or opens a tab contaminates later tasks in the
  shared-browser envs. `runOne` now restores 1366x768 and closes extra tabs —
  **never close the last tab**, it bricks the instance (A19).
- The shell is zsh: unquoted `$VAR` does not word-split.
- Commits are signed through 1Password and will fail with `failed to fill whole
  buffer` if it is locked. Wait and retry; do not bypass signing.

## 10. Open questions for the owner

- The emoji in `src/tools/network.ts` (lines 241/257/276) violates `AGENTS.md` and
  ships in every `list_network_requests` response. Left alone because it is product
  source and this branch is eval work — wants a standalone change.
- Whether to promote or accept the review's "no observed impact ⇒ minor"
  downgrades. Six findings were demoted on empirical incidence (0 failures in
  87-136 recorded rows). The mechanisms are all real and reproduced.
- Whether `room-booking` (brute-forceable in 13.2% of sessions) and `pr-review`
  (four defect variants of unequal difficulty, drawn at random) are good enough, or
  want a `--seed` flag.
- `findings.md` cites `ledger-sum` as a table-gap discriminator. Route telemetry
  now exists (`route=csv/table/unknown` in `detail`), but no agent run has been
  recorded since, so the claim is still unsupported by data — check `route=` on the
  next sweep before citing it.
- Whether to add `--seed` to `run.mjs`. Two things want it: `live-auction`'s
  defect is only reachable on a 1-in-9 draw, and `pr-review` draws one of four
  defect variants of unequal difficulty, which confounds its token comparison.
- **Pass rates recorded BEFORE 2026-07-28 overstate what was measured** on the
  tasks listed in §7a, because their validators graded a bag of substrings. Wave
  token comparisons are unaffected (efficiency, not correctness), but do not quote
  an old "N/N passed" for those tasks without the caveat.
