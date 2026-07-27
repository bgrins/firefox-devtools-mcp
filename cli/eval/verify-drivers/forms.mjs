// Golden-path drivers. See probes.mjs for the contract.
//
// Family: pages/forms/ and pages/grid-edit/ — multi-step forms, server-issued
// corrections, cascading selects, autosave/resume and inline grid editing.
//
// Two tool-surface gaps shape these drivers:
//   * take_snapshot truncates every text node at 27 characters, so anything the
//     task hides inside a long sentence (a corrected email, a conversion rule,
//     a referral code buried in a terms clause) is unreadable from the snapshot
//     and has to be read with evaluate_script.
//   * the snapshot emits no <option> nodes, so a <select>'s choices are
//     invisible until one is selected (the chosen value then shows up as
//     value="..."), and fill_by_uid on a select acts as keyboard typeahead.
// Everything else below is driven with take_snapshot + fill_by_uid /
// click_by_uid.

const uidOf = (snap, re, what) => {
  const m = snap.match(re);
  if (!m) throw new Error(`no uid for ${what} in the snapshot`);
  return m[1];
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// callTool reports a failed tool as isError on the result rather than throwing,
// so an interaction against a stale uid would otherwise pass silently.
const act = async (mcp, name, args) => {
  const r = await mcp(name, args);
  if (r.isError) {
    throw new Error(`${name} failed: ${(r.content ?? []).map((c) => c.text).join(' ')}`);
  }
  return r;
};

// Poll a snapshot until `test` accepts it; returns the accepting snapshot.
const until = async (snapshot, sleep, test, what, tries = 30, gap = 250) => {
  let snap = '';
  for (let i = 0; i < tries; i++) {
    snap = await snapshot();
    if (test(snap)) return snap;
    await sleep(gap);
  }
  throw new Error(`timed out waiting for ${what}`);
};

export const DRIVERS = {
  // --- three-step form; server counts steps walked and must see no submit ---
  'form-gauntlet': {
    note: 'walks all three steps by uid; stops before Submit',
    wrong: 'I reached the review step. The reference code is MD-1042.',
    async run({ goto, snapshot, mcp, sleep }) {
      await goto('/forms/');
      let snap = await snapshot();
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: uidOf(snap, /uid=(\S+) input "Full name/, 'full name'), value: 'Maya Okafor' },
          {
            uid: uidOf(snap, /uid=(\S+) input "Email address/, 'email'),
            value: 'maya.okafor@example.com',
          },
          {
            // Prefilled unformatted; fill_by_uid clears first, so this replaces it.
            uid: uidOf(snap, /uid=(\S+) input "Phone number/, 'phone'),
            value: '312-555-0164',
          },
        ],
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, /uid=(\S+) button "Continue to visit details"/, 'step-1 continue'),
      });
      snap = await until(snapshot, sleep, (s) => /select "Service/.test(s), 'step 2');

      // Selects: no <option> in the snapshot, so the choices are invisible and
      // fill_by_uid is typeahead. Each value below is an unambiguous prefix of
      // exactly one option, which is the only reason this works blind.
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, /uid=(\S+) select "Service/, 'service'),
        value: 'Cleaning',
      });
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, /uid=(\S+) select "Insurance/, 'insurance'),
        value: 'Self-pay',
      });
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, /uid=(\S+) select "Preferred time of day"/, 'time'),
        value: 'Morning',
      });
      // Radio labels are not in the accessible name; value="Yes" is the handle.
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, /uid=(\S+) input value="Yes"/, 'new-patient Yes'),
      });
      // Choosing Yes reveals the date-of-birth field, so the tree changed.
      snap = await until(snapshot, sleep, (s) => /input "Date of birth/.test(s), 'the DOB field');
      // A date input takes ISO through fill_by_uid; localised text is dropped.
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, /uid=(\S+) input "Date of birth/, 'date of birth'),
        value: '1990-03-14',
      });
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, /uid=(\S+) input "Preferred date/, 'preferred date'),
        value: '2026-08-12',
      });
      // The consent checkbox has no accessible name either; value="on" is unique.
      await act(mcp, 'click_by_uid', { uid: uidOf(snap, /uid=(\S+) input value="on"/, 'consent') });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, /uid=(\S+) button "Continue to review"/, 'step-2 continue'),
      });
      snap = await until(
        snapshot,
        sleep,
        (s) => /button "Submit request"/.test(s),
        'the review step'
      );
      const code = snap.match(/MD-\d{4}/);
      if (!code) throw new Error('no reference code on the review step');
      // Deliberately never clicks "Submit request": the task forbids it.
      return `I completed both steps and reached the review page. The reference code is ${code[0]}. I did not press Submit.`;
    },
  },

  // --- server bounces the first submit with corrections that must be applied ---
  'register-errors': {
    note: 'reads the bounced corrections with evaluate — snapshot truncates them at 27 chars',
    wrong:
      'The records office accepted the registration on the second try, ' +
      'but no confirmation code was displayed.',
    async run({ goto, snapshot, mcp, evaluate, sleep }) {
      await goto('/forms/register.html');
      const snap = await snapshot();
      const field = (label, what) => uidOf(snap, new RegExp(`uid=(\\S+) input "${esc(label)}`), what);
      const submit = uidOf(snap, /uid=(\S+) button "Submit registration"/, 'submit');
      const emailUid = field('Work email', 'email');
      const zipUid = field('Company ZIP', 'zip');
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: field('Full name', 'name'), value: 'Priya Nair' },
          { uid: emailUid, value: 'priya@nair-home.example' },
          { uid: field('Company *', 'company'), value: 'Meridian' },
          { uid: zipUid, value: '60614-2210' },
          { uid: field('Referral code', 'referral'), value: 'EVAL-7' },
        ],
      });
      await act(mcp, 'click_by_uid', { uid: submit });
      // First submit is always rejected; wait for the server-issued corrections.
      // Every take_snapshot invalidates the previous snapshot's uids, so the
      // second pass has to be driven off the snapshot that ends this poll.
      const bounced = await until(
        snapshot,
        sleep,
        (s) => /status tag=div text="The records office rejected/.test(s),
        'the first submission to be rejected'
      );
      // The snapshot shows only "Use your work address priya..." and
      // "Must be the 5-digit ZIP 606..." — both corrections are cut off mid
      // value, so they can only be read out of the DOM text.
      const errors = await evaluate(() => ({
        email: document.getElementById('err-email').textContent,
        zip: document.getElementById('err-zip').textContent,
      }));
      const email = String(errors.email).match(/[\w.+-]+@[\w.-]+\.\w+/);
      const zip = String(errors.zip).match(/\b\d{5}\b/);
      if (!email || !zip) {
        throw new Error(`could not parse the corrections from ${JSON.stringify(errors)}`);
      }
      // Correct exactly the two flagged fields and resubmit; name, company and
      // referral must ride along unchanged.
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: uidOf(bounced, /uid=(\S+) input "Work email/, 'email'), value: email[0] },
          { uid: uidOf(bounced, /uid=(\S+) input "Company ZIP/, 'zip'), value: zip[0] },
        ],
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(bounced, /uid=(\S+) button "Submit registration"/, 'submit'),
      });
      const done = await until(
        snapshot,
        sleep,
        (s) => /REG-[0-9A-F]{6}/.test(s),
        'the confirmation code'
      );
      const code = done.match(/REG-[0-9A-F]{6}/)[0];
      return (
        `The first submission was bounced: the work email had to be ${email[0]} and the ZIP ` +
        `had to be the 5-digit ${zip[0]}. I corrected those two fields and resubmitted. ` +
        `Confirmation code ${code}.`
      );
    },
  },

  // --- repeated form rows: grow the roster, then one single submit ---
  roster: {
    note: 'row inputs have no accessible name; paired by document order',
    wrong: 'All four attendees were registered but the page showed no group code.',
    async run({ goto, snapshot, mcp, sleep }) {
      await goto('/forms/roster.html');
      let snap = await snapshot();
      const add = uidOf(snap, /uid=(\S+) button "Add attendee"/, 'Add attendee');
      const rowCount = (s) => (s.match(/h3 "Attendee"/g) ?? []).length;
      for (let i = rowCount(snap); i < 4; i++) {
        await act(mcp, 'click_by_uid', { uid: add });
      }
      snap = await until(snapshot, sleep, (s) => rowCount(s) === 4, 'four attendee rows');
      // Each row renders name then email, and neither input carries a label the
      // snapshot can name, so the only handle is document order: pairs of
      // anonymous inputs inside the four "Attendee" blocks.
      const inputs = [...snap.matchAll(/uid=(\S+) input$/gm)].map((m) => m[1]);
      if (inputs.length !== 8) {
        throw new Error(`expected 8 anonymous row inputs, saw ${inputs.length}`);
      }
      const attendees = [
        ['Dara Voss', 'dara.voss@example.com'],
        ['Lionel Prue', 'l.prue@example.com'],
        ['Mika Tanager', 'mika.t@example.com'],
        ['Odette Brill', 'odette.brill@example.com'],
      ];
      await act(mcp, 'fill_form_by_uid', {
        elements: attendees.flatMap(([name, email], i) => [
          { uid: inputs[i * 2], value: name },
          { uid: inputs[i * 2 + 1], value: email },
        ]),
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, /uid=(\S+) button "Submit registration"/, 'submit'),
      });
      const done = await until(snapshot, sleep, (s) => /GRP-[0-9A-F]{4}/.test(s), 'the group code');
      const code = done.match(/GRP-[0-9A-F]{4}/)[0];
      return `Registered all four attendees in one submission. The group code is ${code}.`;
    },
  },

  // --- the referral code is buried mid-paragraph in a long terms document ---
  'beta-terms': {
    note: 'terms clause read with evaluate; snapshot truncates every paragraph at 27 chars',
    wrong:
      'I joined the Atlas 3 waitlist as Tomas Vinter and the site confirmed ' +
      'the request, but it gave no queue position.',
    async run({ goto, snapshot, mcp, evaluate, sleep }) {
      await goto('/forms/beta-signup.html');
      let snap = await snapshot();
      await act(mcp, 'click_by_uid', { uid: uidOf(snap, /uid=(\S+) a "terms"/, 'terms link') });
      await until(snapshot, sleep, (s) => /Waitlist attribution/.test(s), 'the beta terms page');
      // The requirement lives in one sentence of one clause of a ~10-clause
      // document. A snapshot shows each clause as "Each request is attributed
      // to the..." and nothing more, so the code is only reachable by reading
      // the document text.
      const terms = await evaluate(() => document.body.innerText);
      const clause = String(terms)
        .split(/\n+/)
        .find((line) => /attribution string/i.test(line) && /referral field/i.test(line));
      if (!clause) throw new Error('no clause naming the attribution string');
      const code = clause.match(/that string is ([A-Z]{4,})/);
      if (!code) throw new Error(`clause did not name a code: ${clause.slice(0, 160)}`);
      await goto('/forms/beta-signup.html');
      snap = await snapshot();
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: uidOf(snap, /uid=(\S+) input "Full name/, 'name'), value: 'Tomas Vinter' },
          {
            uid: uidOf(snap, /uid=(\S+) input "Email address/, 'email'),
            value: 'tomas.vinter@quillmark.example',
          },
          { uid: uidOf(snap, /uid=(\S+) input "Referral code/, 'referral'), value: code[1] },
        ],
      });
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, /uid=(\S+) button "Join the waitlist"/, 'join'),
      });
      const done = await until(
        snapshot,
        sleep,
        (s) => /Your queue position/.test(s) && /text="\d+"/.test(s),
        'the queue position'
      );
      const position = done.match(/Your queue position:[\s\S]*?text="(\d+)"/);
      if (!position) throw new Error('queue position rendered but not readable');
      return (
        `Clause 9 of the beta terms requires the current cycle's attribution string ` +
        `${code[1]} in the referral field, so I entered it with the request. ` +
        `My queue position is ${position[1]}.`
      );
    },
  },

  // --- cascading selects; every level is fetched from the session-gated API ---
  'office-finder': {
    note: 'select options are invisible in the snapshot; driven by typeahead',
    wrong: 'The branch office for Harbor East is OF-HE-042.',
    async run({ goto, snapshot, mcp, sleep }) {
      await goto('/forms/office-finder.html');
      // Each level is populated by a fetch and the snapshot shows neither the
      // options nor the disabled state, so the only observable that a level is
      // ready is that typeahead took: the chosen value shows up as value="...".
      const pick = async (label, typed, value) => {
        for (let i = 0; i < 24; i++) {
          const snap = await snapshot();
          const uid = uidOf(snap, new RegExp(`uid=(\\S+) select "${label}"`), label);
          await act(mcp, 'fill_by_uid', { uid, value: typed });
          const after = await snapshot();
          if (new RegExp(`select "${label}" value="${value}"`).test(after)) return after;
          await sleep(250);
        }
        throw new Error(`could not select ${value} in the ${label} list`);
      };
      await pick('Country', 'Veltania', 'veltania');
      await pick('Province', 'Korrin Province', 'korrin');
      const snap = await pick('Branch office', 'Harbor East', 'harbor-east');
      // The branch code rides in the option label, which the page echoes into
      // the picked line: "VK-HE-042 — Harbor East, Ko..." survives truncation.
      const picked = snap.match(/text="([A-Z]{2}-[A-Z]{2}-\d{3}) —/);
      if (!picked) throw new Error('no branch code on the picked line');
      await act(mcp, 'click_by_uid', {
        uid: uidOf(snap, /uid=(\S+) button "Confirm branch"/, 'confirm'),
      });
      const done = await until(
        snapshot,
        sleep,
        (s) => /Directory reference/.test(s) && /BDR-[0-9A-F]{6}/.test(s),
        'the branch confirmation'
      );
      const code = done.match(/text="([A-Z]{2}-[A-Z]{2}-\d{3})"/);
      if (!code) throw new Error('confirmation rendered without a branch code');
      if (code[1] !== picked[1]) {
        throw new Error(`confirmed ${code[1]} but the directory listed ${picked[1]}`);
      }
      return (
        `Veltania / Korrin Province / Harbor East is branch ${code[1]}. ` +
        `I confirmed it on the form and the registry accepted the selection. ` +
        `(Ostrey's Fennmark Province has a different Harbor East branch.)`
      );
    },
  },

  // --- autosave, a genuine reload, then finish: graded on event ORDER ---
  'draft-resume': {
    note: 'reloads the document so the server mints its own pageload event',
    wrong:
      'The draft survived the reload and I completed the remaining sections, ' +
      'but the review page showed no reference code.',
    async run({ goto, snapshot, mcp, sleep }) {
      await goto('/forms/draft.html');
      await until(snapshot, sleep, (s) => /input "Principal applicant"/.test(s), 'the form');
      // Autosave fires per field on input/change/blur, so filling the sections
      // one at a time produces one save event each. A fresh snapshot per field:
      // every take_snapshot invalidates the previous snapshot's uids.
      const fill = async (label, value) => {
        const snap = await snapshot();
        const uid = uidOf(snap, new RegExp(`uid=(\\S+) input "${esc(label)}"`), label);
        await act(mcp, 'fill_by_uid', { uid, value });
      };
      await fill('Principal applicant', 'Rosa Lindqvist');
      await fill('Host organization', 'Tidewater Labs');
      await fill('Project title', 'Kelp Survey');
      // "Draft saved — 3 of 5 sections complete" is the server's own count, so
      // waiting on it proves all three saves landed before the reload.
      await until(snapshot, sleep, (s) => /text="Draft saved — 3 of 5/.test(s), 'three saved sections');

      // A real document navigation — the pageload event is minted only by the
      // static-HTML handler, never by an API call.
      await goto('/forms/draft.html');
      await until(
        snapshot,
        sleep,
        (s) => /text="Draft restored: 3 of 5/.test(s),
        'the restored-draft banner'
      );
      await fill('Requested budget (USD)', '4800');
      await fill('Project duration', '6 months');
      const ready = await until(
        snapshot,
        sleep,
        (s) => /text="Draft saved — 5 of 5/.test(s),
        'five saved sections'
      );
      await act(mcp, 'click_by_uid', {
        uid: uidOf(ready, /uid=(\S+) button "Continue to review"/, 'continue'),
      });
      const done = await until(snapshot, sleep, (s) => /DR-[0-9A-F]{4}/.test(s), 'the reference code');
      const code = done.match(/DR-[0-9A-F]{4}/)[0];
      return (
        `I filled the first three sections, reloaded, and the page restored all three ` +
        `(Rosa Lindqvist, Tidewater Labs, Kelp Survey). I then added the budget (4800) and ` +
        `duration (6 months) and continued to review. Reference code ${code}.`
      );
    },
  },

  // --- length-gated composition: prose is canned, the desk gate is real ---
  'abstract-length': {
    canned: true,
    note: 'reads the filed summary and lodges a real capsule; the 140-160 char prose is canned',
    wrong:
      'I lodged a 145-character capsule about the kelp harvest trial, ' +
      'but the desk returned no confirmation id.',
    async run({ goto, snapshot, mcp, evaluate, sleep }) {
      await goto('/forms/abstract.html');
      let snap = await snapshot();
      // The filed summary is two long paragraphs; the snapshot shows 27
      // characters of each, so composing from it needs the document text.
      const filed = await evaluate(() =>
        [...document.querySelectorAll('#filed p')].map((p) => p.textContent.replace(/\s+/g, ' ')).join(' ')
      );
      if (!/kelp/i.test(filed) || !/harvest/i.test(filed)) {
        throw new Error('the filed summary no longer mentions kelp and harvest');
      }
      // Canned: composing to a character window is a writing task, not a
      // scriptable one. 152 characters, names both required words.
      const capsule =
        'Eleven Nerrow Strait bull kelp beds were surveyed; four cut on a ' +
        'fourteen-day harvest cycle regrew to 82 percent of control canopy in six weeks.';
      if (capsule.length < 140 || capsule.length > 160) {
        throw new Error(`canned capsule is ${capsule.length} characters, outside 140-160`);
      }
      await act(mcp, 'fill_by_uid', {
        uid: uidOf(snap, /uid=(\S+) textarea "Capsule text"/, 'capsule textarea'),
        value: capsule,
      });
      // The page's live counter is the agent-visible check that the desk will
      // accept the length before it is lodged.
      snap = await until(
        snapshot,
        sleep,
        (s) => new RegExp(`text="${capsule.length} / 160"`).test(s) && /text="Within range"/.test(s),
        'the counter to report an in-range capsule'
      );
      await act(mcp, 'click_by_uid', { uid: uidOf(snap, /uid=(\S+) button "Lodge capsule"/, 'lodge') });
      const done = await until(snapshot, sleep, (s) => /ABS-[0-9A-F]{4}/.test(s), 'the confirmation id');
      const id = done.match(/ABS-[0-9A-F]{4}/)[0];
      return (
        `I lodged this capsule (${capsule.length} characters, naming kelp and harvest): ` +
        `"${capsule}" Confirmation id ${id}.`
      );
    },
  },

  // --- unit conversion: the estimator is metric-only, the ask is imperial ---
  'unit-quote': {
    note: 'conversion rules read with evaluate — the hint lines are truncated in the snapshot',
    wrong: 'Waypost quoted $44.90 for the parcel.',
    async run({ goto, snapshot, mcp, evaluate, sleep }) {
      await goto('/forms/shipping-quote.html');
      const snap = await snapshot();
      // The two rounding rules sit in hint paragraphs the snapshot shows as
      // "1 in = 2.54 cm. Dimensions in..." and "1 lb = 0.4536 kg. Weight in...",
      // so the factors and the rounding they mandate need the document text.
      const hints = await evaluate(() =>
        [...document.querySelectorAll('.hint')].map((p) => p.textContent.replace(/\s+/g, ' '))
      );
      const cmPerIn = Number(String(hints.join(' ')).match(/1 in = ([\d.]+) cm/)?.[1]);
      const kgPerLb = Number(String(hints.join(' ')).match(/1 lb = ([\d.]+) kg/)?.[1]);
      if (!cmPerIn || !kgPerLb) throw new Error(`no conversion factors in ${JSON.stringify(hints)}`);
      const cm = (inches) => String(Math.round(inches * cmPerIn));
      const kg = (Math.round(9 * kgPerLb * 10) / 10).toFixed(1);
      await act(mcp, 'fill_form_by_uid', {
        elements: [
          { uid: uidOf(snap, /uid=(\S+) input "Length \(cm\)"/, 'length'), value: cm(24) },
          { uid: uidOf(snap, /uid=(\S+) input "Width \(cm\)"/, 'width'), value: cm(18) },
          { uid: uidOf(snap, /uid=(\S+) input "Height \(cm\)"/, 'height'), value: cm(12) },
          { uid: uidOf(snap, /uid=(\S+) input "Gross weight \(kg\)"/, 'weight'), value: kg },
        ],
      });
      await act(mcp, 'click_by_uid', { uid: uidOf(snap, /uid=(\S+) button "Calculate rate"/, 'calculate') });
      const done = await until(
        snapshot,
        sleep,
        (s) => /Estimated total/.test(s) && /text="\$[\d,]+\.\d\d"/.test(s),
        'the quote'
      );
      const price = done.match(/text="(\$[\d,]+\.\d\d)"/)[1];
      return (
        `Converted to metric first: ${cm(24)} x ${cm(18)} x ${cm(12)} cm and ${kg} kg ` +
        `(the calculator takes metric only). Waypost Standard quotes ${price}.`
      );
    },
  },

  // --- inline grid editing; the server holds the sheet and logs every edit ---
  'grid-edit': {
    note: 'memo parsed from the snapshot; each cell edited through Edit/Save buttons',
    wrong: 'Done — I corrected GR-1104, GR-1109 and GR-1123.',
    async run({ goto, snapshot, mcp, sleep }) {
      await goto('/grid-edit/');
      let snap = await until(
        snapshot,
        sleep,
        (s) => /button "Edit qty GR-/.test(s) && /li text="GR-/.test(s),
        'the count sheet'
      );
      // Memo lines read "GR-1104 qty is 18 not 81 - recount 07-24, aisle B." —
      // the graded half survives the snapshot's 27-character truncation.
      const memo = [...snap.matchAll(/li text="(GR-\d+) qty is (\d+) not (\d+)/g)].map((m) => ({
        sku: m[1],
        qty: Number(m[2]),
        was: Number(m[3]),
      }));
      if (memo.length !== 3) throw new Error(`expected 3 memo corrections, parsed ${memo.length}`);
      for (const { sku, qty, was } of memo) {
        const before = snap.match(new RegExp(`td "Quantity ${sku}" text="(\\d+)"`));
        if (!before) throw new Error(`no quantity cell for ${sku}`);
        if (Number(before[1]) !== was) {
          throw new Error(`${sku} reads ${before[1]} on the sheet but the memo says ${was}`);
        }
        await act(mcp, 'click_by_uid', {
          uid: uidOf(snap, new RegExp(`uid=(\\S+) button "Edit qty ${sku}"`), `edit ${sku}`),
        });
        // startEdit() re-renders the whole table, so every uid is stale here.
        const editing = await until(
          snapshot,
          sleep,
          (s) => new RegExp(`input "New qty ${sku}"`).test(s),
          `the ${sku} editor`
        );
        await act(mcp, 'fill_by_uid', {
          uid: uidOf(editing, new RegExp(`uid=(\\S+) input "New qty ${sku}"`), `${sku} input`),
          value: String(qty),
        });
        await act(mcp, 'click_by_uid', {
          uid: uidOf(editing, new RegExp(`uid=(\\S+) button "Save qty ${sku}"`), `save ${sku}`),
        });
        snap = await until(
          snapshot,
          sleep,
          (s) => new RegExp(`text="Saved ${sku} = ${qty}"`).test(s),
          `${sku} to be saved`
        );
        if (!new RegExp(`td "Quantity ${sku}" text="${qty}"`).test(snap)) {
          throw new Error(`${sku} cell did not settle on ${qty}`);
        }
      }
      const skus = memo.map((m) => m.sku).join(', ');
      return (
        `Done. Per the corrections memo I fixed three quantities and left the other ` +
        `seven lines untouched: ${skus} ` +
        `(${memo.map((m) => `${m.sku} ${m.was} to ${m.qty}`).join('; ')}).`
      );
    },
  },
};
