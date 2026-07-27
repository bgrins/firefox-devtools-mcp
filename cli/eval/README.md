# Browser-agent eval suite

64 tasks (61 "web" + 3 smoke) that run an AI agent against 25 locally served
simulated websites and grade it on what the site's server actually observed —
not on what the agent claims it did. Everything is invented content served from
loopback; no task ever touches the live web.

The suite exists to compare **browser tool surfaces**: our own
`firefox-devtools-mcp` against `@playwright/mcp`, so we can find concrete
improvements to make to ours. `cli/eval/findings.md` is the running output of
that, split by who owns each fix.

---

## Getting the branch

This work lives on the `firefox-cli` branch of a public fork, not on
`mozilla/firefox-devtools-mcp`.

**If you already have the Mozilla repo cloned**, add the fork as a second remote
and track its branch:

```sh
git remote add bgrins https://github.com/bgrins/firefox-devtools-mcp
git fetch bgrins firefox-cli
git checkout -b firefox-cli --track bgrins/firefox-cli
```

Your existing remote (usually `origin` = mozilla) is untouched, so
`git checkout main` returns you to normal. Later updates are
`git pull bgrins firefox-cli` from the branch.

**If you do not have it yet**, clone the fork directly — no access needed, it is
public:

```sh
git clone https://github.com/bgrins/firefox-devtools-mcp
cd firefox-devtools-mcp
git checkout firefox-cli
```

## Just looking at the websites (no install needed)

The fixture server uses only Node builtins, so you need nothing but Node
(no `npm install`, no API key, no Firefox):

```sh
node cli/eval/server.mjs --port 8907
```

Then open:

- **<http://127.0.0.1:8907/>** — an index of every fixture site with a one-line
  description of each.
- **<http://127.0.0.1:8907/_preview>** — a contact sheet: every fixture live in
  an iframe on one page. Adjust the **Width** box to change the simulated
  viewport and the **Zoom** slider to fit more or fewer on screen; **Reload all**
  re-runs them.

Both of those pages are development-only and are served **only** when you start
the server yourself this way. During an actual eval run they return 404, because
the index describes each task's trick and would spoil the answers.

A few things to know while you browse:

- Interactions are real. The contact sheet loads every fixture at once, which
  fires their beacons and starts their sessions — that is fine, it is a scratch
  server on your machine.
- Every site has a deliberately different design language (a legacy government
  site, a discount grocer, a print-academic institute, a dark ops console, a
  1930s freight registry, and so on) so an agent has to re-orient on each one.
- The two `bank/` pages are intentionally near-identical: one is a phishing
  lookalike with four seeded tells. Spotting which is which is a task.
- Some things look broken on purpose: three product photos in the gallery really
  do 404, one promo banner is covered by another, and a file rename really does
  get rejected and roll back after ~2 seconds.
- Nothing anywhere says "this is a test fixture". That is deliberate — a real
  site would not, and the agent should not get that hint.

## Seeing what the agent is asked to do

Task prompts live in `cli/eval/run.mjs`. To list them (this one needs deps):

```sh
npm install
node cli/eval/run.mjs --suite web --list-tasks
```

Each line shows the task id plus its wall-clock budget tier. To read the exact
prompt text for every task without digging through source, package any past run
(see below) and open its `tasks.json`.

## Running things (needs deps, an API key, and real money)

```sh
npm install
node cli/eval/run.mjs --help
```

- `node cli/eval/verify.mjs` — the cheap gate. Solves all 61 tasks
  deterministically through our own MCP server and checks that each validator
  accepts a correct answer and rejects a wrong one. ~2 minutes, no API spend.
  Run this after touching any fixture.
- `node cli/eval/run.mjs --suite web --parallel --parallel-tasks 4` — a real
  agent sweep, our MCP vs playwright-mcp. Roughly $15-25 and 20-40 minutes.
- `node cli/eval/run.mjs --suite web --task <ids> --repeat 3 ...` — a subset with
  repeats; the report then shows medians with ranges and flags any task whose
  output tokens vary by more than 2x between identical runs.
- `node cli/eval/bundle.mjs [run-dir]` — package a finished run into a portable
  zip: what ran, the numbers, every task prompt, and every agent's full
  transcript, with local paths scrubbed. Self-describing, so it stands alone.

Results land in `cli/eval/results/` (gitignored).

## Reading results honestly

- **Output tokens** and **cost** are the comparable efficiency metrics.
- **Turns are not comparable across conditions** — a shell-driven condition packs
  ~1.21 browser operations into one turn versus 1.00 for a per-tool MCP surface.
- **Absolute cost is not comparable between runs**; prompt-cache volume swings
  enough to move a ratio substantially at identical turn counts.
- **Pass rate sits near the ceiling by design.** The tasks are built so that
  *efficiency* discriminates, not success. So a failure is the interesting event —
  read the `detail` string on that row, which names every sub-check the validator
  ran.
