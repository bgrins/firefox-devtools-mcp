// T113 cross-tab-pay: pages/paylink/. The whole point is the second tab, so this
// driver does the handoff the way an agent must — click the merchant's
// target=_blank pay link, then move between the two tabs with select_page,
// reading the verification word off the merchant tab and typing it into the
// authorizer tab. It never reads ctx.pages.state.

const OPEN_LINK = /uid=(\S+) a "Authorise with Anverra/;
const WORD = /text="([A-Z]{4,8}-\d{2})"/;
const CODE = /text="(OC-[0-9A-F]{6})"/;

async function until(label, fn, { tries = 40, gap = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export const DRIVERS = {
  'cross-tab-pay': {
    note: 'drives both tabs: target=_blank pay link, select_page, close_page',
    wrong: 'Payment complete. The confirmation code is AVP-77120468.',
    async run({ mcp, goto, snapshot }) {
      const pages = async () => {
        const r = await mcp('list_pages');
        return (r.content ?? []).map((c) => c.text).join('\n');
      };
      const countTabs = async () => ((await pages()).match(/^\s*>?\[\d+\]/gm) ?? []).length;
      // Firefox inserts a link-opened tab immediately after its opener rather
      // than at the end, and this driver shares one browser with every other
      // driver, so the authorizer's index cannot be computed. Select by title and
      // let the tool report which index that was.
      const select = async (title) => {
        const r = await mcp('select_page', { title });
        const text = (r.content ?? []).map((c) => c.text).join('\n');
        const idx = Number(text.match(/selected \[(\d+)\]/)?.[1]);
        if (!Number.isInteger(idx)) throw new Error(`select_page ${title}: ${text}`);
        return idx;
      };

      await goto('/paylink/checkout.html');
      const linkUid = await until('the pay link to be armed', async () =>
        (await snapshot()).match(OPEN_LINK)?.[1]
      );
      const tabsBefore = await countTabs();
      await mcp('click_by_uid', { uid: linkUid });
      await until('the authorizer to open in a second tab', async () =>
        (await countTabs()) > tabsBefore
      );

      // The authorizer window: check it shows the amount being authorised, and
      // that it does NOT carry the merchant's confirmation code.
      await select('Anverra Pay');
      const authSnap = await until('the authorizer to render the amount', async () => {
        const s = await snapshot();
        return /\$329\.14/.test(s) ? s : null;
      });
      if (CODE.test(authSnap)) {
        throw new Error('the authorizer window leaked the merchant confirmation code');
      }

      // Back to the merchant tab for the verification word, which only appears
      // there and only once the authorizer window exists.
      await select('Ollister');
      const word = await until('the merchant tab to show the verification word', async () =>
        (await snapshot()).match(WORD)?.[1]
      );

      await select('Anverra Pay');
      const formSnap = await snapshot();
      const inputUid = formSnap.match(/uid=(\S+) input[^\n]*Verification word/)?.[1]
        ?? formSnap.match(/uid=(\S+) input/)?.[1];
      if (!inputUid) throw new Error('no verification word input in the authorizer snapshot');
      await mcp('fill_by_uid', { uid: inputUid, value: word });
      const approveUid = formSnap.match(/uid=(\S+) button "Approve payment"/)?.[1];
      if (!approveUid) throw new Error('no Approve payment button in the authorizer snapshot');
      await mcp('click_by_uid', { uid: approveUid });
      await until('the authorizer to report the approval', async () =>
        /Authorisation complete/.test(await snapshot())
      );

      await select('Ollister');
      const code = await until('the merchant tab to show the confirmation code', async () =>
        (await snapshot()).match(CODE)?.[1]
      );

      // Leave the browser as we found it: an authorizer tab left open would be
      // inherited by whatever task runs next in the same instance.
      await mcp('close_page', { pageIdx: await select('Anverra Pay') });
      await select('Ollister');

      return (
        `The payment is authorised and the order is placed. Ollister & Crane shows the order ` +
        `confirmation code ${code}. The Anverra Pay window only showed a processor reference, ` +
        `which is a different number.`
      );
    },
  },
};
