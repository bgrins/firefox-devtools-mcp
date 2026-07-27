// Golden-path drivers for the consent-wall fixtures. See probes.mjs for the contract.

const uidFor = (snap, re) => {
  for (const line of snap.split('\n')) {
    if (!re.test(line)) continue;
    const m = line.match(/uid=(\S+)/);
    if (m) return m[1];
  }
  return null;
};

const textIn = (snap, re) => snap.match(re)?.[1] ?? null;

// A stream entry snapshots as `span text="<rank>"` followed by the headline
// link, so the answer can be read off the same surface an agent has.
const headlineForSlot = (snap, slot) => {
  const lines = snap.split('\n');
  const at = lines.findIndex((line) => new RegExp(`span text="${slot}"\\s*$`).test(line));
  if (at < 0) return null;
  for (const line of lines.slice(at + 1, at + 4)) {
    const m = line.match(/\ba "(.+?)" href=/);
    if (m) return m[1];
  }
  return null;
};

async function poll(sleep, fn, { tries = 40, delay = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(delay);
  }
  return null;
}

export const DRIVERS = {
  // --- 3-layer cookie consent: every non-essential toggle must end up off ---
  'consent-reject': {
    note:
      'clicks all 11 pre-enabled toggles off by uid across three CMP layers, ' +
      'then Save my choices; reads every graded/reported fact (the three "N of M ' +
      'enabled" counters, "Optional on: N" and the #2 headline) out of the ' +
      'default snapshot, since aria-checked needs includeAttributes and a ' +
      'checkbox snapshots as value="on" either way',
    wrong:
      'I rejected every non-essential cookie and saved. The #2 headline is ' +
      '"The forgotten history of the trackball".',
    async run({ goto, snapshot, mcp, sleep }) {
      await goto('/news/consent.html');

      const manage = await poll(sleep, async () =>
        uidFor(await snapshot(), /button "Manage options"/)
      );
      if (!manage) throw new Error('the consent dialog never offered "Manage options"');
      await mcp('click_by_uid', { uid: manage });

      const opened = await poll(sleep, async () =>
        uidFor(await snapshot(), /switch "Basic ads"/)
      );
      if (!opened) throw new Error('the manage layer never rendered its purpose switches');

      // The trap only exists if every optional toggle really starts enabled, and
      // the counters that say so have to be legible from a plain snapshot.
      const before = textIn(await snapshot(), /span text="Optional on: (\d+)"/);
      if (before !== '11') {
        throw new Error(`expected 11 pre-enabled optional toggles, counter read "${before}"`);
      }

      // Layer 2, consent purposes: six switches, each clicked off individually.
      const purposes = [
        'Basic ads',
        'Personalised ads',
        'Personalised content',
        'Audience measurement',
        'Content measurement',
        'Develop new services',
      ];
      for (const name of purposes) {
        const snap = await snapshot();
        // Match only switches still reading "On" so a re-click cannot turn one
        // back on if a previous click already landed.
        const uid = uidFor(snap, new RegExp(`switch "${name}" tag=button text="On"`));
        if (!uid) {
          const off = uidFor(snap, new RegExp(`switch "${name}" tag=button text="Off"`));
          if (off) continue;
          throw new Error(`no switch named "${name}" in the manage layer`);
        }
        await mcp('click_by_uid', { uid });
      }

      // Layer 2, collapsed legitimate-interest section: the rows are not in the
      // page until the disclosure is opened (they come from /api/consent/tier),
      // and their checked state never reaches the snapshot at all (every
      // checkbox reports value="on"), so the "N of 3 enabled" counter is the
      // only tell.
      const disc = uidFor(await snapshot(), /button "Legitimate interest \(3\)"/);
      if (!disc) throw new Error('no legitimate-interest disclosure in the manage layer');
      await mcp('click_by_uid', { uid: disc });
      const liUp = await poll(sleep, async () =>
        uidFor(await snapshot(), /input "Link different devices"/)
      );
      if (!liUp) throw new Error('the legitimate-interest section never expanded');
      for (const name of ['Link different devices', 'Match and combine data', 'Improve our products']) {
        const uid = uidFor(await snapshot(), new RegExp(`input "${name}"`));
        if (!uid) throw new Error(`no legitimate-interest checkbox named "${name}"`);
        await mcp('click_by_uid', { uid });
      }
      let liCount = null;
      const liOff = await poll(sleep, async () => {
        liCount = textIn(await snapshot(), /p text="(\d+) of 3 enabled"/);
        return liCount === '0' ? liCount : null;
      });
      if (!liOff) {
        throw new Error(`legitimate interest still enabled: counter read "${liCount} of 3"`);
      }

      // Layer 3, vendor preferences: two more pre-enabled switches, also served
      // only once the vendor door is opened.
      const toVendors = uidFor(await snapshot(), /button "Vendor preferences \(2\)"/);
      if (!toVendors) throw new Error('no vendor-preferences control in the manage layer');
      await mcp('click_by_uid', { uid: toVendors });
      const vendorsUp = await poll(sleep, async () =>
        uidFor(await snapshot(), /switch "Larkfield Media"/)
      );
      if (!vendorsUp) throw new Error('the vendor layer never rendered');
      for (const name of ['Larkfield Media', 'Cindersmith Analytics']) {
        const snap = await snapshot();
        const uid = uidFor(snap, new RegExp(`switch "${name}" tag=button text="On"`));
        if (!uid) {
          if (uidFor(snap, new RegExp(`switch "${name}" tag=button text="Off"`))) continue;
          throw new Error(`no vendor switch named "${name}"`);
        }
        await mcp('click_by_uid', { uid });
      }
      const back = uidFor(await snapshot(), /button "Back to purposes"/);
      if (!back) throw new Error('no way back from the vendor layer');
      await mcp('click_by_uid', { uid: back });

      let optionalOn = null;
      const cleared = await poll(sleep, async () => {
        optionalOn = textIn(await snapshot(), /span text="Optional on: (\d+)"/);
        return optionalOn === '0' ? optionalOn : null;
      });
      if (!cleared) {
        throw new Error(`some optional toggle is still on before saving: ${optionalOn} left`);
      }

      const save = uidFor(await snapshot(), /button "Save my choices"/);
      if (!save) throw new Error('no "Save my choices" control in the manage layer');
      await mcp('click_by_uid', { uid: save });

      let final = '';
      const headline = await poll(sleep, async () => {
        final = await snapshot();
        return headlineForSlot(final, 2);
      });
      if (!headline) throw new Error('the stream never rendered after saving the choices');
      if (!/text="Optional cookies declined\./.test(final)) {
        throw new Error('the page did not confirm a decline after the save');
      }
      return (
        `I refused every non-essential cookie: all six consent purposes, the three ` +
        `pre-enabled legitimate-interest entries in the collapsed section and both ` +
        `vendor switches are off, saved with "Save my choices" rather than "Accept all". ` +
        `The #2 headline on the stream is "${headline}".`
      );
    },
  },
};
