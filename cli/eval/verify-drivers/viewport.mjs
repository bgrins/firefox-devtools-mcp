// Golden-path driver for the responsive-layout task on pages/shop/voltro/.
// See probes.mjs for the contract.

const SNAP_LINES = 500;
// The store's own mobile breakpoint; the driver asserts the layout really
// crossed it rather than trusting the width it asked for.
const BREAKPOINT = 600;
// Restored at the end: verify.mjs reuses one browser for every task, so a
// window left at phone width would silently reshape later drivers' snapshots.
const DESKTOP = { width: 1366, height: 768 };

async function snapshot(h, options = {}) {
  const r = await h.mcp('take_snapshot', { maxLines: SNAP_LINES, ...options });
  return (r.content ?? []).map((c) => c.text).join('\n');
}

function uid(snap, re, label) {
  const m = snap.match(re);
  if (!m) throw new Error(`no snapshot node for ${label ?? re}`);
  return m[1];
}

async function waitFor(h, fn, label, tries = 40) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await h.evaluate(fn);
    if (last) return last;
    await h.sleep(200);
  }
  throw new Error(`timed out waiting for ${label} (last read: ${JSON.stringify(last)})`);
}

// The menu panel carries the `hidden` attribute until the toggle is clicked and
// the walker omits hidden nodes, so the link only exists after a real click.
async function waitForSnapshotNode(h, re, label, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const snap = await snapshot(h);
    const m = snap.match(re);
    if (m) return m[1];
    await h.sleep(200);
  }
  throw new Error(`timed out waiting for ${label} in the snapshot`);
}

export const DRIVERS = {
  // --- responsive layout: the only Deals link exists below 600 CSS px ---
  'narrow-viewport': {
    note: 'set_viewport_size 480, opens the collapsed menu, follows Deals of the Day',
    wrong: "Today's deal code is DEAL-NARROW-49.",
    async run(h) {
      try {
        await h.goto('/shop/voltro/');
        await waitFor(
          h,
          () => document.querySelectorAll('#grid .card').length,
          'voltro listing cards'
        );
        // Precondition: at desktop width neither the toggle nor any link to the
        // deals page exists, so the task cannot be won without resizing.
        const desktop = await h.evaluate(() => ({
          toggle: !!document.getElementById('menubtn'),
          dealsLinks: [...document.querySelectorAll('a')].filter((a) =>
            /deals\.html/.test(a.getAttribute('href') ?? '')
          ).length,
        }));
        if (desktop.toggle || desktop.dealsLinks) {
          throw new Error(
            `mobile affordances leaked into the desktop layout: ${JSON.stringify(desktop)}`
          );
        }

        await h.mcp('set_viewport_size', { width: 480, height: 900 });
        // Headless Firefox clamps the window to a ~500px minimum width, so the
        // graded fact is the layout state, not the number we asked for.
        const width = await waitFor(
          h,
          () =>
            window.matchMedia('(max-width: 600px)').matches ? window.innerWidth : false,
          'mobile layout to take effect'
        );
        if (width > BREAKPOINT) {
          throw new Error(`viewport reports ${width}px, wider than the ${BREAKPOINT}px breakpoint`);
        }

        const collapsed = await snapshot(h);
        await h.mcp('click_by_uid', {
          uid: uid(collapsed, /uid=(\S+) button "Menu"/, 'collapsed menu toggle'),
        });
        const dealsUid = await waitForSnapshotNode(
          h,
          /uid=(\S+) a "Deals of the Day"/,
          'Deals of the Day link'
        );
        await h.mcp('click_by_uid', { uid: dealsUid });

        // The graded answer is read out of the SNAPSHOT, not out of evaluate():
        // snapshot legibility of the code is the surface property this task
        // leans on, so a deals page that outgrew the walker must fail here.
        const snapCode = await waitForSnapshotNode(
          h,
          /text="(DEAL-[0-9A-F]{6})"/,
          'deal code in the snapshot'
        );
        const deal = await waitFor(
          h,
          () => {
            const code = document.getElementById('code')?.textContent.trim();
            if (!code) return false;
            return { code, width: window.innerWidth, path: location.pathname };
          },
          'deal code on the deals page'
        );
        if (!/\/deals\.html$/.test(deal.path)) {
          throw new Error(`ended up on ${deal.path} instead of the deals page`);
        }
        if (deal.code !== snapCode) {
          throw new Error(`snapshot read ${snapCode} but the page holds ${deal.code}`);
        }
        return (
          `I resized the browser to 480px wide (Firefox settled at ${width}px, still inside ` +
          `the store's mobile breakpoint), which collapsed the department bar into a Menu ` +
          `button. Opening that menu revealed a Deals of the Day link that is not present in ` +
          `the desktop layout. Today's deal code is ${deal.code}.`
        );
      } finally {
        await h.mcp('set_viewport_size', DESKTOP).catch(() => {});
      }
    },
  },
};
