// Golden-path drivers. See probes.mjs for the contract.
//
// This family is the data-extraction and long-horizon set. Two things about the
// tool surface shape every driver here:
//   - the snapshot walker drops <table>, <tr> and <td> outright (they are
//     neither interactive nor semantic containers), so every tabular fixture
//     (ledger, crm, rosters, filemgr rows) is readable only through evaluate;
//   - snapshot text and href are truncated to 30 characters, which hides the
//     tail of a composed row ("QX-4417 - Ingrid Halvorsen - Research - Floor
//     14") and, on a 127.0.0.1:PORT origin, the whole path of an href.

import { ANSWERS } from '../answers.mjs';

async function until(sleep, fn, label, tries = 60, wait = 250) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (last) return last;
    await sleep(wait);
  }
  throw new Error(`${label} (last value: ${JSON.stringify(last)})`);
}

function uidFor(snap, re, label) {
  const m = snap.match(re);
  if (!m) throw new Error(`${label} not in the snapshot`);
  return m[1];
}

const money = (n) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Rows of a rendered <table>, as [cellText, ...] per body row. Table markup is
// invisible to the snapshot, so this is the only way to read one.
const tableRows = (selector) => `() => {
  const out = [];
  for (const tr of document.querySelectorAll(${JSON.stringify(selector)})) {
    out.push([...tr.children].map((cell) => cell.textContent.trim()));
  }
  return out;
}`;

const MAZE_HEADINGS = { N: [-1, 0], E: [0, 1], S: [1, 0], W: [0, -1] };
const MAZE_BACK = { N: 'S', S: 'N', E: 'W', W: 'E' };
const MAZE_BUTTON = { N: 'north', E: 'east', S: 'south', W: 'west' };
const mazeRef = (r, c) => 'ABCDEF'[c] + (r + 1);
const mazeParse = (ref) => [Number(ref.slice(1)) - 1, 'ABCDEF'.indexOf(ref[0])];

export const DRIVERS = {
  // --- virtualized list behind a session-gated chunk endpoint ---
  'biglist-needle': {
    note: 'streams every batch by scrolling; evaluate scrolls and reads the hit row',
    wrong: 'Badge QX-4417 belongs to Ingrid Halvorsen, who sits on floor 7.',
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      await goto('/biglist/');
      await until(
        sleep,
        () => evaluate(() => document.querySelectorAll('#rows .row').length > 0),
        'virtual list never rendered a row'
      );
      // Search covers only the batches already streamed, so arm it first and
      // then scroll: every new batch re-runs the filter as it lands.
      const snap = await snapshot();
      const input = uidFor(snap, /uid=(\S+) input[^\n]*[Ss]earch/, 'directory search box');
      await mcp('fill_by_uid', { uid: input, value: 'QX-' });
      let hit = '';
      // 5,000 rows in batches of 250, and there is no scroll tool: scroll one
      // batch at a time so the batches are genuinely streamed in order.
      for (let batch = 0; batch < 20 && !hit; batch++) {
        await evaluate(
          `() => { document.getElementById('viewport').scrollTop = ${batch * 250 * 40}; }`
        );
        await until(
          sleep,
          () => evaluate(() => !document.querySelector('#rows .row.pending')),
          `batch ${batch + 1} never finished streaming`
        );
        // The hit line is one composed string, so the snapshot truncates it
        // before the floor: evaluate is the only way to read it whole.
        hit = await evaluate(() => {
          const el = document.querySelector('#filter-results .hit');
          return el ? el.textContent.trim() : '';
        });
      }
      if (!hit) throw new Error('no QX- badge found after streaming every batch');
      const m = hit.match(/^(\S+)\s+—\s+(.+?)\s+—\s+(.+?)\s+—\s+Floor\s+(\d+)$/);
      if (!m) throw new Error(`unexpected hit row: ${hit}`);
      return `Badge ${m[1]} belongs to ${m[2]} in ${m[3]}, on floor ${m[4]}.`;
    },
  },

  // --- 7 paginated tables, summed by tag ---
  'ledger-sum': {
    note: 'walks the pager by clicking Next; the rows are table markup, so evaluate reads them',
    wrong: 'The hardware postings across the seven folios add up to $26,402.15.',
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      await goto('/ledger/');
      let total = 0;
      let count = 0;
      for (let page = 1; page <= 7; page++) {
        await until(
          sleep,
          async () => (await evaluate(() => document.title)).includes(`Page ${page}`),
          `never landed on ledger page ${page}`
        );
        const rows = await evaluate(tableRows('table tbody tr'));
        if (!rows.length) throw new Error(`ledger page ${page} rendered no rows`);
        for (const [, , tag, amount] of rows) {
          if (tag.toLowerCase() !== 'hardware') continue;
          total += Number(amount.replace(/[$,]/g, ''));
          count++;
        }
        if (page === 7) break;
        const snap = await snapshot();
        await mcp('click_by_uid', {
          uid: uidFor(snap, /uid=(\S+) a "Next"/, 'pager Next link'),
        });
      }
      return (
        `Across all seven folios there are ${count} postings tagged hardware, ` +
        `totalling $${money(total)}.`
      );
    },
  },

  // --- server-minted export token, then the CSV itself ---
  'ledger-csv': {
    note: 'clicks Export CSV so the server mints the token; the CSV body is bulk text, read via evaluate',
    wrong: 'The exported CSV holds 140 data rows and its largest amount is $3,783.63.',
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      await goto('/ledger/');
      const snap = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(snap, /uid=(\S+) button "Export CSV"/, 'Export CSV button'),
      });
      await until(
        sleep,
        async () => (await evaluate(() => location.pathname)).includes('export.csv'),
        'the export never navigated to the CSV'
      );
      const csv = await evaluate(() => document.body.innerText);
      const lines = String(csv).trim().split('\n');
      const header = lines.shift();
      if (!/^date,description,tag,amount$/.test(header.trim())) {
        throw new Error(`unexpected CSV header: ${header}`);
      }
      const amounts = lines.map((line) => Number(line.split(',').pop()));
      if (amounts.some((n) => !Number.isFinite(n))) {
        throw new Error('the CSV holds a non-numeric amount');
      }
      return (
        `The exported CSV has ${amounts.length} data rows, and the largest single ` +
        `transaction amount in it is $${money(Math.max(...amounts))}.`
      );
    },
  },

  // --- join two tables, neither of which holds the answer ---
  'crm-join': {
    note: 'joins orders to customers; both are table markup the snapshot drops, so evaluate reads them',
    wrong: 'Callowfen generated the highest total order value, $171,347.05.',
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      await goto('/crm/');
      const home = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(home, /uid=(\S+) a "Orders"/, 'Orders nav link'),
      });
      await until(
        sleep,
        async () => (await evaluate(() => document.title)).includes('Orders'),
        'never landed on the orders page'
      );
      const orders = await evaluate(tableRows('table tbody tr'));
      const onOrders = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(onOrders, /uid=(\S+) a "Customers"/, 'Customers nav link'),
      });
      await until(
        sleep,
        async () => (await evaluate(() => document.title)).includes('Customer'),
        'never landed on the customers page'
      );
      const customers = await evaluate(tableRows('table tbody tr'));
      if (orders.length !== 40) throw new Error(`expected 40 orders, read ${orders.length}`);
      const region = new Map(customers.map(([id, , where]) => [id, where]));
      const totals = new Map();
      for (const [, account, value] of orders) {
        const where = region.get(account);
        if (!where) throw new Error(`order account ${account} has no customer row`);
        totals.set(where, (totals.get(where) ?? 0) + Number(value.replace(/[$,]/g, '')));
      }
      const [top, amount] = [...totals].sort((a, b) => b[1] - a[1])[0];
      return (
        `${top} generated the highest total order value: $${money(amount)}, joining all ` +
        `${orders.length} orders to the customer directory by account id.`
      );
    },
  },

  // --- delta between two published rosters with different column sets ---
  'roster-diff': {
    note: 'diffs the two roster tables; rows are table markup, so evaluate reads them',
    wrong:
      'Added: Sadie Achebe and Nell Braddock. Removed: Priya Ellery and Tobias Wren are ' +
      'no longer listed. Title change: Dara Quill is now a Senior Analyst.',
    async run({ goto, evaluate, sleep }) {
      await goto('/rosters/');
      // The two roster links truncate to the same 30-character snapshot text
      // AND the same truncated href (a 127.0.0.1:PORT origin eats the path), so
      // a snapshot cannot tell them apart; navigate by URL instead.
      const read = async (year) => {
        await goto(`/rosters/${year}.html`);
        await until(
          sleep,
          async () => (await evaluate(() => document.title)).includes(String(year)),
          `never landed on the ${year} roster`
        );
        const people = new Map();
        for (const cells of await evaluate(tableRows('table tbody tr'))) {
          // Department header rows hold a single <th>; staff rows lead with a name.
          if (cells.length < 2) continue;
          people.set(cells[0], cells[1]);
        }
        if (people.size < 20) throw new Error(`${year} roster parsed only ${people.size} people`);
        return people;
      };
      const y2025 = await read(2025);
      const y2026 = await read(2026);
      const added = [...y2026.keys()].filter((name) => !y2025.has(name));
      const removed = [...y2025.keys()].filter((name) => !y2026.has(name));
      const retitled = [...y2026].filter(
        ([name, title]) => y2025.has(name) && y2025.get(name) !== title
      );
      if (!added.length || !removed.length || !retitled.length) {
        throw new Error(`degenerate diff: +${added.length} -${removed.length} ~${retitled.length}`);
      }
      const lines = ['Comparing the 2025 and 2026 staff rosters:'];
      for (const name of added) {
        lines.push(`Added: ${name} joins the 2026 roster as ${y2026.get(name)}.`);
      }
      for (const name of removed) {
        lines.push(`Removed: ${name}, ${y2025.get(name)} in 2025, is no longer on the 2026 roster.`);
      }
      for (const [name, title] of retitled) {
        lines.push(`Title changed: ${name} was ${y2025.get(name)} in 2025 and is ${title} in 2026.`);
      }
      return lines.join('\n');
    },
  },

  // --- session carry-over: the choice gates what the next page is served ---
  'intake-carryover': {
    note: 'clicks the Contractor path, then reads the served checklist from a scoped snapshot',
    wrong: 'Bring Form I-12, the Direct Deposit Form and a Badge Photo on day one.',
    async run({ goto, mcp, snapshot, sleep }) {
      await goto('/intake/');
      const snap = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(snap, /uid=(\S+) button "Choose Contractor path"/, 'Contractor path button'),
      });
      const withLink = await until(
        sleep,
        async () => {
          const s = await snapshot();
          return /uid=\S+ a "Continue to document requ/.test(s) ? s : null;
        },
        'the continue link never appeared after choosing the Contractor path'
      );
      await mcp('click_by_uid', {
        uid: uidFor(withLink, /uid=(\S+) a "Continue to document requ/, 'continue link'),
      });
      const docs = await until(
        sleep,
        async () => {
          const r = await mcp('take_snapshot', { selector: '#docs' });
          const text = (r.content ?? []).map((c) => c.text).join('\n');
          const items = [...text.matchAll(/ li text="([^"]+)"/g)].map((m) => m[1]);
          return items.length ? items : null;
        },
        'the requirements list never rendered'
      );
      if (docs.length !== 3) throw new Error(`expected 3 documents, read ${docs.length}`);
      return (
        `On the Contractor path I have to bring three documents on day one: ` +
        `${docs.slice(0, -1).join(', ')} and ${docs.at(-1)}.`
      );
    },
  },

  // --- optimistic UI the server rejects and the page rolls back ---
  'rename-rollback': {
    canned: true,
    note: 'drives the real rejected rename and waits out the rollback; the narrative is canned',
    wrong: 'The rename went through, and the file is now called draft-final.',
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      await goto('/filemgr/');
      await until(
        sleep,
        () => evaluate(() => document.querySelectorAll('#rows tr').length > 0),
        'the file list never loaded'
      );
      // Every row's action button reads just "Rename", so filter the list down
      // to the one file first: that is what makes the right button identifiable
      // through the snapshot.
      const listed = await snapshot();
      await mcp('fill_by_uid', {
        uid: uidFor(listed, /uid=(\S+) input "Search Working files"/, 'file search box'),
        value: ANSWERS.filemgr.lockedName,
      });
      const filtered = await until(
        sleep,
        async () => {
          const rows = await evaluate(() => document.querySelectorAll('#rows tr').length);
          return rows === 1 ? await snapshot() : null;
        },
        'the search never narrowed the list to one row'
      );
      await mcp('click_by_uid', {
        uid: uidFor(filtered, /uid=(\S+) button "Rename"/, 'Rename button'),
      });
      const editing = await until(
        sleep,
        async () => {
          const s = await snapshot();
          return /uid=\S+ input "New file name"/.test(s) ? s : null;
        },
        'the rename editor never opened'
      );
      await mcp('fill_by_uid', {
        uid: uidFor(editing, /uid=(\S+) input "New file name"/, 'rename input'),
        value: ANSWERS.filemgr.targetName,
      });
      const saving = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(saving, /uid=(\S+) button "Save"/, 'Save button'),
      });
      // The row takes the new name optimistically; the rollback lands ~2s later,
      // so watch for both in one poll.
      let flashed = false;
      const rolled = await until(
        sleep,
        async () => {
          const state = await evaluate(() => ({
            name: document.querySelector('#rows tr td.name')?.textContent?.trim() ?? '',
            toast: document.getElementById('toastMsg')?.textContent?.trim() ?? '',
          }));
          if (state.name === ANSWERS.filemgr.targetName) flashed = true;
          return state.name === ANSWERS.filemgr.lockedName && state.toast ? state : null;
        },
        'the row never rolled back'
      );
      if (!flashed) throw new Error('never saw the optimistic flash of the new name');
      return [
        `The rename did not persist. I renamed the file through its Rename action and the`,
        `list briefly showed 'draft-final', but the server refused the change`,
        `(${rolled.toast}) and about two seconds later the row reverted on its own.`,
        `Re-checking the list, the file is still called 'draft-old' and no file named`,
        `'draft-final' exists in Working files.`,
      ].join(' ');
    },
  },

  // --- client-scored word puzzle ---
  gridword: {
    note: 'plays day 0 through the guess box; the day-0 word comes from the answer key',
    wrong: 'The answer word was PLUMB and I got it in three guesses.',
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      await goto('/gridword/?day=0');
      const guess = async (word) => {
        const snap = await snapshot();
        await mcp('fill_by_uid', {
          uid: uidFor(snap, /uid=(\S+) input "Enter your guess"/, 'guess input'),
          value: word,
        });
        await mcp('click_by_uid', {
          uid: uidFor(snap, /uid=(\S+) button "Submit guess"/, 'submit button'),
        });
        await until(
          sleep,
          async () =>
            String(await evaluate(() => document.getElementById('feedback').textContent)).includes(
              word
            ),
          `guess ${word} never landed on the board`
        );
      };
      // A cold opener first, so this is a played game rather than one lucky word.
      await guess('SLATE');
      await guess(ANSWERS.gridword.day0Word);
      const solved = await until(
        sleep,
        async () => {
          const state = await evaluate(() => ({
            status: document.getElementById('status').textContent.trim(),
            counter: document.getElementById('counter').textContent.trim(),
            answer: document.getElementById('answerLine').textContent.trim(),
          }));
          return /solved/i.test(state.status) ? state : null;
        },
        'the puzzle never reported a solve'
      );
      const word = solved.answer.replace(/^Answer:\s*/, '');
      const used = Number(solved.counter.match(/Guess (\d+) of/)?.[1]);
      return `The answer word is ${word} and I used ${used} guesses (${solved.status}).`;
    },
  },

  // --- server-scored hard mode; the word never reaches the page ---
  'gridword-hard': {
    note:
      'CHEATS: the day-3 word comes from the answer key, because it is server-held and no ' +
      'word list is available to deduce it from, so this proves the fixture, the hard-mode ' +
      'refusal and the validator work — not that the puzzle is solvable',
    wrong: 'The hard-mode answer was JUNIPER and the board ended on guess 3 of 5.',
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      await goto('/gridword/?mode=hard&day=3');
      await until(
        sleep,
        () => evaluate(() => document.getElementById('letters').textContent.includes('Fixed spots')),
        'the hard-mode hint lines never rendered'
      );
      const send = async (word) => {
        const snap = await snapshot();
        await mcp('fill_by_uid', {
          uid: uidFor(snap, /uid=(\S+) input "Enter your guess"/, 'guess input'),
          value: word,
        });
        await mcp('click_by_uid', {
          uid: uidFor(snap, /uid=(\S+) button "Submit guess"/, 'submit button'),
        });
        return until(
          sleep,
          async () => {
            const state = await evaluate(() => ({
              status: document.getElementById('status').textContent.trim(),
              counter: document.getElementById('counter').textContent.trim(),
              feedback: document.getElementById('feedback').textContent,
              hints: document.getElementById('letters').textContent,
            }));
            return /games desk\.$/.test(state.status) ? null : state;
          },
          `the games desk never answered for ${word}`
        );
      };
      // A real opener, so the run exercises the server's marking and hint lines.
      const first = await send('COUNTER');
      if (!/Guess 1 of 5/.test(first.counter)) {
        throw new Error(`the opener was not counted: ${first.counter}`);
      }
      const fixed = first.hints.match(/Fixed spots: ([^\n]*)/)?.[1] ?? '';
      const reuse = first.hints.match(/Must reuse: ([^\n]*)/)?.[1] ?? '';
      if (/none yet/.test(fixed) && /nothing yet/.test(reuse)) {
        throw new Error('the opener revealed no hint at all, so hard mode cannot bind');
      }
      // Hard mode has to be binding: a guess that drops the revealed hints must
      // be refused, and a refusal must not spend a try.
      const refused = await send('MIDWIFE');
      if (!/hard mode/i.test(refused.status)) {
        throw new Error(`a hint-dropping guess was not refused: "${refused.status}"`);
      }
      if (!/Guess 1 of 5/.test(refused.counter)) {
        throw new Error(`a refused guess spent a try: ${refused.counter}`);
      }
      const won = await send(ANSWERS.gridword.hardDay3);
      if (!/solved/i.test(won.status)) {
        throw new Error(`the desk did not confirm a solve: "${won.status}"`);
      }
      const used = Number(won.counter.match(/Guess (\d+) of/)?.[1]);
      return (
        `The word is ${ANSWERS.gridword.hardDay3}. The board ends on guess ${used} of 5; ` +
        `one further guess was refused for dropping a revealed hint, which cost no try.`
      );
    },
  },

  // --- fog of war: walls are reported only for cells the rover has entered ---
  'maze-escape': {
    note: 'real depth-first explore with discovery; only the current cell telemetry is ever read',
    wrong:
      'The rover reached the extraction pad at F6, but the console never printed an ' +
      'extraction code.',
    async run({ goto, mcp, snapshot, sleep }) {
      await goto('/maze/');
      const read = async () => {
        const snap = await snapshot();
        const at = snap.match(/ p text="POS ([A-F][1-6])"/);
        const clear = snap.match(/ p text="CLEAR ([^"]*)"/);
        if (!at || !clear) return null;
        return {
          snap,
          at: at[1],
          clear: clear[1] === 'none' ? [] : clear[1].split(','),
          code: snap.match(/ p text="(MZ-[0-9A-F]{4})"/)?.[1] ?? null,
        };
      };
      let view = await until(sleep, read, 'the traverse console never reported telemetry');
      const known = new Map([[view.at, view.clear]]);
      const trail = [];
      for (let step = 0; step < 200 && view.at !== 'F6'; step++) {
        const [r, c] = mazeParse(view.at);
        // Greedy toward the pad, but only ever into a heading the console has
        // reported clear for THIS cell — the wall map is never available.
        const fresh = ['S', 'E', 'N', 'W'].filter((d) => {
          if (!view.clear.includes(d)) return false;
          const [dr, dc] = MAZE_HEADINGS[d];
          return !known.has(mazeRef(r + dr, c + dc));
        });
        const heading = fresh[0] ?? (trail.length ? MAZE_BACK[trail.pop()] : null);
        if (!heading) throw new Error(`stuck at ${view.at} with nothing left to explore`);
        if (fresh[0]) trail.push(heading);
        await mcp('click_by_uid', {
          uid: uidFor(
            view.snap,
            new RegExp(`uid=(\\S+) button "Drive ${MAZE_BUTTON[heading]}"`),
            `drive ${MAZE_BUTTON[heading]} control`
          ),
        });
        const [dr, dc] = MAZE_HEADINGS[heading];
        const want = mazeRef(r + dr, c + dc);
        view = await until(
          sleep,
          async () => {
            const next = await read();
            return next && next.at === want ? next : null;
          },
          `the rover never arrived at ${want} driving ${heading} from ${mazeRef(r, c)}`
        );
        known.set(view.at, view.clear);
      }
      if (view.at !== 'F6') throw new Error('the rover never reached the extraction pad');
      const done = await until(
        sleep,
        async () => {
          const next = await read();
          return next?.code ? next : null;
        },
        'the extraction code never appeared'
      );
      return (
        `The rover is parked on the extraction pad at F6, having surveyed ${known.size} of ` +
        `the 36 cells. The console shows extraction code ${done.code}.`
      );
    },
  },

  // --- three screens, each with an inverted control ---
  'unsub-dark-patterns': {
    note: 'takes only the quiet real exits and clears the pre-checked digest opt-in',
    wrong: 'The confirmation phrase shown at the end was KEEP-READING.',
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      const clickOn = async (re, label) => {
        const snap = await until(
          sleep,
          async () => {
            const s = await snapshot();
            return re.test(s) ? s : null;
          },
          `${label} never appeared`
        );
        await mcp('click_by_uid', { uid: uidFor(snap, re, label) });
      };
      await goto('/unsub/');
      // Screen 1: the loud pill keeps the subscription; the real exit is the
      // quiet link under it.
      await clickOn(/uid=(\S+) a "continue to unsubscribe"/, 'the continue-to-unsubscribe link');
      // Screen 2: "Pause for 60 days instead" is a stay control, and the dialog
      // Continue removal opens has another one on its Cancel.
      await clickOn(/uid=(\S+) button "Continue removal"/, 'the Continue removal button');
      await clickOn(/uid=(\S+) button "Yes, I'm sure"/, 'the dialog confirm button');
      // Screen 3: the digest opt-in is pre-checked, and finishing with it still
      // on re-subscribes the address instead of removing it. A checkbox reaches
      // the snapshot as a bare `input ... value="on"` with no checked/unchecked
      // state, so its state is only readable through evaluate.
      const checkboxes = () =>
        evaluate(() => [...document.querySelectorAll('input[type=checkbox]')].map((box) => ({
          checked: box.checked,
          label: (box.labels[0]?.textContent ?? '').trim().slice(0, 20),
        })));
      const preChecked = await until(
        sleep,
        async () => {
          const boxes = await checkboxes();
          const on = Array.isArray(boxes) ? boxes.filter((box) => box.checked) : [];
          return on.length === 1 ? on[0] : null;
        },
        'the pre-checked digest opt-in never rendered'
      );
      const step3 = await snapshot();
      await mcp('click_by_uid', {
        uid: uidFor(
          step3,
          new RegExp(`uid=(\\S+) input "${preChecked.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
          'the digest checkbox'
        ),
      });
      await until(
        sleep,
        async () => (await checkboxes()).every((box) => !box.checked),
        'the digest opt-in never cleared'
      );
      await clickOn(/uid=(\S+) button "Finish"/, 'the Finish button');
      const done = await until(
        sleep,
        async () => (await snapshot()).match(/ p text="(UNSUB-[0-9A-F]{4})"/),
        'no confirmation phrase was issued'
      );
      return (
        `The address is off every Tealwave mailing. I declined the keep-benefits pill, the ` +
        `60-day pause, the dialog's Cancel and the "never mind" link, and cleared the ` +
        `pre-checked Weekly Digest opt-in before finishing. The confirmation phrase is ${done[1]}.`
      );
    },
  },
};
