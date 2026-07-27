// Golden-path driver for pages/shop/gadgetron-mirror/ (T043). See probes.mjs
// for the contract.

const SNAP_LINES = 300;

async function snapshot(h) {
  const r = await h.mcp('take_snapshot', { maxLines: SNAP_LINES });
  return (r.content ?? []).map((c) => c.text).join('\n');
}

function uid(snap, re, label) {
  const m = snap.match(re);
  if (!m) throw new Error(`no snapshot node for ${label}`);
  return m[1];
}

// The mirror paints its price from a session-gated fetch, so poll the snapshot
// instead of sleeping: a fixed wait is a coin flip on a cold browser.
async function waitForSnapshot(h, re, label, tries = 40) {
  let snap = '';
  for (let i = 0; i < tries; i++) {
    snap = await snapshot(h);
    if (re.test(snap)) return snap;
    await h.sleep(200);
  }
  throw new Error(`timed out waiting for ${label}; last snapshot:\n${snap.slice(0, 900)}`);
}

export const DRIVERS = {
  // --- partial outage: the primary store is masked, the price lives on the mirror ---
  'mirror-reroute': {
    note: 'clicks splash -> mirror -> department -> dock; asserts serverModes armed the outage',
    wrong:
      'The VoltCharge DK-100 dock is $129.00, listed on the main Gadgetron store ' +
      'at /shop/gadgetron/.',
    async run(h, ctx) {
      // The outage is armed by the harness (run.mjs and verify.mjs both apply
      // the task's serverModes after state.reset()), NOT by this driver: that
      // plumbing is new, so the golden path has to exercise it rather than
      // paper over a break in it.
      if (!ctx.pages.state.modes?.gadgetronDown) {
        throw new Error('serverModes did not arm gadgetronDown: is the T043 plumbing applied?');
      }

      await h.goto('/shop/gadgetron/');
      const splash = await waitForSnapshot(
        h,
        /Store maintenance in progress/,
        'the maintenance splash on the primary store'
      );
      // The route out is a link whose TEXT is the mirror path: a snapshot href is
      // absolutized and truncated at 27 chars, so it can never be read back.
      const route = uid(splash, /uid=(\S+) a "\/shop\/gadgetron-mirror\/"/, 'mirror route link');
      await h.mcp('click_by_uid', { uid: route });

      const depts = await waitForSnapshot(h, /Docks, hubs and power/, 'the mirror department list');
      await h.mcp('click_by_uid', {
        uid: uid(depts, /uid=(\S+) a "Docks, hubs and power"/, 'docks department link'),
      });

      // The department listing is a <table>, which the snapshot walker drops
      // whole; only the links inside it bubble up, so the spec sheet is the one
      // reachable route to the price through this surface.
      const rows = await waitForSnapshot(h, /VoltCharge DK-100/, 'the docks department listing');
      await h.mcp('click_by_uid', {
        uid: uid(rows, /uid=(\S+) a "VoltCharge DK-100(?: dock)?"/, 'VoltCharge spec sheet link'),
      });

      const sheet = await waitForSnapshot(
        h,
        /uid=\S+ p text="\$\d+\.\d\d"/,
        'the mirror price on the VoltCharge spec sheet'
      );
      const price = sheet.match(/uid=\S+ p text="\$(\d+\.\d\d)"/)[1];
      const url = `${h.base}/shop/gadgetron-mirror/voltcharge-dock.html`;
      return (
        `Gadgetron's main store is down for scheduled maintenance (incident MB-3-1174), ` +
        `and the splash points at the read-only mirror node. The VoltCharge DK-100 dock ` +
        `(part no. VC-DK100) is $${price} there, per unit excluding tax. I read it from ` +
        `${url}, which is the mirror's spec sheet for that part; the mirror accepts no orders.`
      );
    },
  },
};
