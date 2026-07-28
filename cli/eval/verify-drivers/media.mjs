// Golden path for the Skerrow Coastal Radio bulletin recording
// (pages/media/, task media-transcript). See probes.mjs for the contract.

const REF = /Log reference (SKW-[0-9A-F]{6})/;
// The rail's playhead, "mm:ss / 00:48", is the only place a snapshot can see
// that the recording is actually decoding and running.
const PLAYHEAD = /(\d\d):(\d\d) \/ 00:48/;

export const DRIVERS = {
  'media-transcript': {
    note:
      'plays the recording (proves decode + timeupdate), then jumps to chapter 3 and reads the ' +
      'transcript from the snapshot. `wrong` can only be a static code: the two decoy references ' +
      'a real agent is most likely to misreport are minted per session, and a driver must not ' +
      'read ctx.pages.state for a wrong answer it does not need',
    wrong: 'The log reference read out in the third chapter is SKW-4B19C2.',
    async run({ goto, mcp, snapshot, sleep }) {
      await goto('/media/');
      // The five recordings differ only by their link text, so resolve the held
      // one by name rather than by position.
      let snap = await snapshot();
      const listed = snap.match(/uid=(\S+) a "26 Jul 0535 recording"/);
      if (!listed) throw new Error('the held 0535 recording is not linked on the bulletin list');
      await mcp('click_by_uid', { uid: listed[1] });

      // The chapter rail is drawn from /api/media/cues and the transport only
      // enables once the recording has loaded, so poll for both rather than
      // sleeping a fixed time.
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        snap = await snapshot();
        ready =
          /text="Ready, 00:48"/.test(snap) && /uid=(\S+) span text="03 Station reports"/.test(snap);
        if (!ready) await sleep(250);
      }
      if (!ready) throw new Error('chapter 3 never appeared on the loaded bulletin page');

      // Play a couple of seconds before taking the shortcut: the chapter jump
      // alone would still pass if the WAV never decoded or `timeupdate` never
      // fired, and playback is the capability this fixture exists to measure.
      const play = snap.match(/uid=(\S+) button "Play"/);
      if (!play) throw new Error('the Play control never enabled');
      await mcp('click_by_uid', { uid: play[1] });
      let running = false;
      for (let i = 0; i < 40 && !running; i++) {
        snap = await snapshot();
        const at = snap.match(PLAYHEAD);
        running = Boolean(at) && Number(at[1]) * 60 + Number(at[2]) >= 2;
        if (!running) await sleep(250);
      }
      if (!running) throw new Error('the playhead never advanced past 00:02 while playing');
      const pause = snap.match(/uid=(\S+) button "Pause"/);
      if (pause) await mcp('click_by_uid', { uid: pause[1] });

      // The button's text lives in child spans, so the snapshot offers the span
      // rather than the button; clicking it is what an agent has to do too.
      snap = await snapshot();
      const chapter = snap.match(/uid=(\S+) span text="03 Station reports"/);
      if (!chapter) throw new Error('the chapter rail vanished after playback started');
      await mcp('click_by_uid', { uid: chapter[1] });

      let found = null;
      for (let i = 0; i < 40 && !found; i++) {
        snap = await snapshot();
        found = snap.match(REF);
        if (!found) await sleep(250);
      }
      if (!found) throw new Error('the chapter 3 log reference never reached the transcript');
      return (
        `I opened the 26 July 0535 recording and skipped to chapter 3, Station reports. ` +
        `The log reference read out there is ${found[1]}.`
      );
    },
  },
};
