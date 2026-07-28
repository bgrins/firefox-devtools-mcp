// Golden path for T115 chart-escape (pages/metrics/). The graded figure is only
// ever drawn to a canvas, so the point of the task is finding the alternate
// representation every real dashboard ships. This driver takes the primary one —
// the "Table" toggle — and reads the rendered table back through the snapshot,
// never through evaluate_script, so a green run means our tool surface alone can
// win it.
//
// Two things about that surface, both measured while writing this (see
// staging/T115.md):
//   - the DEFAULT snapshot drops the whole <table>: after the toggle the only
//     new line is "18 monthly points, oldest f...". includeAll emits the rows;
//   - 18 rows push the page past the default line budget, so includeAll alone
//     shows the first ten months and silently cuts the rest. Both have to be set.
// Neither is worked around in the fixture.

const PATH = '/metrics/';

const textOf = (result) => (result.content ?? []).map((c) => c.text).join('\n');

async function until(sleep, label, fn, { tries = 40, waitMs = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(waitMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function uidFor(snap, pattern) {
  const line = snap.split('\n').find((l) => pattern.test(l));
  return line ? (line.match(/uid=(\S+)/)?.[1] ?? null) : null;
}

const ROW = /th text="([A-Z][a-z]{2} \d{4})"\n\s*uid=\S+ td text="([\d,]+)"/g;

async function readTable(mcp) {
  const snap = textOf(await mcp('take_snapshot', { includeAll: true, maxLines: 600 }));
  const rows = [];
  for (const match of snap.matchAll(ROW)) {
    rows.push({ label: match[1], value: Number(match[2].replace(/,/g, '')) });
  }
  return rows;
}

export const DRIVERS = {
  'chart-escape': {
    note: 'canvas-only metric: takes the Table toggle, reads rows via includeAll+maxLines',
    async run({ goto, mcp, snapshot, sleep }) {
      await goto(PATH);
      const chartSnap = await until(sleep, 'the seat series to load', async () => {
        const snap = await snapshot();
        return snap.includes('button "Table"') && !snap.includes('text="loading"') ? snap : null;
      });
      if (!chartSnap.includes('a "Export CSV"')) {
        throw new Error('the CSV escape hatch is missing from the panel header');
      }
      const toggle = uidFor(chartSnap, /button "Table"/);
      if (!toggle) throw new Error('no Table toggle in the snapshot');
      await mcp('click_by_uid', { uid: toggle });

      const rows = await until(sleep, 'the table view to render 18 rows', async () => {
        const found = await readTable(mcp);
        return found.length === 18 ? found : null;
      });

      let target = null;
      let runnerUp = null;
      for (let i = 1; i < rows.length; i++) {
        const fall = { at: i, drop: rows[i - 1].value - rows[i].value, from: rows[i - 1] };
        if (!target || fall.drop > target.drop) {
          runnerUp = target;
          target = fall;
        } else if (!runnerUp || fall.drop > runnerUp.drop) {
          runnerUp = fall;
        }
      }
      if (!target || target.drop <= 0) throw new Error('no month-over-month fall in the series');
      const month = rows[target.at];
      const second = rows[runnerUp.at];
      // The fixture's whole point: the two deepest falls are within a couple of
      // pixels of each other, and the winning figure is nowhere on the chart view.
      const margin = target.drop - runnerUp.drop;
      if (margin <= 0 || margin > 200) {
        throw new Error(`the two deepest falls are ${margin} seats apart, not a pixel apart`);
      }
      if (chartSnap.includes(month.value.toLocaleString('en-GB'))) {
        throw new Error(`${month.value} leaked into the chart view snapshot`);
      }
      // Not the runner-up on its own — the validator rejects that on the figure
      // alone. The phrasing worth keeping covered is the hedge a coin-flip agent
      // produces: pick the runner-up, quote the real answer as the close second.
      this.wrong =
        `${second.label} is my answer, with Active seats at ` +
        `${second.value.toLocaleString('en-GB')}; ${month.label} at ` +
        `${month.value.toLocaleString('en-GB')} is a close second.`;
      return (
        `Active seats fell furthest in ${month.label}, to ${month.value.toLocaleString('en-GB')} ` +
        `seats — down ${target.drop.toLocaleString('en-GB')} on ${target.from.label} ` +
        `(${target.from.value.toLocaleString('en-GB')}). The chart cannot settle it: ` +
        `${second.label} fell ${runnerUp.drop.toLocaleString('en-GB')}, ` +
        `only ${margin} seats less, so I read the exact figures from the Table view.`
      );
    },
  },
};
