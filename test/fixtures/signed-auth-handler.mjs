import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configureDVM, z } from "@dvmkit/sdk";
import { secp256k1Auth } from "@dvmkit/sdk/server";
import { Challenge } from "mppx";

const effects = { jobWrites: 0, requestClaims: 0, handlers: 0, quotes: 0, payments: 0, challenges: 0 };
const nonces = new Set();

// Observe the host's real store through its supported testing export. Delegating
// every operation keeps refused-request write detection independent of handlers.
const { MemoryJobStore } = await import(process.env.DVMCTL_AUTH_HOST_TESTING);
for (const [method, counter] of [["save", "jobWrites"], ["claimRequestId", "requestClaims"]]) {
  const original = MemoryJobStore.prototype[method];
  MemoryJobStore.prototype[method] = function (...args) {
    effects[counter]++;
    return original.apply(this, args);
  };
}

// FX and the payment provider are external; authentication and host ordering
// remain real, and the fixture cannot contact an actual payment service.
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "https://fixture.invalid/fx") return Response.json({ bitcoin: { usd: 100_000, eur: 90_000, gbp: 80_000 } });
  throw new Error("Unexpected outbound request in signed-auth fixture");
};

const input = z.object({
  text: z.string().max(3),
  pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
});
const auth = secp256k1Auth({
  replayStore: {
    async checkAndRecord(pubkey, timestamp, nonce) {
      const id = `${pubkey}:${timestamp}:${nonce}`;
      if (nonces.has(id)) return true;
      nonces.add(id);
      return false;
    },
  },
});
const checkAuth = auth.checkAuth.bind(auth);
auth.checkAuth = (schema, data, domain) => {
  if (data.text === "err") throw new Error("fixture-private-auth-failure");
  return checkAuth(schema, data, domain);
};

const capability = {
  input,
  onJob(ctx) { effects.handlers++; ctx.complete("authenticated"); },
};

export default configureDVM({
  name: "signed-auth-fixture",
  auth,
  capabilities: {
    run: capability,
    priced: {
      ...capability,
      onQuote: {
        schema: z.object({ text: z.string() }),
        async handler() {
          effects.quotes++;
          return { upfront: { amount: 0.01, currency: "usd" }, description: "Fixture price" };
        },
      },
    },
  },
  mpp: {
    methods: [{ name: "tempo", intent: "charge" }],
    challenge: {},
    async broadcastCredential() { effects.payments++; throw new Error("Fixture payment refused"); },
    async issueChallenge(method, intent, opts) {
      effects.challenges++;
      return Challenge.from({
        id: "fixture-challenge", realm: "example.com", method, intent,
        request: { amount: opts.amount, currency: "0x" + "22".repeat(20) },
      });
    },
  },
  routes(app) {
    app.get("/__auth_fixture/effects", (c) => c.json({
      ...effects, nonces: nonces.size,
      serverModule: realpathSync(fileURLToPath(import.meta.resolve("@dvmkit/sdk/server"))),
    }));
  },
});
