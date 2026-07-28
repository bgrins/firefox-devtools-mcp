// Golden-path drivers, split by fixture family so several can be authored in
// parallel without conflicting. Each module exports a DRIVERS object; this file
// merges them and fails loudly on a duplicate task id.
//
// See probes.mjs for the driver contract and worked examples.

import { DRIVERS as probes } from './probes.mjs';
import { DRIVERS as shop } from './shop.mjs';
import { DRIVERS as forms } from './forms.mjs';
import { DRIVERS as formsUpload } from './forms-upload.mjs';
import { DRIVERS as content } from './content.mjs';
import { DRIVERS as auth } from './auth.mjs';
import { DRIVERS as data } from './data.mjs';
import { DRIVERS as gadgetronMirror } from './gadgetron-mirror.mjs';
import { DRIVERS as floorplan } from './floorplan.mjs';
import { DRIVERS as consent } from './consent.mjs';
import { DRIVERS as govNavigation } from './gov-navigation.mjs';
import { DRIVERS as flakySlow } from './flaky-slow.mjs';
import { DRIVERS as viewport } from './viewport.mjs';
import { DRIVERS as paylink } from './paylink.mjs';
import { DRIVERS as forge } from './forge.mjs';
import { DRIVERS as support } from './support.mjs';
import { DRIVERS as schedule } from './schedule.mjs';
import { DRIVERS as auction } from './auction.mjs';
import { DRIVERS as calc } from './calc.mjs';
import { DRIVERS as metrics } from './metrics.mjs';
import { DRIVERS as consoleLog } from './console.mjs';
import { DRIVERS as intl } from './intl.mjs';

const modules = {
  probes,
  shop,
  forms,
  formsUpload,
  content,
  auth,
  data,
  gadgetronMirror,
  floorplan,
  consent,
  govNavigation,
  flakySlow,
  viewport,
  paylink,
  forge,
  support,
  schedule,
  auction,
  calc,
  consoleLog,
  intl,
  metrics,
};

export const DRIVERS = {};
const seen = new Map();
for (const [name, mod] of Object.entries(modules)) {
  for (const [id, driver] of Object.entries(mod)) {
    if (seen.has(id)) {
      throw new Error(
        `duplicate golden-path driver for "${id}" in ${name}.mjs and ${seen.get(id)}.mjs`
      );
    }
    seen.set(id, name);
    DRIVERS[id] = driver;
  }
}
