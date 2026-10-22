import test from "node:test";
import { resolve } from "node:path";

import { assertTempoDrainDecisions } from "../scripts/consumer-tempo-decisions.mjs";

test("packaged Tempo decisions require confirmation, sign exact requests, and preserve replay audit with current balances", async () => {
  await assertTempoDrainDecisions(resolve("dist/dvmctl.js"));
});
