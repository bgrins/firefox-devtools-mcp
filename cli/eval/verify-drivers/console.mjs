// pages/console/ — Cindergrid deploy console. The run log is painted to a
// <canvas>, so nothing in it reaches either snapshot surface; the golden path is
// the toolbar search box, whose server-returned hits render as real DOM.

export const DRIVERS = {
  'canvas-log': {
    note: 'canvas terminal; search box is the only snapshot-readable route',
    wrong: 'The release/gate step failed with error id E-4B21C7.',
    async run({ mcp, goto, sleep }) {
      const snap = async () => {
        const r = await mcp('take_snapshot', { maxLines: 400 });
        return (r.content ?? []).map((c) => c.text).join('\n');
      };

      await goto('/console/');
      // The viewer pages the log in 80 lines at a time; wait for the toolbar
      // counter to stop growing rather than for a fixed delay.
      let page = '';
      for (let i = 0; i < 40; i++) {
        page = await snap();
        if (/text="161 lines"/.test(page)) break;
        await sleep(250);
      }
      if (!/text="161 lines"/.test(page)) throw new Error('log never finished loading');
      if (/E-[0-9A-F]{6}/.test(page)) {
        throw new Error('an error id was readable before searching — the canvas is leaking');
      }

      const box = page.match(/uid=(\S+) input "Search log"/)?.[1];
      if (!box) throw new Error('no search box in the snapshot');
      await mcp('fill_by_uid', { uid: box, value: 'ERROR' });

      // Every snapshot invalidates the previous uids, so re-read before clicking.
      page = await snap();
      const button = page.match(/uid=(\S+) button "Search"/)?.[1];
      if (!button) throw new Error('no search button in the snapshot');
      await mcp('click_by_uid', { uid: button });

      let hit = null;
      for (let i = 0; i < 20; i++) {
        page = await snap();
        hit = page.match(
          /text="(E-[0-9A-F]{6})"\s*\n\s*uid=\S+ span text="release\/gate failed/
        );
        if (hit) break;
        await sleep(250);
      }
      if (!hit) throw new Error('search returned no release/gate ERROR line');

      // The hits must also land inside the DEFAULT snapshot cap (maxLines 100),
      // because `find` only searches what the snapshot returned: an earlier
      // layout pushed them past it and made the page look empty. Assert the
      // regression cannot come back unnoticed.
      const capped = await mcp('take_snapshot', {});
      const cappedText = (capped.content ?? []).map((c) => c.text).join('\n');
      if (!cappedText.includes(hit[1]) || !/release\/gate failed/.test(cappedText)) {
        throw new Error('search hits fall outside the default 100-line snapshot cap');
      }

      // The step summary is what disambiguates the four ERROR lines; assert the
      // fixture still marks exactly one step Failed.
      const failed = [...page.matchAll(/uid=\S+ span text="([^"]+)"\s*\n\s*uid=\S+ span text="Failed"/g)]
        .map((m) => m[1]);
      if (failed.length !== 1 || failed[0] !== 'release/gate') {
        throw new Error(`expected release/gate to be the only failed step, saw ${failed.join(',')}`);
      }

      return (
        `Run 4192 stopped at the release/gate step. The run log records error id ` +
        `${hit[1]} on line 88: no build attestation for the image.`
      );
    },
  },
};
