// Golden path for the Kettleforge pull-request review (T110).
//
// Honest note on the escape hatch: this driver reads the failing job's log and
// the diff with evaluate_script because our snapshot cannot show either. The
// diff is a real table, so every td/tr is dropped and the code text survives
// only as bubbled-up spans trimmed to 27 characters, which loses the at-fault
// identifier in all four seeded variants. The +/- marker column and the row
// grouping are gone as well, and a line number survives only inside a gutter
// button's accessible name ("Comment on new line N") — never paired with its
// code, which is why the driver has to learn the number from the DOM first and
// only then look the button up in the snapshot.
// Everything else (navigating the tab strip, addressing ONE gutter button among
// 153, filling the composer, choosing the verdict, submitting) runs through the
// tool surface, which is where the interesting half of the task lives.

// The buggy form of each seeded defect site. Exactly one of these is present in
// any one session; an agent finds it by reading the diff against the assertion
// on the Checks tab, which is the judgment this driver stands in for.
const SIGNATURES = [
  [/if \(now - entry\.storedAt > this\.softTtlMs\) \{/, 'softTtlMs', /hard TTL/i],
  [/return \[KEY_PREFIX, laneId, window\.start\]\.join\(':'\);/, 'tariffClass', /STD and EXP/i],
  [/Math\.floor\(epochSeconds \/ WINDOW_MINUTES\) \* WINDOW_MINUTES;/, 'WINDOW_MINUTES', /boundaries 900 seconds apart/i],
  [/total: round2\(units \* rate\.perTonne\),/, 'perTonne', /per-unit rate/i],
];

const uidFor = (snap, pattern) => snap.match(pattern)?.[1] ?? null;

async function pollFor(fn, { tries = 30, wait = 200, what = 'condition' }, sleep) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(wait);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const DRIVERS = {
  'pr-review': {
    note: 'diff and CI log read with evaluate_script; no snapshot-only path exists',
    wrong:
      'The failing check is caused by the new round2 helper, which rounds the ' +
      'total before the levy is applied. I approved the pull request.',
    async run({ goto, evaluate, mcp, sleep }) {
      const snap = async (maxLines = 500) => {
        const r = await mcp('take_snapshot', { maxLines });
        return (r.content ?? []).map((c) => c.text).join('\n');
      };

      await goto('/forge/pulls/482/');
      // Reach the Checks tab through the tab strip rather than by URL.
      const prSnap = await snap(200);
      const checksUid = uidFor(prSnap, /uid=(\S+) a "Checks"/);
      if (!checksUid) throw new Error('no Checks tab link in the snapshot');
      await mcp('click_by_uid', { uid: checksUid });

      const log = await pollFor(
        async () => {
          const text = await evaluate(
            () => document.getElementById('joblog')?.innerText ?? ''
          );
          return String(text).includes('AssertionError') ? String(text) : null;
        },
        { what: 'the failing job log' },
        sleep
      );

      const filesSnap = await snap(200);
      const filesUid = uidFor(filesSnap, /uid=(\S+) a "Files changed"/);
      if (!filesUid) throw new Error('no Files changed tab link in the snapshot');
      await mcp('click_by_uid', { uid: filesUid });

      const rows = await pollFor(
        async () => {
          const got = await evaluate(() =>
            [...document.querySelectorAll('table.diff tr.add')].map((tr) => ({
              file: tr.closest('.filebox')?.querySelector('.path')?.textContent ?? '',
              line: Number(tr.querySelector('td.gut.new button')?.dataset.line ?? 0),
              text: tr.querySelector('td.code .ln')?.textContent ?? '',
            }))
          );
          return Array.isArray(got) && got.length > 100 ? got : null;
        },
        { what: 'the rendered diff' },
        sleep
      );

      const hits = [];
      for (const row of rows) {
        for (const [signature, identifier, symptom] of SIGNATURES) {
          if (signature.test(row.text)) hits.push({ ...row, identifier, symptom });
        }
      }
      if (hits.length !== 1) {
        throw new Error(`expected exactly one seeded defect in the diff, saw ${hits.length}`);
      }
      const defect = hits[0];
      // The Checks tab must describe the same defect, or the fixture's two halves
      // have drifted apart and the task would be unsolvable by reasoning.
      if (!defect.symptom.test(log)) {
        throw new Error(
          `the failing job log does not describe the seeded defect (${defect.identifier})`
        );
      }

      // Address ONE line among 153 comment buttons. The accessible names are
      // ambiguous across files (three "Comment on new line 10" buttons on this
      // page), so each candidate has to be resolved back to a selector.
      const diffSnap = await snap(500);
      const label = new RegExp(`uid=(\\S+) button "Comment on new line ${defect.line}"`, 'g');
      const candidates = [...diffSnap.matchAll(label)].map((m) => m[1]);
      if (!candidates.length) {
        throw new Error(`no gutter button for line ${defect.line} in the snapshot`);
      }
      const wantSelector = '#c-' + defect.file.split('/').pop().replace(/\.[a-z]+$/, '') + '-' + defect.line;
      let target = null;
      for (const uid of candidates) {
        const r = await mcp('resolve_uid_to_selector', { uid });
        const sel = (r.content ?? []).map((c) => c.text).join(' ');
        if (sel.includes(wantSelector)) target = uid;
      }
      if (!target) {
        throw new Error(
          `none of ${candidates.length} line-${defect.line} buttons resolved to ${wantSelector}`
        );
      }
      await mcp('click_by_uid', { uid: target });

      const composer = await pollFor(
        async () => {
          const s = await snap(500);
          return s.includes(`textarea "Comment on line ${defect.line}"`) ? s : null;
        },
        { what: 'the line comment composer' },
        sleep
      );
      const areaUid = uidFor(
        composer,
        new RegExp(`uid=(\\S+) textarea "Comment on line ${defect.line}"`)
      );
      const addUid = uidFor(composer, /uid=(\S+) button "Add review comment"/);
      if (!areaUid || !addUid) throw new Error('composer textarea or button missing');
      const body =
        `${defect.identifier} is wrong here: this line should use the seconds/per-unit ` +
        `form, and the failing assertion is exactly this substitution.`;
      await mcp('fill_by_uid', { uid: areaUid, value: body });
      await mcp('click_by_uid', { uid: addUid });

      const staged = await pollFor(
        async () => {
          const s = await snap(500);
          return s.includes('line comment(s) staged') ? s : null;
        },
        { what: 'the staged comment' },
        sleep
      );
      const radioUid = uidFor(staged, /uid=(\S+) input "Request changes"/);
      const summaryUid = uidFor(staged, /uid=(\S+) textarea "Review summary"/);
      const submitUid = uidFor(staged, /uid=(\S+) button "Submit review"/);
      if (!radioUid || !summaryUid || !submitUid) {
        throw new Error('review verdict controls missing from the snapshot');
      }
      await mcp('click_by_uid', { uid: radioUid });
      await mcp('fill_by_uid', {
        uid: summaryUid,
        value: `One blocking issue: ${defect.identifier} on line ${defect.line}.`,
      });
      await mcp('click_by_uid', { uid: submitUid });

      const result = await pollFor(
        async () => {
          const text = await evaluate(
            () => document.getElementById('result')?.textContent ?? ''
          );
          return /RV-[0-9A-F]{4}/.test(String(text)) ? String(text) : null;
        },
        { what: 'the submitted review receipt' },
        sleep
      );

      return (
        `The failing job is caused by ${defect.file} line ${defect.line}, where the new ` +
        `code uses ${defect.identifier}. I left a review comment on that exact line and ` +
        `submitted the review requesting changes (${result}).`
      );
    },
  },
};
