export const meta = {
  name: 'eval-task-wave',
  description: 'Implement a wave of eval tasks in parallel: fixture + staging spec per task, adversarial review, fix pass',
  whenToUse:
    'Building new cli/eval suite tasks from task-ideas.md plans. Pass args = array of {id, planIds: [..], dir, taskIds: [..], specFiles: [..], extra?} — one entry per fixture group (tasks sharing a fixture go in one entry). The orchestrator integrates the resulting staging/ specs into server.mjs/answers.mjs/run.mjs afterwards.',
  phases: [
    { title: 'Implement', detail: 'one agent per fixture group: fixtures + spec + golden-path drivers' },
    { title: 'Review', detail: 'adversarial review per group as it completes' },
    { title: 'Fix', detail: 'apply review findings when blockers/majors found' },
  ],
}

// RESUMING AFTER A FAILURE (orchestrator notes)
// Workflow({scriptPath, resumeFromRunId: '<runId>'}) replays only agent() calls
// that COMPLETED; an agent killed mid-flight is re-run from scratch. Because
// agents write straight into the working tree, a killed run leaves partial,
// unverified fixture files behind — and the cache cannot tell you which.
// Before resuming:
//   1. Read <transcriptDir>/journal.jsonl. Only lines with type 'result' are
//      cached; a journal holding just 'started' means nothing is recoverable.
//   2. Read each in-flight group's staging/<ID>-PROGRESS.md (agents are told to
//      keep one) to see which milestones were actually verified.
//   3. `git status` the group's fixture dir. Revert unverified edits to files
//      that back ALREADY-SHIPPED tasks (restore from the index, not HEAD, if
//      there is uncommitted work you mean to keep), and delete half-written new
//      fixtures rather than letting a fresh agent inherit them.
// Committing (or at least staging) between waves is what makes step 3 safe.
//
// AFTER INTEGRATING A WAVE (maintainer steps, in order)
//   1. `node eval/verify.mjs --task <the wave's ids>` — the golden-path drivers
//      the implementers wrote can only run against a MERGED run.mjs, so this is
//      the first time they execute for real. Iterate until green, twice in a row
//      (once catches load races; twice catches flakiness).
//   2. Fold each group's reported `toolFindings` into cli/eval/findings.md, which
//      is the product deliverable of this whole exercise — findings about OUR MCP
//      server, kept out of the fixture docs so they can be acted on separately.
//      Do NOT fix them here: the suite measures those gaps, and fixing one
//      without a recorded before/after destroys the evidence for it.
//   3. `node eval/run.mjs --suite web --task <ids> --repeat 3` for the real
//      agent numbers, then record the wave in task-ideas.md's status block.
// No absolute paths anywhere: every path in the prompts below is repo-relative,
// and the agent resolves the checkout root itself with `git rev-parse`.

// args may arrive as a real array or as a JSON-encoded string depending on how
// the caller passes it; accept either.
let parsed = args
if (typeof parsed === 'string') {
  try {
    parsed = JSON.parse(parsed)
  } catch {
    parsed = null
  }
}
const TASKS = Array.isArray(parsed) ? parsed : null
if (!TASKS || !TASKS.length) {
  throw new Error(
    'eval-task-wave requires args: [{id, planIds, dir, taskIds, specFiles, extra?}, ...]'
  )
}
for (const t of TASKS) {
  for (const key of ['id', 'planIds', 'dir', 'taskIds', 'specFiles']) {
    if (!t[key]) throw new Error(`task entry missing ${key}: ${JSON.stringify(t)}`)
  }
}

const SHARED_CONTEXT = `
Repo: the firefox-devtools-mcp checkout you are in (branch firefox-cli); resolve its
root with \`git rev-parse --show-toplevel\`. Every path below is REPO-RELATIVE.

You are implementing task(s) for a browser-agent eval suite. The suite runs agents against
simulated local web pages served by eval/server.mjs and validates success via server-observed
state (session-scoped beacons and per-session fields), never trusting page-readable secrets.
The suite measures the value of different TOOL SURFACES, not agent capability.

READ FIRST (mandatory):
0. cli/eval/BRIEFING.md — the standing rules: per-site design language (5b),
   no fake-site disclaimers, the anti-cheat lessons section, validator brittleness rules, and
   the required spec sections. It supersedes anything vaguer below.
1. Your plan section(s): sed -n '/^### <PLANID> /,/^### /p' cli/eval/task-ideas.md
   for each plan id you were given. Plans specify Fixture / Server / Ask / Validator.
   Also read the status block at the top of task-ideas.md for known tool gaps — they are
   deliberate probes; design tasks AWARE of them, do not fix them.
2. cli/eval/server.mjs — session/nonce infra (P-1) and existing endpoint handlers
   whose style your endpoint code must match. Contract: every .html response gets an
   evalsid cookie + per-session nonce; the literal __SESSION_NONCE__ in HTML is substituted
   server-side; page JS authenticates POSTs with the nonce; requireSession(req, res, nonce)
   gates endpoints (X-Eval-Nonce header works for GETs); found.session is a per-session
   object for your fields; state.beacons + state.beaconsOf(kind) for beacons.
3. Existing fixtures for house style: pages/forms/register.html (modern form + fetch),
   pages/flaky/index.html, pages/gov/*.html (legacy HTML 4.01 style).
4. cli/eval/answers.mjs and the register-errors, checkout-stop, and
   rename-rollback entries in cli/eval/run.mjs — the session-graded validator
   pattern (grade the session that completed the flow so stray curl sessions cannot
   shadow the real run) and markdown-emphasis stripping before prose regexes.

CRASH-SAFETY — KEEP A PROGRESS LEDGER (do this first, and keep it current):
Your run can be killed at any moment (session end, API error). Because you write straight into
the working tree, a half-finished run is indistinguishable from a finished one unless you leave
a record. So:
- FIRST, before editing anything, check whether cli/eval/staging/<ID>-PROGRESS.md
  already exists. If it does, a previous attempt was interrupted: read it, trust only the
  milestones it marks VERIFIED, re-check anything marked IN PROGRESS, and continue from there
  instead of starting over.
- Create/maintain that file with one line per milestone, each marked TODO / IN PROGRESS /
  VERIFIED, and update it as you go (not at the end): fixture files written · curl self-test
  passed · headless-browser self-test passed · spec written · spec code blocks re-extracted and
  re-verified · preview.html tile added.
- Also keep in it a list titled "SHIPPED FILES TOUCHED": every file you modify that already
  existed and backs an already-passing task. A recovery pass uses that list to know what to
  re-verify or revert.
- Do the risky edits LAST: finish and verify your NEW files before modifying any pre-existing
  fixture, so an interrupted run leaves shipped tasks untouched wherever possible.
- Never leave a pre-existing fixture in a knowingly broken intermediate state across a long
  verification step; make such edits in one pass and verify immediately.

HARD RULES:
- Write ONLY: (a) your fixture files at your assigned location under pages/, (b) integration
  spec(s) at cli/eval/staging/<SPECFILE>, (c) scratch test files and your
  <ID>-PROGRESS.md ledger under staging/,
  (d) one tile for your fixture in cli/eval/preview.html (the contact-sheet PAGES
  list is hardcoded and goes stale otherwise) — add only your own entry, do not reorder.
- Grade on per-session state your OWN endpoint maintains, never on beaconsOf(kind): the
  generic /api/beacon accepts an arbitrary kind, so such a gate is forgeable with just the
  page nonce. Per-session state is also what state.reset() clears between tasks.
- Server-issued codes come from randomBytes, not from a formula over the page-exposed nonce.
- Any datum a validator reads out of the snapshot must sit within the first 30 characters of
  its text node (snapshot truncates there) and must not be inside a <table>, <b>, <label>,
  <summary>, <aside>, an <option>, or a container holding 500+ chars of direct text — the
  walker drops or truncates all of those. Design around it or make eval the intended path,
  but say which in your spec.
- Debug/dump routes belong ONLY in your staging/ scratch server. They must never appear in
  the "Server endpoint code" block that gets pasted into the real server.mjs.
- Before you finish, extract each code block back OUT of your written spec markdown and
  confirm it is byte-identical to the version you actually tested, then re-run your harness
  against the extracted copy. A spec that drifts from what was verified is the failure mode
  this step exists to catch.
- NEVER edit server.mjs, run.mjs, answers.mjs, task-ideas.md, or fixtures owned by other
  tasks. Task-specific exceptions, if any, are listed in your task section below.
- Do not break existing tasks: news items.json rows are validated by news-extract; shop
  prices/stock text by price-compare; gridword/gov/portal fixtures have their own tasks.
- Ground truth never derivable from fixture source on disk: codes/messages server-issued
  per session, or the validated fact is server-observed. Grep pages/ to confirm.
- Every HTML page: <!doctype html> + <meta charset="utf-8"> (gov/ uses the legacy HTML 4.01
  doctype + http-equiv charset). No emoji. Invented brands only. Minimal-to-zero comments.
- Redirects: the static server has no auth-aware routing — implement "requires login" as
  page JS that fetches a gated endpoint and renders either content or a login-required
  state, NOT as server-side 302s. Gate the DATA, not the page shell.
- Native window.confirm()/alert() are auto-dismissed instantly by the BiDi session — use
  in-page modal dialogs for any dialog behavior, with beacon instrumentation.

GOLDEN-PATH DRIVERS (a required deliverable, not optional):
\`cli/eval/verify.mjs\` proves every task is still SOLVABLE and that its validator
accepts a correct solution and rejects a wrong one — deterministically, through OUR
OWN MCP server, in minutes for no API spend. It is how a fixture or validator
regression gets caught without an agent sweep, so every task you add needs one.
- Read \`cli/eval/verify.mjs\` and \`cli/eval/verify-drivers/probes.mjs\` first: probes.mjs
  documents the driver contract and has worked examples.
- Write your drivers to \`cli/eval/verify-drivers/<YOUR GROUP ID>.mjs\` (your own file,
  never a sibling's) and add the import + merge entry to \`verify-drivers/index.mjs\`.
- Drive the flow the way an agent must, through the MCP tool surface — \`take_snapshot\`
  then \`click_by_uid\`/\`fill_by_uid\` — and use \`evaluate_script\` only for reading bulk
  text or where no tool exists. Every time you are FORCED to use \`evaluate\` because the
  tool surface cannot do something, that is a tool finding: record it.
- Return the answer text a correct agent would produce, and set a \`wrong:\` string the
  validator MUST reject (plausible-but-incorrect, not gibberish).
- Poll for conditions; never sleep a fixed time. Do not read the answer out of
  \`ctx.pages.state\` unless the task is genuinely unsolvable otherwise, and say so in
  the driver's \`note\` when you do.
- Mark \`canned: true\` where success is prose or judgment that cannot be scripted; then
  ALSO assert the fixture's own preconditions still hold (that the bait/prompt/tell is
  still present), or the check is vacuous.
- You cannot run \`verify.mjs\` end to end yet — your validator is not in run.mjs until
  the maintainer integrates. Prove driver and validator agree now by pasting your
  spec's validator into a scratch harness and running it against your driver's output
  (the same shape as your other scratch tests). The maintainer runs the real thing
  after integration.

INTEGRATION SPEC (staging/<SPECFILE>) must contain exactly these sections:
## Server endpoint code — fenced JS block(s) ready to paste into server.mjs's handler chain,
   matching existing handler style exactly (requireSession, readBody, json(), 64KB cap).
## answers.mjs entry — fenced JS block.
## run.mjs task entry — fenced JS block: { id: '<taskId>', ask: \`...\${base}...\`,
   (no maxTurns field — the harness has no turn limit; runaway protection is
   --max-wall / --max-output)
   validate: (text, ctx) => ({ pass, detail }) }. Validators may use
   ctx.pages.state.beaconsOf(kind) and ctx.pages.state.sessions.
## Expected solution — the exact answer a correct agent reports.
## Success criteria — bullet list of every condition the validator enforces, for human QA.
## Self-test notes — what you verified and how, and what needs real-browser QA.

SELF-TEST: copy server.mjs to staging/scratch-<ID>-server.mjs (repoint its pages root:
replace the root join with join(..., '..', 'pages')), add your endpoints, run on a free 89xx
port, exercise the flow with curl (cookie jar + nonce scraped from served HTML), verify
happy path + 403 on forged/no-session + ground truth absent from static source. ALSO verify
in a real headless browser where flows involve JS, using the firefox-cli tool:
  cd cli && export FIREFOX_CLI_STATE_DIR=$(mktemp -d) && node bin/firefox-cli.mjs launch --headless
  node bin/firefox-cli.mjs open <url>; node bin/firefox-cli.mjs eval '<js fn>'; ...; node bin/firefox-cli.mjs stop
Note: page JS fetches to gated GET endpoints need the X-Eval-Nonce header (the served page
defines a NONCE constant). Kill scratch servers and stop your browser instance when done.

Validators must not be brittle: never require contiguous phrases a correct agent might
format differently; decouple multi-part answer checks; strip markdown emphasis characters
([*_~\`]) before prose regexes (we have been burned by "did **not** persist").

Your final message is parsed as structured output — return the requested fields precisely.`

const IMPL_SCHEMA = {
  type: 'object',
  required: [
    'id', 'taskIds', 'filesWritten', 'designLanguage', 'expectedSolution',
    'successCriteria', 'specBlocksVerified', 'goldenPathFile', 'toolFindings',
    'qaSteps', 'notes',
  ],
  properties: {
    id: { type: 'string' },
    taskIds: { type: 'array', items: { type: 'string' } },
    filesWritten: { type: 'array', items: { type: 'string' } },
    // One line naming this site's own visual identity, so the wave can be
    // checked for convergence without opening every fixture.
    designLanguage: { type: 'string' },
    expectedSolution: { type: 'string' },
    successCriteria: { type: 'string' },
    // Confirmation that the spec's paste blocks were extracted back out and
    // re-tested, i.e. the spec matches what was actually verified.
    specBlocksVerified: { type: 'boolean' },
    // Path to the golden-path driver module written for this group's tasks.
    goldenPathFile: { type: 'string' },
    // Every place the MCP tool surface could not do something, so the maintainer
    // can fold them into cli/eval/findings.md. Empty array is a valid answer.
    toolFindings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['symptom', 'impact'],
        properties: {
          tool: { type: 'string' },
          symptom: { type: 'string' },
          impact: { type: 'string' },
          workaround: { type: 'string' },
        },
      },
    },
    qaSteps: { type: 'string' },
    notes: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['id', 'verdict', 'issues'],
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['ok', 'issues'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'category', 'description', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          // brittleness/recoverability are escalated to the fix stage even at
          // minor severity: a validator that fails a CORRECT agent, or a
          // fixture an agent cannot recover from, silently corrupts the
          // measurement instead of just being untidy.
          category: {
            type: 'string',
            enum: [
              'cheatability',
              'correctness',
              'brittleness',
              'recoverability',
              'realism',
              'plan-fidelity',
            ],
          },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['id', 'fixedIssues', 'notes'],
  properties: {
    id: { type: 'string' },
    fixedIssues: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

function implementPrompt(t) {
  return `${SHARED_CONTEXT}

YOUR ASSIGNMENT: ${t.id}. Plan section(s): ${t.planIds.join(', ')}. Suite task id(s):
${t.taskIds.join(', ')}. Fixture location: ${t.dir}. Spec file(s): ${t.specFiles.join(', ')}.
${t.extra ?? ''}`
}

function reviewPrompt(t, impl) {
  return `You are an adversarial reviewer for browser-agent eval task implementation(s) on branch firefox-cli: ${t.id} (suite ids ${t.taskIds.join(', ')}).
Read the plan(s): sed -n '/^### ${t.planIds[0]} /,/^### /p' cli/eval/task-ideas.md${
    t.planIds[1] ? ` (and the same for ${t.planIds.slice(1).join(', ')})` : ''
  }.
Read the implementation: fixture files ${JSON.stringify(impl.filesWritten)} and spec(s)
${t.specFiles.map((f) => 'cli/eval/staging/' + f).join(', ')}. Read cli/eval/server.mjs and
the register-errors + rename-rollback entries in cli/eval/run.mjs for the session-graded
validator pattern.

Attack, and tag every finding with the matching category:
(1) CHEATABILITY — curl/disk paths to a pass, leaked ground truth, forgeable beacons beyond
the accepted live-session-cookie baseline (note: the generic /api/beacon takes an arbitrary
kind, so any beaconsOf(kind) gate is forgeable), lucky-guess passes.
(2) CORRECTNESS — endpoint code pastes cleanly into server.mjs and works; validators
reference real state; state.reset() clears everything graded; multi-session shadowing (a
stray curl session must not break OR fake grading).
(3) BRITTLENESS — a CORRECT agent failing on formatting or on a legitimate-but-unanticipated
solve order. Invent at least 15 correct phrasings the implementer did not test (markdown
tables, bold, bullets, per-line "Name: status", rounded or space-grouped numbers,
self-correcting narration) and at least 8 wrong ones. Any correct phrasing that fails is a
finding regardless of how tidy the code looks.
(4) RECOVERABILITY — a state the agent can enter and not get out of (a modal that becomes
undismissable, a form that hard-blocks, an unrecoverable error path), and races where a
beacon can lose to a faster interaction.
(5) REALISM & STYLE — house rules, and whether the site has its OWN design language rather
than a copy of the reference fixture's.
(6) PLAN FIDELITY — deviations that weaken the probe, and regressions to existing fixtures
(git diff anything shared).
(7) GOLDEN PATH — read the driver module. Does it actually drive the flow through the MCP
tool surface, or does it shortcut with \`evaluate\` where a tool exists (weakening the proof
that our surface can win the task)? Does it read the answer out of ctx.pages.state without
saying so? Is a \`canned: true\` driver still asserting the fixture's preconditions, or is it
vacuous? Does \`wrong:\` name a plausible-but-incorrect answer rather than gibberish (a
gibberish \`wrong\` proves nothing about the validator)? Missing or vacuous golden paths are
\`correctness\` findings.

Report ONLY real actionable issues. Verdict 'ok' only if nothing blocker/major AND nothing
in the brittleness or recoverability categories — those are escalated to a fix pass even at
minor severity, because they corrupt the measurement rather than merely being untidy.`
}

function fixPrompt(t, impl, rev) {
  return `Fix review findings for eval task(s) ${t.id}. Files:
${JSON.stringify(impl.filesWritten)}; spec(s):
${t.specFiles.map((f) => 'cli/eval/staging/' + f).join(', ')}.
Findings (fix blockers and majors; judgment on minors):
${JSON.stringify(rev.issues, null, 2)}

You may edit the listed fixture files and specs only (same exceptions as the implementer).
Keep plan intent. Re-run self-tests affected by your changes and update the spec sections
to match.`
}

phase('Implement')
const results = await pipeline(
  TASKS,
  (t) => agent(implementPrompt(t), { label: `impl:${t.id}`, phase: 'Implement', schema: IMPL_SCHEMA }),
  (impl, t) =>
    agent(reviewPrompt(t, impl), { label: `review:${t.id}`, phase: 'Review', schema: REVIEW_SCHEMA }).then(
      (rev) => ({ impl, rev })
    ),
  async ({ impl, rev }, t) => {
    // Minors are usually cosmetic, but a brittleness or recoverability finding
    // is a measurement bug at any severity — escalate those too.
    const ESCALATE = new Set(['brittleness', 'recoverability'])
    const actionable = (rev.issues ?? []).filter(
      (i) => i.severity !== 'minor' || ESCALATE.has(i.category)
    )
    if (rev.verdict === 'ok' || !actionable.length) {
      return { task: t, impl, rev, fix: null }
    }
    const fix = await agent(fixPrompt(t, impl, rev), { label: `fix:${t.id}`, phase: 'Fix', schema: FIX_SCHEMA })
    return { task: t, impl, rev, fix }
  }
)

const done = results.filter(Boolean)
log(`${done.length}/${TASKS.length} groups done; ${done.filter((r) => r.fix).length} needed fixes`)
return done.map((r) => ({
  id: r.task.id,
  taskIds: r.task.taskIds,
  files: r.impl.filesWritten,
  expectedSolution: r.impl.expectedSolution,
  successCriteria: r.impl.successCriteria,
  qaSteps: r.impl.qaSteps,
  notes: r.impl.notes,
  reviewVerdict: r.rev.verdict,
  reviewIssues: r.rev.issues,
  fix: r.fix,
}))
