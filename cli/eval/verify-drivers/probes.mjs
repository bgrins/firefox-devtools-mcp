// Golden paths, one per task, for eval/verify.mjs. Each driver performs the real
// interaction through our own MCP server and returns the answer text a correct
// agent would produce.
//
// Shape:
//   '<task id>': {
//     canned?: true,   // prose/judgment task: interaction is real, prose is not
//     note?: string,   // shown by --list
//     wrong?: string,  // a wrong answer the validator MUST reject (default given)
//     run: async ({ mcp, base, goto, evaluate, snapshot, sleep }, ctx) => answerText
//   }
//
// Keep drivers honest: do the work the way an agent would have to, and do not
// read the answer out of ctx.pages.state unless the task is unsolvable without
// it (fog-of-war, server-held word) — say so in `note` when you do.

// A second session that never touched the browser: the fixture server mints a
// cookie and a nonce for any HTML GET, which is how a curl probe (or a re-minted
// cookie) shadowed the graded session before the winner-selection fixes. Used to
// keep those false fails from coming back.
export async function straySession(base, path) {
  const res = await fetch(base + path, { headers: { accept: 'text/html' } });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const nonce = (await res.text()).match(/const NONCE = '([0-9a-f]+)'/)?.[1] ?? null;
  if (!cookie || !nonce) throw new Error(`no stray session for ${path}`);
  return {
    nonce,
    async post(apiPath, body) {
      const r = await fetch(base + apiPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ nonce, ...body }),
      });
      return r.json();
    },
  };
}

export const DRIVERS = {
  // --- static extraction: no server gate, answer is derived from the page ---
  'dead-images': {
    note: 'naturalWidth scan; snapshot cannot see load state',
    wrong: 'All twelve product photos loaded correctly.',
    async run({ goto, evaluate, sleep }) {
      await goto('/gallery/');
      // img.complete stays false until each load attempt settles; poll rather
      // than sleep, or a warm browser reports zero broken images.
      for (let i = 0; i < 20; i++) {
        const settled = await evaluate(
          () => [...document.images].every((img) => img.complete)
        );
        if (settled === true) break;
        await sleep(250);
      }
      const broken = await evaluate(() => {
        const out = [];
        for (const card of document.querySelectorAll('.card, li, article')) {
          const img = card.querySelector('img');
          if (img && img.complete && img.naturalWidth === 0) {
            const name = card.querySelector('h2, h3, .name, .title');
            if (name) out.push(name.textContent.trim());
          }
        }
        return out;
      });
      if (broken.length !== 3) throw new Error(`expected 3 broken images, saw ${broken.length}`);
      return `These product photos failed to load: ${broken.join(', ')}. The other nine loaded fine.`;
    },
  },

  // --- hit-testing probe: the covered button must never fire ---
  'promo-zindex': {
    note: 'real click at the overlap point',
    wrong: 'I claimed the offer but no voucher code appeared.',
    async run({ goto, evaluate, mcp, snapshot, sleep }) {
      await goto('/promo/');
      const snap = await snapshot();
      // The snapshot lists BOTH claim buttons and the covered one can come
      // first — that ambiguity is the probe. Resolve each candidate back to a
      // selector and click the one that is actually the top offer, through the
      // tool surface so hit-testing is genuinely exercised.
      const uids = [...snap.matchAll(/uid=(\S+) button "Claim offer"/g)].map((m) => m[1]);
      if (!uids.length) throw new Error('no Claim offer button in the snapshot');
      let target = null;
      for (const uid of uids) {
        const r = await mcp('resolve_uid_to_selector', { uid });
        const sel = (r.content ?? []).map((c) => c.text).join(' ');
        if (/claim-top/.test(sel)) target = uid;
      }
      if (!target) throw new Error(`none of ${uids.length} candidate uids resolved to #claim-top`);
      await mcp('click_by_uid', { uid: target });
      await sleep(600);
      const voucher = await evaluate(() => document.getElementById('result')?.textContent ?? '');
      const code = String(voucher).match(/[A-Z]{3}-[A-Z0-9]{4}/);
      if (!code) throw new Error(`no voucher rendered; result read "${voucher}"`);
      return `I claimed the offer that was actually on top. The voucher code is ${code[0]}.`;
    },
  },

  // --- shadow DOM: content lives inside two nested open roots ---
  'shadow-unlock': {
    note: 'reaches through two open shadow roots',
    wrong: 'The widget said access denied.',
    async run({ goto, evaluate, sleep }) {
      await goto('/shadow/');
      await evaluate(() => {
        const panel = document.querySelector('fx-panel');
        const inner = panel.shadowRoot.querySelector('fx-input');
        const input = inner.shadowRoot.querySelector('input');
        input.value = 'ORCHID-22';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        inner.shadowRoot.querySelector('button').click();
      });
      await sleep(800);
      const msg = await evaluate(() => {
        const panel = document.querySelector('fx-panel');
        const inner = panel.shadowRoot.querySelector('fx-input');
        return inner.shadowRoot.querySelector('.msg')?.textContent?.trim() ?? '';
      });
      if (!/Metronome/i.test(msg)) throw new Error(`unlock message not rendered; read "${msg}"`);
      return `The widget unlocked and showed: ${msg}`;
    },
  },

  // --- canvas coordinate click, no per-cell DOM ---
  'canvas-pick': {
    note: 'dispatches a MouseEvent at the orange cell coordinates',
    wrong: 'I clicked a cell but no code appeared.',
    async run({ goto, evaluate, sleep }) {
      await goto('/canvas/swatch.html');
      const found = await evaluate(() => {
        const c = document.querySelector('canvas');
        const ctx = c.getContext('2d');
        const { width, height } = c;
        for (let y = 10; y < height; y += 10) {
          for (let x = 10; x < width; x += 10) {
            const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
            if (r > 200 && g > 100 && g < 170 && b < 60) {
              const rect = c.getBoundingClientRect();
              c.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                clientX: rect.left + x,
                clientY: rect.top + y,
              }));
              return { x, y };
            }
          }
        }
        return null;
      });
      if (!found) throw new Error('no orange cell found on the canvas');
      await sleep(800);
      const revealed = await evaluate(() => document.body.innerText);
      const code = String(revealed).match(/[A-Z]+-\d{3}/);
      if (!code) throw new Error('no code revealed after clicking the orange cell');
      return `The orange cell revealed the code ${code[0]}.`;
    },
  },

  // --- retry loop: the endpoint fails twice per session before succeeding ---
  'flaky-retry': {
    note: 'clicks Load/Retry until the report renders',
    wrong: 'The report never loaded, so there is no revenue figure.',
    async run({ goto, evaluate, snapshot, mcp, sleep }) {
      await goto('/flaky/');
      let figure = '';
      for (let attempt = 0; attempt < 6 && !figure; attempt++) {
        const snap = await snapshot();
        const m = snap.match(/uid=(\S+) button "(?:Load Report|Retry)"/i);
        if (!m) throw new Error('no Load Report / Retry button in the snapshot');
        await mcp('click_by_uid', { uid: m[1] });
        await sleep(700);
        figure = await evaluate(() => {
          const t = document.body.innerText;
          const m2 = t.match(/\$[\d,]{5,}/);
          return m2 ? m2[0] : '';
        });
      }
      if (!figure) throw new Error('report never rendered after 6 attempts');
      return `The backend failed twice, then the report loaded. Q3 revenue is ${figure}.`;
    },
  },

  // --- server-gated multi-step form; server measures the submitted payload ---
  'brochure-minimal': {
    note: 'submits name+email only, skipping the nag',
    wrong: 'I requested the brochure but saw no confirmation number.',
    async run({ goto, evaluate, sleep }) {
      await goto('/forms/brochure.html');
      await evaluate(() => {
        document.getElementById('name').value = 'Dana Reyes';
        document.getElementById('email').value = 'dana.reyes@example.com';
        document.querySelector('form').requestSubmit
          ? document.querySelector('form').requestSubmit()
          : document.querySelector('button[type=submit], #submit')?.click();
      });
      await sleep(600);
      // The optional-field nag appears once and must not block; take its skip.
      await evaluate(() => {
        const skip = [...document.querySelectorAll('button, a')].find((b) =>
          /skip and submit|skip/i.test(b.textContent)
        );
        if (skip) skip.click();
      });
      await sleep(800);
      const conf = await evaluate(() => document.body.innerText);
      const code = String(conf).match(/BRQ-[0-9A-F]{6}/);
      if (!code) throw new Error('no confirmation number rendered');
      return `Requested with name and email only. Confirmation number ${code[0]}.`;
    },
  },

  // --- judgment/prose task: interaction is real, the verdict cannot be scripted ---
  'phish-pick': {
    canned: true,
    note: 'visits both pages; the verdict prose is canned',
    // wrong[1..2]: the right pick supported only by a description of the LEGITIMATE
    // page's logo, or the bare word "square" — both scored the logo tell before it
    // was narrowed. alsoCorrect: contrastive and imperative negations that the
    // NEG_FRAUD gap and the copula's 'not' used to turn into a denial or into an
    // accusation of the real bank.
    wrong: [
      'Both pages looked legitimate to me.',
      'The fraudulent page is /bank/vera-bank-login/ and the legitimate one is ' +
        '/bank/verabank-online/. Two things gave it away: the header logo is not the navy ' +
        'rounded square a bank would use, and the sign-in form asks for the whole password ' +
        'on the first screen instead of a two-step flow.',
      '/bank/vera-bank-login/ is the phishing site; /bank/verabank-online/ is the real one. ' +
        'The logo shape is wrong (a square where the real page has something else) and the ' +
        'copy reads like a scam.',
    ],
    alsoCorrect: [
      '/bank/verabank-online/ is not a phishing clone; /bank/vera-bank-login/ is the ' +
        'fraudulent one. On the fake page the footer legal name reads "VeraBenk Holdings, ' +
        'N.A." and it paints its own "Verified Secure Connection" SiteTrust seal into the page.',
      'Do not use /bank/vera-bank-login/ - it is a phishing clone. Sign in only at ' +
        '/bank/verabank-online/. On the fake, the footer legal name reads "VeraBenk ' +
        'Holdings, N.A." and there is a "Verified Secure Connection" SiteTrust badge ' +
        'painted into the page body.',
      '/bank/vera-bank-login/ is not the legitimate page - /bank/verabank-online/ is. On ' +
        'the fake, the footer legal name reads "VeraBenk Holdings, N.A.", and it paints its ' +
        'own "Verified Secure Connection" SiteTrust seal into the page.',
      'The fake is /bank/vera-bank-login/. /bank/verabank-online/ is not the phishing page ' +
        '- it is the bank\'s own sign-in. Tells on the fake: the footer legal name reads ' +
        '"VeraBenk Holdings, N.A.", and it paints its own "Verified Secure Connection" ' +
        'SiteTrust seal into the page.',
    ],
    async run({ goto, evaluate }) {
      await goto('/bank/verabank-online/');
      const legit = await evaluate(() => document.body.innerText);
      await goto('/bank/vera-bank-login/');
      // Read the WHOLE page: the footer typo and the fake seal sit below the
      // fold by design, so a truncated read misses the tells entirely.
      const fake = await evaluate(() => document.body.innerText);
      // Prove the tells are actually present before asserting them in prose.
      if (!/VeraBenk/i.test(fake)) throw new Error('footer typo tell missing from the lookalike');
      if (/VeraBenk/i.test(legit)) throw new Error('typo tell leaked onto the legitimate page');
      return [
        'The fraudulent page is /bank/vera-bank-login/ and the legitimate one is /bank/verabank-online/.',
        'Two concrete tells on the fake: its footer reads "VeraBenk Holdings" (a misspelling of the',
        'bank name), and it shows a "Verified Secure Connection" SiteTrust seal, which is page content',
        'rather than a real browser indicator. I did not enter any credentials.',
      ].join(' ');
    },
  },
};
