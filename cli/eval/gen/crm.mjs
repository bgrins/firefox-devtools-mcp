// Generates all three Ridgeline CRM pages (pages/crm/index.html, orders.html
// and customers.html) from the data below and asserts the properties the eval
// task depends on: the winning region leads the runner-up by >= 15%, region
// totals are all distinct, and the winning total (the graded answer) collides
// with nothing rendered on any of the three pages. This generator lives OUTSIDE
// pages/ so it is not reachable over HTTP from the served static root.
// Run: node cli/eval/gen/crm.mjs
// The generated answers are printed at the end for copying into
// cli/eval/answers.mjs.

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const here = dirname(self);
const PAGES_DIR = join(here, '..', 'pages', 'crm');

const REGIONS = ['Callowfen', 'Norhaven', 'Tidereach', 'Westmarch'];

// [id, account, region, owner, since]
const CUSTOMERS = [
  ['CU-1001', 'Alderway Freight', 'Norhaven', 'R. Lindgren', '2019-04-02'],
  ['CU-1002', 'Bracken Mills', 'Westmarch', 'D. Kessler', '2020-09-16'],
  ['CU-1003', 'Cairnhill Foundry', 'Callowfen', 'M. Okonkwo', '2018-11-27'],
  ['CU-1004', 'Dunmore Logistics', 'Tidereach', 'S. Vale', '2021-02-08'],
  ['CU-1005', 'Elmgate Packaging', 'Westmarch', 'R. Lindgren', '2019-07-19'],
  ['CU-1006', 'Fennhollow Dairy', 'Norhaven', 'D. Kessler', '2022-05-30'],
  ['CU-1007', 'Garrow Instruments', 'Callowfen', 'S. Vale', '2020-01-14'],
  ['CU-1008', 'Haskett Timber', 'Westmarch', 'M. Okonkwo', '2017-08-23'],
  ['CU-1009', 'Iverly Marine', 'Tidereach', 'D. Kessler', '2021-10-05'],
  ['CU-1010', 'Jarrow Textiles', 'Norhaven', 'S. Vale', '2023-03-21'],
  ['CU-1011', 'Kelbourne Ceramics', 'Callowfen', 'R. Lindgren', '2018-06-11'],
  ['CU-1012', 'Lanthorn Optics', 'Westmarch', 'M. Okonkwo', '2022-12-01'],
  ['CU-1013', 'Merrow Glassworks', 'Tidereach', 'R. Lindgren', '2020-04-28'],
  ['CU-1014', 'Northcott Paper', 'Callowfen', 'D. Kessler', '2023-09-07'],
  ['CU-1015', 'Orrick Bearings', 'Norhaven', 'M. Okonkwo', '2019-01-25'],
];

// [orderId, customerId, value, date]
const ORDERS = [
  ['SO-2401', 'CU-1002', '14205.80', '2026-01-08'],
  ['SO-2402', 'CU-1012', '13660.05', '2026-01-15'],
  ['SO-2403', 'CU-1004', '27480.35', '2026-02-11'],
  ['SO-2404', 'CU-1005', '15760.25', '2026-02-13'],
  ['SO-2405', 'CU-1003', '38940.25', '2026-02-16'],
  ['SO-2406', 'CU-1008', '10980.70', '2026-02-19'],
  ['SO-2407', 'CU-1009', '24600.75', '2026-02-24'],
  ['SO-2408', 'CU-1007', '21480.55', '2026-02-25'],
  ['SO-2409', 'CU-1002', '9875.45', '2026-02-27'],
  ['SO-2410', 'CU-1001', '22340.60', '2026-03-02'],
  ['SO-2411', 'CU-1004', '31250.50', '2026-03-04'],
  ['SO-2412', 'CU-1011', '18320.70', '2026-03-09'],
  ['SO-2413', 'CU-1006', '17650.90', '2026-03-12'],
  ['SO-2414', 'CU-1013', '19750.40', '2026-03-17'],
  ['SO-2415', 'CU-1012', '9540.80', '2026-03-24'],
  ['SO-2416', 'CU-1014', '16240.90', '2026-03-30'],
  ['SO-2417', 'CU-1005', '11430.90', '2026-04-03'],
  ['SO-2418', 'CU-1009', '22145.25', '2026-04-08'],
  ['SO-2419', 'CU-1003', '12150.80', '2026-04-10'],
  ['SO-2420', 'CU-1010', '19880.15', '2026-04-15'],
  ['SO-2421', 'CU-1002', '12540.10', '2026-04-21'],
  ['SO-2422', 'CU-1007', '9650.30', '2026-04-24'],
  ['SO-2423', 'CU-1008', '16340.15', '2026-04-29'],
  ['SO-2424', 'CU-1001', '13780.25', '2026-05-06'],
  ['SO-2425', 'CU-1015', '14960.80', '2026-05-11'],
  ['SO-2426', 'CU-1004', '18905.20', '2026-05-19'],
  ['SO-2427', 'CU-1006', '10420.35', '2026-05-20'],
  ['SO-2428', 'CU-1012', '15120.40', '2026-05-22'],
  ['SO-2429', 'CU-1013', '21300.15', '2026-05-28'],
  ['SO-2430', 'CU-1011', '14760.15', '2026-06-02'],
  ['SO-2431', 'CU-1005', '13215.35', '2026-06-05'],
  ['SO-2432', 'CU-1014', '11890.45', '2026-06-09'],
  ['SO-2433', 'CU-1009', '29880.60', '2026-06-12'],
  ['SO-2434', 'CU-1010', '12315.70', '2026-06-15'],
  ['SO-2435', 'CU-1002', '8320.60', '2026-06-18'],
  ['SO-2436', 'CU-1015', '9730.45', '2026-06-24'],
  ['SO-2437', 'CU-1008', '12875.50', '2026-06-30'],
  ['SO-2438', 'CU-1013', '18412.90', '2026-07-02'],
  ['SO-2439', 'CU-1014', '8470.60', '2026-07-06'],
  ['SO-2440', 'CU-1012', '7480.95', '2026-07-09'],
];

const cents = (value) => Math.round(Number(value) * 100);
const group = (digits) => digits.replace(/\B(?=(\d{3})+$)/g, ',');
const money = (totalCents) => {
  const [whole, frac] = (totalCents / 100).toFixed(2).split('.');
  return `${group(whole)}.${frac}`;
};

const regionOf = new Map(CUSTOMERS.map(([id, , region]) => [id, region]));
const accountOf = new Map(CUSTOMERS.map(([id, account]) => [id, account]));

const regionTotals = new Map(REGIONS.map((r) => [r, 0]));
const regionOrderCounts = new Map(REGIONS.map((r) => [r, 0]));
const customerTotals = new Map(CUSTOMERS.map(([id]) => [id, 0]));
let grandTotal = 0;
for (const [, customerId, value] of ORDERS) {
  const region = regionOf.get(customerId);
  if (!region) throw new Error(`order references unknown customer ${customerId}`);
  const amount = cents(value);
  regionTotals.set(region, regionTotals.get(region) + amount);
  regionOrderCounts.set(region, regionOrderCounts.get(region) + 1);
  customerTotals.set(customerId, customerTotals.get(customerId) + amount);
  grandTotal += amount;
}

const ranked = [...regionTotals.entries()].sort((a, b) => b[1] - a[1]);
const [topRegion, topTotal] = ranked[0];
const [runnerUpRegion, runnerUpTotal] = ranked[1];
const largest = ORDERS.reduce((a, b) => (cents(b[2]) > cents(a[2]) ? b : a));
const averageOrder = Math.round(grandTotal / ORDERS.length);

const regionCustomerCounts = new Map(REGIONS.map((r) => [r, 0]));
for (const [, , region] of CUSTOMERS) {
  regionCustomerCounts.set(region, regionCustomerCounts.get(region) + 1);
}

const head = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} - Ridgeline CRM</title>
<link rel="stylesheet" href="crm.css">
</head>
<body>
<header class="topbar">
  <span class="brand">Ridgeline CRM</span>
  <span class="ws">wkspc northfield-supply &middot; fiscal 2026 &middot; role: analyst</span>
  <span class="who">dana.kessler@northfield.example</span>
</header>
<nav class="tabs">
  <a href="index.html"${title === 'Dashboard' ? ' class="on"' : ''}>Dashboard</a>
  <a href="orders.html"${title === 'Orders' ? ' class="on"' : ''}>Orders</a>
  <a href="customers.html"${title === 'Customers' ? ' class="on"' : ''}>Customers</a>
  <a href="#pipeline">Pipeline</a>
  <a href="#reports">Reports</a>
  <a href="#tasks">Tasks</a>
  <a href="#admin">Admin</a>
</nav>
<div class="pathbar">
  <span>northfield-supply / ${title.toLowerCase()}</span>
  <span class="build">grid engine v3 &middot; build 3.14.2</span>
</div>
<main class="main">`;

const foot = `</main>
<footer class="siteftr">
  Ridgeline CRM &middot; workspace data is confidential to northfield-supply.
  Support: help.ridgelinecrm.example &middot; Status &middot; Keyboard shortcuts &middot;
  Terms &middot; Privacy
</footer>
</body>
</html>
`;

const dashboard = `${head('Dashboard')}
  <h1>Dashboard</h1>
  <p class="sub">Fiscal year 2026 to date. Warehouse snapshot rebuilt nightly at 02:00.</p>
  <div class="tiles">
    <div class="tile"><span class="tk">Orders recorded</span><span class="tv">${ORDERS.length}</span></div>
    <div class="tile"><span class="tk">Active accounts</span><span class="tv">${CUSTOMERS.length}</span></div>
    <div class="tile"><span class="tk">Total order value</span><span class="tv">$${money(grandTotal)}</span></div>
    <div class="tile"><span class="tk">Average order value</span><span class="tv">$${money(averageOrder)}</span></div>
    <div class="tile"><span class="tk">Largest single order</span><span class="tv">$${money(cents(largest[2]))}</span></div>
    <div class="tile"><span class="tk">Sales regions</span><span class="tv">${REGIONS.length}</span></div>
  </div>
  <div class="cards">
    <section class="card">
      <h2>Release notes 3.14</h2>
      <p><a href="orders.html">Orders</a> and <a href="customers.html">Customers</a> now run on the
      v3 grid engine. Column widths and sort order persist per operator.</p>
      <p class="muted">Saved views are read-only on shared workspace links.</p>
    </section>
    <section class="card">
      <h2>Region rollup</h2>
      <p class="warn">Rebuilding</p>
      <p>This report was retired with the v3 warehouse migration and region
      totals are no longer published here. Compile them from Orders and
      Customers until the replacement ships.</p>
    </section>
    <section class="card">
      <h2>Order feed (tail)</h2>
      <table class="mini">
        <tr><th>Order</th><th>Account</th><th class="num">Value</th></tr>
${ORDERS.slice(-4)
  .reverse()
  .map(
    ([id, customerId, value]) =>
      `        <tr><td>${id}</td><td>${accountOf.get(customerId)}</td><td class="num">$${money(cents(value))}</td></tr>`
  )
  .join('\n')}
      </table>
    </section>
    <section class="card">
      <h2>Operator notices</h2>
      <p>Quarter-end close is the 9th. Late orders roll into the next period.</p>
      <p>Territory reassignments are frozen until the rollup report returns.</p>
    </section>
  </div>
${foot}`;

const orders = `${head('Orders')}
  <h1>Orders</h1>
  <p class="sub">All ${ORDERS.length} orders recorded in fiscal 2026, oldest first.</p>
  <form class="filters" id="filters">
    <label>acct <input type="search" name="q" placeholder="CU-1001" autocomplete="off" size="10"></label>
    <label>from <input type="date" name="from" value="2026-01-01"></label>
    <label>to <input type="date" name="to" value="2026-07-31"></label>
    <button type="submit">Run query</button>
    <span class="fnote" id="fnote"></span>
  </form>
  <table class="grid">
    <thead>
      <tr><th>Order</th><th>Account id</th><th class="num">Order value</th><th>Order date</th></tr>
    </thead>
    <tbody>
${ORDERS.map(
  ([id, customerId, value, date]) =>
    `      <tr><td>${id}</td><td>${customerId}</td><td class="num">$${money(cents(value))}</td><td>${date}</td></tr>`
).join('\n')}
    </tbody>
    <tfoot>
      <tr><td>Total</td><td>${ORDERS.length} orders</td><td class="num">$${money(grandTotal)}</td><td></td></tr>
    </tfoot>
  </table>
  <p class="muted">rows ${ORDERS.length}/${ORDERS.length} &middot; CSV export is unavailable on shared workspace links.</p>
  <script>
    document.getElementById('filters').addEventListener('submit', (event) => {
      event.preventDefault();
      document.getElementById('fnote').textContent =
        'Saved views are read-only on shared workspace links.';
    });
  </script>
${foot}`;

const customers = `${head('Customers')}
  <h1>Customers</h1>
  <p class="sub">${CUSTOMERS.length} active accounts. Region is set by the assigned territory, not by billing address.</p>
  <form class="filters" id="filters">
    <label>region
      <select name="region">
        <option>All regions</option>
${REGIONS.map((region) => `        <option>${region}</option>`).join('\n')}
      </select>
    </label>
    <label>owner
      <select name="owner">
        <option>All owners</option>
${[...new Set(CUSTOMERS.map((c) => c[3]))]
  .sort()
  .map((owner) => `        <option>${owner}</option>`)
  .join('\n')}
      </select>
    </label>
    <button type="submit">Run query</button>
    <span class="fnote" id="fnote"></span>
  </form>
  <table class="grid">
    <thead>
      <tr><th>Account id</th><th>Account</th><th>Region</th><th>Owner</th><th>Customer since</th></tr>
    </thead>
    <tbody>
${CUSTOMERS.map(
  ([id, account, region, owner, since]) =>
    `      <tr><td>${id}</td><td>${account}</td><td>${region}</td><td>${owner}</td><td>${since}</td></tr>`
).join('\n')}
    </tbody>
  </table>
  <section class="card wide">
    <h2>Accounts per region</h2>
    <table class="mini">
      <tr><th>Region</th><th class="num">Accounts</th></tr>
${REGIONS.map(
  (region) =>
    `      <tr><td>${region}</td><td class="num">${regionCustomerCounts.get(region)}</td></tr>`
).join('\n')}
    </table>
    <p class="muted">Account counts only. Order value is not held on the account record.</p>
  </section>
  <script>
    document.getElementById('filters').addEventListener('submit', (event) => {
      event.preventDefault();
      document.getElementById('fnote').textContent =
        'Saved views are read-only on shared workspace links.';
    });
  </script>
${foot}`;

const pages = {
  'index.html': dashboard,
  'orders.html': orders,
  'customers.html': customers,
};

// --- assertions -------------------------------------------------------------

const fail = (message) => {
  throw new Error(`gen/crm.mjs assertion failed: ${message}`);
};

if (new Set(ranked.map(([, total]) => total)).size !== REGIONS.length) {
  fail('two regions share a total');
}
const lead = topTotal / runnerUpTotal;
if (lead < 1.15) {
  fail(`winner leads runner-up by only ${((lead - 1) * 100).toFixed(1)}% (need 15%)`);
}
if (topTotal % 100 === 0 || topTotal % 100000 === 0) {
  fail('winning total is a round figure');
}
for (const [, account] of CUSTOMERS) {
  if (REGIONS.some((region) => account.includes(region))) {
    fail(`account name ${account} contains a region name`);
  }
}
for (const region of REGIONS) {
  if (REGIONS.some((other) => other !== region && other.includes(region))) {
    fail(`region ${region} is a substring of another region`);
  }
  if (!regionOrderCounts.get(region)) fail(`region ${region} has no orders`);
}
for (const [id, total] of customerTotals) {
  if (!total) fail(`customer ${id} has no orders`);
}

// The join must be the only path: no region on the orders page, no order
// value on the customers page.
for (const region of REGIONS) {
  if (pages['orders.html'].includes(region)) fail(`orders.html mentions region ${region}`);
}
for (const [, , value] of ORDERS) {
  if (pages['customers.html'].includes(money(cents(value)))) {
    fail(`customers.html shows an order value (${value})`);
  }
}

// The graded figure must be unique across the whole page set: not rendered
// anywhere, and no rendered figure within 0.5% of any region total -- the
// validator's relative window, so an agent reporting a page subtotal, the grand
// total or a row value cannot pass even under thousand-rounding.
const MATCH_WINDOW = 0.005;
const TOKEN = /\d{1,3}(?:[,\s\u00a0]\d{3})*(?:\.\d+)?/g;
for (const [name, html] of Object.entries(pages)) {
  const digits = String(topTotal / 100).replace('.', '');
  const whole = String(Math.trunc(topTotal / 100));
  for (const needle of [money(topTotal), whole, group(whole), digits]) {
    if (html.includes(needle)) fail(`${name} contains the winning total (${needle})`);
  }
  for (const raw of html.match(TOKEN) ?? []) {
    const value = Number(raw.replace(/[,\s\u00a0]/g, ''));
    if (!Number.isFinite(value)) continue;
    for (const [region, total] of regionTotals) {
      if (Math.abs(value * 100 - total) <= total * MATCH_WINDOW) {
        fail(`${name} renders ${raw}, within 0.5% of the ${region} total`);
      }
    }
  }
}
const genSource = await readFile(self, 'utf8');
if (genSource.includes(money(topTotal)) || genSource.includes(String(Math.trunc(topTotal / 100)))) {
  fail('this generator contains the winning total as a literal');
}

// Anti-heuristic: neither "most orders" nor "holds the biggest single order"
// nor "most accounts" picks the winner.
const mostOrders = [...regionOrderCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
if (mostOrders === topRegion) fail('the region with the most orders is also the winner');
if (regionOf.get(largest[1]) === topRegion) fail('the largest single order is in the winning region');
const mostAccounts = [...regionCustomerCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
if (mostAccounts === topRegion) fail('the region with the most accounts is also the winner');

for (const [name, html] of Object.entries(pages)) {
  await writeFile(join(PAGES_DIR, name), html);
  console.log(`wrote pages/crm/${name} (${html.length} bytes)`);
}

console.log('\nregion totals (highest first):');
for (const [region, total] of ranked) {
  console.log(
    `  ${region.padEnd(10)} $${money(total).padStart(11)}  ` +
      `${regionOrderCounts.get(region)} orders, ${regionCustomerCounts.get(region)} accounts`
  );
}
console.log(`\ngrand total          $${money(grandTotal)}`);
console.log(`largest single order $${money(cents(largest[2]))} (${largest[0]}, ${regionOf.get(largest[1])})`);
console.log(`winner leads runner-up (${runnerUpRegion}) by ${((lead - 1) * 100).toFixed(1)}%`);
console.log('\nanswers.mjs entry:\n');
console.log(`  // pages/crm/ (all three pages generated by gen/crm.mjs, which lives
  // outside the served root) — orders.html carries account ids but no region,
  // customers.html carries regions but no order value, so the region totals
  // exist nowhere on disk and must be computed by joining the two tables. The
  // generator asserts the winner leads the runner-up by >= 15% and that no
  // figure rendered on any of the three pages comes within 0.5% of any region
  // total, which is the validator's matching window.
  crm: {
    topRegion: '${topRegion}',
    topRegionTotal: '${money(topTotal)}',
    otherRegions: [${REGIONS.filter((region) => region !== topRegion)
      .map((region) => `'${region}'`)
      .join(', ')}],
  },`);
