// T118 locale-notice: pages/intl/ — the Qandara Travel Advisory Authority's three
// language editions. The supplementary notice for Port Vasiri was only ever
// published in the Arabic and Japanese editions, so the golden path has to leave
// the English page, switch edition through the site's own editions menu, and read
// a reference out of RTL Arabic body copy.

const localeNotice = {
  note: 'switches to the Arabic edition and reads the notice reference',
  wrong: 'The advisory reference for Port Vasiri is QTA-2026-0000.',
  async run({ goto, mcp, snapshot, sleep }) {
    // The link on the destination list carries no text of its own: the name and
    // the level sit in child spans, so resolve the anchor above the matching span.
    const anchorAbove = (snap, label) => {
      const lines = snap.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(`text="${label}"`)) continue;
        for (let j = i; j >= 0; j--) {
          const m = lines[j].match(/uid=(\S+) a\b/);
          if (m) return m[1];
        }
      }
      return null;
    };
    // Substring rather than an exact accessible name: our snapshot currently drops
    // the `<em>` update date out of each edition link, and the day it stops doing
    // that the name becomes `العربية آخر تحديث 24 يوليو 2026`. The driver should
    // survive that improvement.
    const linkContaining = (snap, label) => {
      for (const line of snap.split('\n')) {
        if (!line.includes(label)) continue;
        const m = line.match(/uid=(\S+) a\b/);
        if (m) return m[1];
      }
      return null;
    };
    const untilSnapshot = async (test, what) => {
      for (let i = 0; i < 25; i++) {
        const snap = await snapshot();
        if (test(snap)) return snap;
        await sleep(200);
      }
      throw new Error(`timed out waiting for ${what}`);
    };

    await goto('/intl/');
    const home = await untilSnapshot((s) => s.includes('Port Vasiri'), 'the destination list');
    const destUid = anchorAbove(home, 'Port Vasiri');
    if (!destUid) throw new Error('no Port Vasiri link in the destination list');
    await mcp('click_by_uid', { uid: destUid });

    const english = await untilSnapshot(
      (s) => /No supplementary notices/.test(s),
      'the English advisory page'
    );
    if (/QTA-2026-/.test(english)) {
      throw new Error('the English edition leaked an advisory reference');
    }

    // The editions menu is the only affordance that says other editions exist.
    const arUid = linkContaining(english, 'العربية');
    if (!arUid) throw new Error('no Arabic edition link in the editions menu');
    await mcp('click_by_uid', { uid: arUid });

    const arabic = await untilSnapshot(
      (s) => /المرجع: QTA-2026-[0-9A-F]{4}/.test(s),
      'the Arabic edition notice'
    );
    const reference = arabic.match(/QTA-2026-[0-9A-F]{4}/)[0];

    // Both translated editions must carry the same reference for the same notice;
    // assert it rather than assume it, so a divergence shows up here. Reached by
    // clicking the editions menu again rather than by a hand-built URL, so the
    // Japanese link is proven resolvable on our surface too.
    const jaUid = linkContaining(arabic, '日本語');
    if (!jaUid) throw new Error('no Japanese edition link in the editions menu');
    await mcp('click_by_uid', { uid: jaUid });
    const japanese = await untilSnapshot(
      (s) => /参照番号: QTA-2026-[0-9A-F]{4}/.test(s),
      'the Japanese edition notice'
    );
    const jaReference = japanese.match(/QTA-2026-[0-9A-F]{4}/)[0];
    if (jaReference !== reference) {
      throw new Error(`editions disagree: ar=${reference} ja=${jaReference}`);
    }

    // A wrong answer of exactly the right shape, guaranteed distinct from the
    // reference this session was actually issued.
    localeNotice.wrong =
      'The advisory reference for Port Vasiri is ' +
      reference.replace(/[0-9A-F]$/, (c) => (c === '0' ? '1' : '0')) +
      '.';

    return [
      `The English edition of the Qandara Travel Advisory Authority site carries no`,
      `supplementary notices for Port Vasiri, but the Arabic and Japanese editions both do.`,
      `Advisory reference ${reference}, issued 24 July 2026: the north quay is closed to`,
      `passengers for dredging until 14 August 2026, arrivals by sea must obtain an entry`,
      `permit from the harbour office at least 72 hours before arrival (arrivals by air are`,
      `not affected), and the Port Vasiri to Ashkar Coast ferry is suspended until further`,
      `notice. The standing advisory level is unchanged at Level 2.`,
    ].join(' ');
  },
};

export const DRIVERS = { 'locale-notice': localeNotice };
