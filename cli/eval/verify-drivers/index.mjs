// Golden-path drivers, split by fixture family so several can be authored in
// parallel without conflicting. Each module exports a DRIVERS object; this file
// merges them and fails loudly on a duplicate task id.
//
// See probes.mjs for the driver contract and worked examples.

import { DRIVERS as probes } from './probes.mjs';
import { DRIVERS as shop } from './shop.mjs';
import { DRIVERS as forms } from './forms.mjs';
import { DRIVERS as content } from './content.mjs';
import { DRIVERS as auth } from './auth.mjs';
import { DRIVERS as data } from './data.mjs';

const modules = { probes, shop, forms, content, auth, data };

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
