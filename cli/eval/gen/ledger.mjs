// Generates the Kestrel Hollow Land Trust ledger fixture:
//   pages/ledger/index.html + page-2.html .. page-7.html  (paginated postings;
//   the last page carries one extra entry, so pages x rows-per-page is the
//   WRONG total)
//   data/ledger.json  (row source of truth; the CSV export endpoint in
//   server.mjs reads this file)
// This generator and the row source both live OUTSIDE pages/ so neither is
// reachable over HTTP from the served static root.
// Run: node cli/eval/gen/ledger.mjs
// The generated answers (hardware total, max amount, row count) are printed at
// the end for copying into cli/eval/answers.mjs.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const here = dirname(self);
const PAGES_DIR = join(here, '..', 'pages', 'ledger');
const DATA_FILE = join(here, '..', 'data', 'ledger.json');

const PAGE_COUNT = 7;
const PER_PAGE = 20;
const TOTAL_ROWS = PAGE_COUNT * PER_PAGE + 1;
// Index of the one capital purchase, deliberately deep in the ledger.
const BIG_ROW = 96;
const ORG = 'Kestrel Hollow Land Trust';

const DESCRIPTIONS = {
  hardware: [
    'Trail camera replacement',
    'Soil probe kit',
    'Field laptop dock',
    'Weather station mast',
    'Water pump rebuild kit',
    'Gate hardware and locks',
    'Handheld GPS unit',
    'Battery bank for cabin',
    'Chainsaw and safety gear',
    'Solar panel bracket set',
    'Culvert pipe section',
    'Deer fencing rolls',
    'Two-way radio pair',
    'Bench grinder for shop',
  ],
  travel: [
    'Mileage - north parcel',
    'Mileage - county hearing',
    'Lodging - regional summit',
    'Rail fare - state capital',
    'Fuel - survey truck',
    'Parking - permit office',
    'Per diem - field crew',
    'Airfare - land trust forum',
    'Ferry fare - island survey',
  ],
  software: [
    'GIS subscription renewal',
    'Accounting seat license',
    'Mapping plugin license',
    'Cloud backup tier',
    'Donor database renewal',
    'E-signature credits',
    'Survey app annual plan',
    'Website hosting renewal',
  ],
  misc: [
    'Printing - annual report',
    'Postage - donor mailing',
    'Permit filing fee',
    'Volunteer refreshments',
    'Native seed mix',
    'Legal notice publication',
    'Storage unit rent',
    'First aid restock',
    'Sign printing - trailhead',
  ],
};

const RANGES = {
  hardware: [55, 1450],
  travel: [22, 780],
  software: [95, 1150],
  misc: [12, 420],
};

const TAG_WEIGHTS = [
  ['hardware', 0.27],
  ['travel', 0.24],
  ['software', 0.22],
  ['misc', 0.27],
];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (n) => Math.round(n * 100);
const money = (n) =>
  n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',');

function pickTag(r) {
  let acc = 0;
  for (const [tag, weight] of TAG_WEIGHTS) {
    acc += weight;
    if (r < acc) return tag;
  }
  return 'misc';
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function build(seed) {
  const rand = rng(seed);
  const rows = [];
  // Postings land on weekdays only; the cursor walks forward 1-2 business days
  // per entry so the ledger covers roughly January through July 2026.
  const cursor = new Date(Date.UTC(2026, 0, 5));
  for (let i = 0; i < TOTAL_ROWS; i++) {
    if (i > 0) {
      const draw = rand();
      let steps = draw < 0.25 ? 0 : draw < 0.8 ? 1 : 2;
      while (steps-- > 0) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }
    }
    const tag = i === BIG_ROW ? 'hardware' : pickTag(rand());
    const pool = DESCRIPTIONS[tag];
    const description =
      i === BIG_ROW ? 'Utility trailer purchase' : pool[Math.floor(rand() * pool.length)];
    const [min, max] = RANGES[tag];
    const amount =
      i === BIG_ROW
        ? Math.round((3200 + rand() * 600) * 100) / 100
        : Math.round((min + rand() * (max - min)) * 100) / 100;
    rows.push({ date: isoDate(cursor), description, tag, amount });
  }
  return rows;
}

function pageSlice(rows, page) {
  const start = (page - 1) * PER_PAGE;
  return page === PAGE_COUNT ? rows.slice(start) : rows.slice(start, start + PER_PAGE);
}

function analyze(rows) {
  const tagTotals = { hardware: 0, travel: 0, software: 0, misc: 0 };
  const tagCounts = { hardware: 0, travel: 0, software: 0, misc: 0 };
  for (const row of rows) {
    tagTotals[row.tag] = Math.round((tagTotals[row.tag] + row.amount) * 100) / 100;
    tagCounts[row.tag]++;
  }
  const pageTotals = [];
  const pageHardware = [];
  for (let page = 1; page <= PAGE_COUNT; page++) {
    const slice = pageSlice(rows, page);
    pageTotals.push(
      Math.round(slice.reduce((sum, row) => sum + row.amount, 0) * 100) / 100
    );
    pageHardware.push(slice.filter((row) => row.tag === 'hardware').length);
  }
  const grand = Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
  const sorted = [...rows].map((row) => row.amount).sort((a, b) => b - a);
  return {
    tagTotals,
    tagCounts,
    pageTotals,
    pageHardware,
    grand,
    max: sorted[0],
    runnerUp: sorted[1],
    maxRows: rows.filter((row) => row.amount === sorted[0]).length,
  };
}

function problems(rows) {
  const a = analyze(rows);
  const out = [];
  const h = cents(a.tagTotals.hardware);
  if (h % 10 === 0) out.push(`hardware total ${a.tagTotals.hardware} is a round figure`);
  for (const [tag, total] of Object.entries(a.tagTotals)) {
    if (tag === 'hardware') continue;
    if (Math.abs(h - cents(total)) < 100) out.push(`${tag} total collides with hardware`);
  }
  a.pageTotals.forEach((total, idx) => {
    if (Math.abs(h - cents(total)) < 100) out.push(`page ${idx + 1} total collides`);
  });
  if (Math.abs(h - cents(a.grand)) < 100) out.push('grand total collides with hardware');
  for (const row of rows) {
    if (Math.abs(h - cents(row.amount)) < 100) out.push('a single amount collides with hardware');
    if (/[",]/.test(row.description)) out.push(`description not CSV-safe: ${row.description}`);
  }
  if (a.maxRows !== 1) out.push(`largest amount ${a.max} is not unique`);
  if (cents(a.max) % 10 === 0) out.push(`largest amount ${a.max} is a round figure`);
  if (a.max - a.runnerUp < 10) out.push('largest amount is within $10 of the runner-up');
  if (rows[BIG_ROW].amount !== a.max) out.push('largest amount is not the designated capital row');
  for (const [tag, count] of Object.entries(a.tagCounts)) {
    if (count < 25) out.push(`only ${count} ${tag} rows`);
  }
  a.pageHardware.forEach((count, idx) => {
    if (count < 3) out.push(`page ${idx + 1} has only ${count} hardware rows`);
  });
  const last = rows.at(-1).date;
  if (last < '2026-07-01' || last > '2026-07-31') out.push(`last date ${last} out of range`);
  return out;
}

const head = (title, subtitle) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: "Helvetica Neue", Arial, sans-serif; background: #f6f5f1; color: #23291f; margin: 0; }
  header { background: #2f4230; color: #f0ece1; padding: 16px 34px; }
  header .brand { font-size: 19px; letter-spacing: 0.02em; }
  header .tag { font-size: 12px; color: #bcc9b5; margin-top: 3px; }
  main { max-width: 830px; margin: 26px auto 40px; padding: 0 20px; }
  h1 { font-size: 21px; font-weight: normal; margin: 0 0 4px; }
  .meta { font-size: 13px; color: #5a6353; margin: 0 0 18px; }
  .toolbar { display: flex; align-items: center; gap: 12px; background: #fff; border: 1px solid #d8d6cb; padding: 10px 14px; margin-bottom: 14px; }
  button { font: inherit; font-size: 13px; padding: 6px 12px; background: #3d5c3e; color: #fff; border: 0; border-radius: 3px; cursor: pointer; }
  button:hover { background: #4a6f4b; }
  .toolbar .hint { font-size: 12px; color: #6b7364; }
  #export-status { font-size: 12px; color: #3d5c3e; margin-left: auto; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d8d6cb; font-size: 13px; }
  caption { text-align: left; font-size: 12px; color: #6b7364; padding: 8px 0; }
  th, td { padding: 6px 10px; border-bottom: 1px solid #ebe9e0; text-align: left; }
  thead th { background: #e8e6da; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  td.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; }
  td.date { white-space: nowrap; color: #4c5446; }
  td.tag { color: #4c5446; }
  tfoot td { font-weight: 700; border-top: 2px solid #d8d6cb; border-bottom: 0; }
  .pager { margin: 16px 0 6px; font-size: 13px; }
  .pager a { color: #2f4230; }
  .pager .current { font-weight: 700; padding: 0 4px; }
  .pager .nums a { padding: 0 4px; }
  .pager .off { color: #a5a89c; }
  .pageline { font-size: 12px; color: #6b7364; }
  footer { border-top: 1px solid #ddd9cc; margin-top: 26px; padding-top: 12px; font-size: 12px; color: #7d8375; }
</style>
</head>
<body>
<header>
  <div class="brand">${ORG}</div>
  <div class="tag">${subtitle}</div>
</header>
`;

function renderPage(rows, page) {
  const slice = pageSlice(rows, page);
  const subtotal = Math.round(slice.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
  const file = (n) => (n === 1 ? 'index.html' : `page-${n}.html`);
  const nums = [];
  for (let n = 1; n <= PAGE_COUNT; n++) {
    nums.push(
      n === page
        ? `<span class="current" aria-current="page">${n}</span>`
        : `<a href="${file(n)}">${n}</a>`
    );
  }
  const prev =
    page === 1
      ? '<span class="off">Previous</span>'
      : `<a href="${file(page - 1)}">Previous</a>`;
  const next =
    page === PAGE_COUNT
      ? '<span class="off">Next</span>'
      : `<a href="${file(page + 1)}">Next</a>`;
  const pager = `  <nav class="pager" aria-label="Ledger pages">
    ${prev}
    <span class="nums">${nums.join('\n    ')}</span>
    ${next}
  </nav>
  <p class="pageline">Page ${page} of ${PAGE_COUNT}</p>
`;
  const body = slice
    .map(
      (row) => `      <tr>
        <td class="date">${row.date}</td>
        <td>${row.description}</td>
        <td class="tag">${row.tag}</td>
        <td class="amount">$${money(row.amount)}</td>
      </tr>`
    )
    .join('\n');

  return `${head(
    `Transaction Ledger - Page ${page} - ${ORG}`,
    'Operating fund &middot; fiscal year 2026'
  )}<main>
  <h1>Transaction Ledger</h1>
  <p class="meta">Operating fund postings for fiscal year 2026, oldest first.
  Every posting carries one tag: hardware, travel, software, or misc.</p>
  <div class="toolbar">
    <button id="export" type="button">Export CSV</button>
    <span class="hint">Exports every posting in the ledger, not just this page.</span>
    <span id="export-status" role="status"></span>
  </div>
${pager}  <table>
    <caption>Ledger postings &middot; page ${page}</caption>
    <thead>
      <tr><th>Date</th><th>Description</th><th>Tag</th><th class="amount">Amount</th></tr>
    </thead>
    <tbody>
${body}
    </tbody>
    <tfoot>
      <tr><td colspan="3">Page subtotal</td><td class="amount">$${money(subtotal)}</td></tr>
    </tfoot>
  </table>
${pager}  <footer>${ORG} is a fictional organisation used for local browser
  testing. Figures are invented and have no relationship to any real entity.</footer>
</main>
<script>
  const NONCE = '__SESSION_NONCE__';
  const status = document.getElementById('export-status');
  document.getElementById('export').addEventListener('click', async () => {
    status.textContent = 'Preparing export...';
    try {
      const res = await fetch('/api/ledger/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: NONCE, page: ${page} }),
      });
      if (!res.ok) {
        status.textContent = 'Export failed - reload the page and try again.';
        return;
      }
      const data = await res.json();
      status.textContent = 'Export ready - opening CSV.';
      window.location.assign(data.url);
    } catch {
      status.textContent = 'Export failed - reload the page and try again.';
    }
  });
</script>
</body>
</html>
`;
}

let seed = 0;
let rows = null;
let issues = null;
for (let candidate = 1; candidate <= 4000; candidate++) {
  const built = build(candidate);
  const found = problems(built);
  if (!found.length) {
    seed = candidate;
    rows = built;
    issues = found;
    break;
  }
  if (!issues || found.length < issues.length) {
    issues = found;
  }
}
if (!rows) {
  console.error('no seed satisfied the constraints; closest issues:');
  for (const issue of issues ?? []) console.error(`  - ${issue}`);
  process.exit(1);
}

const stats = analyze(rows);
const jsonLines = rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n');
await writeFile(DATA_FILE, `{\n  "rows": [\n${jsonLines}\n  ]\n}\n`);
const pageFiles = [];
for (let page = 1; page <= PAGE_COUNT; page++) {
  const name = page === 1 ? 'index.html' : `page-${page}.html`;
  const file = join(PAGES_DIR, name);
  await writeFile(file, renderPage(rows, page));
  pageFiles.push(file);
}

// The graded figures must not appear anywhere an agent can read: the served
// fixture (read back off disk), the row source, or this generator itself.
const rendered = [
  ...(await Promise.all(pageFiles.map((file) => readFile(file, 'utf8')))),
  jsonLines,
  await readFile(self, 'utf8'),
].join('\n');
const leaks = [
  [
    'hardware total',
    new RegExp(
      money(stats.tagTotals.hardware).replace(',', '[,\\s]?').replace('.', '\\.')
    ),
  ],
  ['row count', new RegExp(`(?<![\\d,.])${TOTAL_ROWS}(?!\\d|,\\d|\\.\\d)`)],
].filter(([, re]) => re.test(rendered));

console.log(`seed ${seed}`);
console.log(`rows ${rows.length} (pages 1-6 x ${PER_PAGE}, page ${PAGE_COUNT} x ${pageSlice(rows, PAGE_COUNT).length})`);
console.log('tag counts', stats.tagCounts);
console.log('tag totals', stats.tagTotals);
console.log('page totals', stats.pageTotals.map(money).join('  '));
console.log('hardware rows per page', stats.pageHardware.join(' '));
console.log(`grand total $${money(stats.grand)}`);
console.log(`largest amount $${money(stats.max)} (runner-up $${money(stats.runnerUp)})`);
console.log(
  leaks.length
    ? `LEAK in fixture: ${leaks.map(([what]) => what).join(', ')}`
    : 'no graded figure leaks into fixture source'
);
console.log('\nanswers.mjs entry:\n');
console.log(`  // pages/ledger/ (generated by gen/ledger.mjs, seed ${seed}) — the ledger
  // is static page content, so the answer key lives here only. The hardware
  // total ($${money(stats.tagTotals.hardware)}) collides with no other tag total, page subtotal,
  // grand total, or single amount (asserted at generation time); the largest
  // single amount ($${money(stats.max)}) is unique and leads the runner-up by more
  // than $10.
  ledger: {
    rowCount: ${TOTAL_ROWS},
    rowCountRe: /(?<![\\d,.])${TOTAL_ROWS}(?!\\d|,\\d|\\.\\d)/,
    hardwareTotal: ${stats.tagTotals.hardware},
    maxAmount: ${stats.max},
  },`);
