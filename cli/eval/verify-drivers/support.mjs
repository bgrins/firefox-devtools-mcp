// Golden path for T112 support-chat (pages/support/). The adviser's replies are
// queued server-side with due times, so every wait here polls for the reply
// rather than sleeping a fixed interval.
//
// Two things this driver documents about our surface, both measured while
// writing it (see staging/T112.md):
//   - the default 100-line snapshot loses the chat composer after the FIRST
//     exchange (the help page is 91 lines with the dock open, and each message
//     costs 3 lines), so every send after the first needs a scoped snapshot;
//   - message text truncates at 27 characters, so the adviser's instructions are
//     only ever half-readable through the snapshot.
// Neither is worked around in the fixture; the driver takes the same routes an
// agent has to take.

const CHAT_PATH = '/support/';
const ACCOUNT_PATH = '/support/account.html';

async function until(sleep, label, fn, { tries = 40, waitMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(waitMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const textOf = (result) => (result.content ?? []).map((c) => c.text).join('\n');

// The dock sits at the end of a 78-line help page, so scope the snapshot to it
// rather than raising maxLines: that is the cheaper of the two workarounds and
// the one an agent discovers from the "[+N lines]" marker. It stays cheap however
// long the chat runs — the transcript keeps only its most recent messages in the
// DOM, so this snapshot settles at ~37 lines with the composer always in it.
async function dockSnapshot(mcp) {
  return textOf(await mcp('take_snapshot', { selector: '.dock' }));
}

function uidFor(snap, pattern) {
  const line = snap.split('\n').find((l) => pattern.test(l));
  return line ? line.match(/uid=(\S+)/)?.[1] ?? null : null;
}

async function sendMessage(mcp, sleep, text) {
  const snap = await dockSnapshot(mcp);
  const box = uidFor(snap, /textarea/);
  const button = uidFor(snap, /button "Send"/);
  if (!box || !button) throw new Error('composer not present in the dock snapshot');
  await mcp('fill_by_uid', { uid: box, value: text });
  await mcp('click_by_uid', { uid: button });
  // The visitor line is echoed by the next poll; wait for it so a send that
  // silently failed is not mistaken for a slow reply.
  const head = text.slice(0, 24);
  await until(sleep, 'the sent message to appear in the transcript', async () =>
    (await dockSnapshot(mcp)).includes(head)
  );
}

export const DRIVERS = {
  'support-chat': {
    note: 'live chat: scoped snapshots, polls for each scripted reply',
    wrong: 'I raised the case with the adviser. The reference is SR-4B19C2.',
    async run({ mcp, goto, evaluate, sleep }) {
      await goto(CHAT_PATH);
      const home = textOf(await mcp('take_snapshot', {}));
      const launcher = uidFor(home, /button "Chat with an adviser"/);
      if (!launcher) throw new Error('no chat launcher on the help centre page');
      await mcp('click_by_uid', { uid: launcher });

      await until(sleep, "the adviser's greeting", async () =>
        (await dockSnapshot(mcp)).includes('How can I help today?')
      );

      await sendMessage(
        mcp,
        sleep,
        'My connection drops out for a few minutes three or four times each evening ' +
          'between 7pm and 10pm, and the gateway status light goes amber when it happens.'
      );

      // "What is your gateway model number?" is 34 chars, so the snapshot shows
      // "What is your gateway model ..." — enough to know what is being asked,
      // which is why this is a snapshot check and not an eval.
      await until(sleep, 'the adviser to ask for the gateway model', async () =>
        /What is your gateway model/.test(await dockSnapshot(mcp))
      );

      // The rest of the adviser's instruction is past the 27-char cap. Read it
      // through eval purely to assert the fixture still points at the account
      // page; the driver does not need the text to proceed.
      await until(sleep, 'the adviser to name the Equipment panel', async () => {
        const transcript = await evaluate(() =>
          [...document.querySelectorAll('.dock .msg .txt')].map((p) => p.textContent)
        );
        return (
          Array.isArray(transcript) &&
          transcript.some((line) => /Equipment panel of your account/.test(line))
        );
      });

      await goto(ACCOUNT_PATH);
      const account = await until(sleep, 'the equipment record to load', async () => {
        const snap = textOf(await mcp('take_snapshot', {}));
        const model = snap.match(
          /span text="Gateway model"\s*\n\s*uid=\S+ span text="([^"]+)"/
        )?.[1];
        return model && model !== 'Loading' ? model : null;
      });
      if (!/^GX-\d{4}[A-Z]$/.test(account)) {
        throw new Error(`account page rendered an implausible gateway model: ${account}`);
      }

      await goto(CHAT_PATH);
      // The widget reopens itself from sessionStorage on return, and the poll
      // replays every reply that has already fallen due.
      await until(sleep, 'the chat to reopen with its transcript', async () =>
        (await dockSnapshot(mcp)).includes('What is your gateway model')
      );

      await sendMessage(mcp, sleep, `The gateway model is ${account}.`);

      const closing = await until(sleep, 'the adviser to raise a case', async () => {
        const snap = await dockSnapshot(mcp);
        return snap.match(/\bSR-[0-9A-F]{6}\b/)?.[0] ?? null;
      });

      return [
        `I described the evening dropouts to the adviser, then took the gateway model`,
        `${account} from the Equipment panel of my account and gave it to them.`,
        `The case reference is ${closing}.`,
      ].join(' ');
    },
  },
};
