import {
  DvmError,
  encodePaymentRequiredHeader,
  type PaymentRequiredV2,
} from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpsTransport } from "../https";

const provider = { endpoint: "https://dvm.example.com" };

/** A well-formed signed receipt off the wire. Not verified here — the transport only guards its shape. */
const RECEIPT = {
  v: 1,
  job_id: "j1",
  dvm_id: "dvm-testdvm",
  dvm: "testdvm",
  capability: "count",
  outcome: "completed",
  reason: null,
  seq: 7,
  issued_at: 1789300000,
  requester_pubkey: null,
  paid: {
    msats: 5000,
    rail: "cashu",
    native_amount: null,
    native_asset: null,
    tx_hash: null,
    mint: "https://mint.example",
  },
  result_hash: "aa".repeat(32),
  receipt_pubkey: "bb".repeat(32),
  signature: "cc".repeat(64),
};

/** `/v1/info#builder` — the trust anchor a receipt chains to. */
const BUILDER_BLOCK = {
  pubkey: "dd".repeat(32),
  attestation: {
    dvm_id: "dvm-testdvm",
    slug: "testdvm",
    receipt_pubkey: "bb".repeat(32),
  },
  signature: "ee".repeat(64),
};

function mockFetch(status: number, body: unknown, headers?: Record<string, string>) {
  const headerMap = new Map(Object.entries(headers ?? {}));
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
        json: () => Promise.resolve(body),
        headers: {
          get: (name: string) => headerMap.get(name) ?? null,
        },
      })
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpsTransport", () => {
  describe("describe", () => {
    it("fetches /v1/info and returns ProviderInfo", async () => {
      mockFetch(200, {
        name: "TestDVM",
        description: "A test",
        tags: ["web", "extraction"],
        mints: ["https://mint.example.com"],
        request_recovery: true,
      });
      const t = new HttpsTransport();
      const info = await t.describe(provider);
      expect(info.name).toBe("TestDVM");
      expect(info.about).toBe("A test");
      expect(info.tags).toEqual(["web", "extraction"]);
      expect(info.requestRecovery).toBe(true);
    });

    it("does not trust a provider-supplied platform DVM identity header", async () => {
      mockFetch(200, { name: "TestDVM" }, { "x-dvmkit-platform-dvm-id": "dvm-platform-1" });
      const t = new HttpsTransport();
      expect(await t.describe(provider)).not.toHaveProperty("platformDvmId");
    });

    it("throws on non-200 response", async () => {
      mockFetch(500, "Internal Server Error");
      const t = new HttpsTransport();
      await expect(t.describe(provider)).rejects.toThrow(DvmError);
    });

    it("bounds a metadata read when the caller supplies a timeout", async () => {
      const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Promise.reject(new DOMException("timed out", "TimeoutError"));
      });
      vi.stubGlobal("fetch", fetchMock);

      const t = new HttpsTransport();
      await expect(t.describe(provider, { timeoutMs: 5_000 })).rejects.toMatchObject({
        code: "timeout",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("surfaces the receipts flag and the builder trust anchor", async () => {
      mockFetch(200, { name: "TestDVM", receipts: true, builder: BUILDER_BLOCK });
      const t = new HttpsTransport();
      const info = await t.describe(provider);
      expect(info.receipts).toBe(true);
      expect(info.builder).toEqual(BUILDER_BLOCK);
    });

    it("leaves `receipts` undefined rather than false when the DVM omits it", async () => {
      // Absence is the "not supported here" signal — a `false` would let a
      // caller conflate "no receipt this time" with "never issues them".
      mockFetch(200, { name: "TestDVM" });
      const t = new HttpsTransport();
      const info = await t.describe(provider);
      expect(info.receipts).toBeUndefined();
      expect(info.builder).toBeUndefined();
    });

    it("drops a structurally broken builder block instead of throwing", async () => {
      mockFetch(200, { name: "TestDVM", builder: { pubkey: 42 } });
      const t = new HttpsTransport();
      expect((await t.describe(provider)).builder).toBeUndefined();
    });

    it("parses protocol_version from response", async () => {
      mockFetch(200, {
        name: "TestDVM",
        description: "A test",
        protocol_version: 1,
      });
      const t = new HttpsTransport();
      const info = await t.describe(provider);
      expect(info.protocolVersion).toBe(1);
    });

    it("throws when protocol_version exceeds supported version", async () => {
      mockFetch(200, {
        name: "TestDVM",
        description: "A test",
        protocol_version: 99,
      });
      const t = new HttpsTransport();
      await expect(t.describe(provider)).rejects.toThrow(DvmError);
    });

    it("maps quote schema from response", async () => {
      const schema = {
        type: "object",
        properties: { duration_seconds: { type: "number" } },
        required: ["duration_seconds"],
      };
      mockFetch(200, {
        name: "TestDVM",
        description: "A test",
        quote: { schema },
      });
      const t = new HttpsTransport();
      const info = await t.describe(provider);
      expect(info.quote).toEqual({ schema });
    });

    it("maps top-level input_schema from response", async () => {
      const inputSchema = {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      };
      mockFetch(200, {
        name: "TestDVM",
        description: "A test",
        input_schema: inputSchema,
      });
      const t = new HttpsTransport();
      const info = await t.describe(provider);
      expect(info.inputSchema).toEqual(inputSchema);
    });
  });

  describe("quote", () => {
    it("POSTs /v1/quote and returns Quote[] in the fiat-first shape", async () => {
      mockFetch(200, {
        upfront: { amount: 0.05, currency: "usd" },
        description: "test quote",
        mints: ["https://mint.example.com"],
      });
      const t = new HttpsTransport();
      const quotes = await t.quote(provider, { input: "hi" });
      expect(quotes).toHaveLength(1);
      expect(quotes[0].upfront).toEqual({ amount: 0.05, currency: "usd" });
      expect(quotes[0].description).toBe("test quote");
    });

    // A provider that renders `amount` coarser than it charges — the
    // isolate tier advertises at four decimals — cannot be reproduced from the
    // decimal, so the integer rides through untouched.
    it("surfaces the quote's exact amount_micro rather than re-deriving it", async () => {
      mockFetch(200, {
        upfront: { amount: 0.0032, amount_micro: 3174, currency: "usd" },
        description: "test quote",
      });
      const t = new HttpsTransport();
      const quotes = await t.quote(provider, { input: "hi" });
      expect(quotes[0].upfront).toEqual({ amount: 0.0032, currency: "usd", amount_micro: 3174 });
    });

    it("leaves amount_micro undefined for a provider that predates the field", async () => {
      mockFetch(200, { upfront: { amount: 0.05, currency: "usd" }, description: "test quote" });
      const t = new HttpsTransport();
      const quotes = await t.quote(provider, { input: "hi" });
      expect(quotes[0].upfront.amount_micro).toBeUndefined();
    });

    it("maps description from response", async () => {
      mockFetch(200, {
        upfront: { amount: 0.03, currency: "usd" },
        description: "300s video transcription",
      });
      const t = new HttpsTransport();
      const quotes = await t.quote(provider, { input: "hi" });
      expect(quotes[0].description).toBe("300s video transcription");
    });

    it("maps the nested payment envelope with per-rail refundability", async () => {
      mockFetch(200, {
        upfront: { amount: 0.05, currency: "usd" },
        description: "test quote",
        payment: {
          methods: ["cashu", "x402"],
          refundable: { cashu: true, x402: false },
        },
      });
      const t = new HttpsTransport();
      const quotes = await t.quote(provider, { input: "hi" });
      expect(quotes[0].payment).toEqual({
        methods: ["cashu", "x402"],
        refundable: { cashu: true, x402: false },
      });
    });

    it("leaves payment undefined when a legacy provider omits refundable", async () => {
      mockFetch(200, {
        upfront: { amount: 0.05, currency: "usd" },
        description: "test quote",
        payment: { methods: ["cashu"] },
      });
      const t = new HttpsTransport();
      const quotes = await t.quote(provider, { input: "hi" });
      expect(quotes[0].payment).toBeUndefined();
    });

    it("throws on 422 response", async () => {
      mockFetch(422, "Invalid request");
      const t = new HttpsTransport();
      await expect(t.quote(provider, { input: "hi" })).rejects.toThrow(DvmError);
    });

    it("surfaces invalid_input when /v1/quote returns invalid_quote_data", async () => {
      mockFetch(400, {
        error: "invalid_quote_data",
        message: "input did not satisfy schema",
        hint: "Pass --param url=...",
      });
      const t = new HttpsTransport();
      try {
        await t.quote(provider, { input: "hi" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("invalid_input");
        expect((e as DvmError).hint).toBe("Pass --param url=...");
        expect((e as DvmError).proseSources).toEqual({
          message: "provider",
          hint: "provider",
        });
      }
    });

    // A typed 503 in the quote path's nested envelope shape
    // (`{ error: { code, display, hint } }`) reaches the caller as structured
    // fields, not buried in a `provider_error` message.
    it("surfaces a nested typed 503 envelope as a structured DvmError", async () => {
      mockFetch(503, {
        error: {
          code: "fx_rate_unavailable",
          display: "Pricing is briefly unavailable — try again in a moment.",
          hint: "The provider's FX source is down. Retry shortly.",
        },
      });
      const t = new HttpsTransport();
      try {
        await t.quote(provider, { input: "hi" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        const err = e as DvmError;
        expect(err.code).toBe("fx_rate_unavailable");
        expect(err.hint).toBe("The provider's FX source is down. Retry shortly.");
        expect(err.data?.display).toBe("Pricing is briefly unavailable — try again in a moment.");
        expect(err.proseSources).toEqual({
          message: "provider",
          display: "provider",
          hint: "provider",
        });
      }
    });
  });

  describe("submit", () => {
    it("returns completed receipt on 200", async () => {
      mockFetch(200, { job_id: "j1", summary: "answer" });
      const t = new HttpsTransport();
      const receipt = await t.submit(provider, { input: "hi" }, { cashuToken: "tok" });
      expect(receipt.status).toBe("completed");
      expect(receipt.summary).toBe("answer");

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const headers = (fetchCall[1] as { headers: Record<string, string> }).headers;
      expect(headers["X-Cashu"]).toBe("tok");
    });

    it("selects the x402 request header from the payment version", async () => {
      mockFetch(200, { job_id: "j1", summary: "answer" });
      await new HttpsTransport().submit(
        provider,
        { input: "hi" },
        { x402Payment: "v2-artifact", x402Version: 2 }
      );
      const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["PAYMENT-SIGNATURE"]).toBe("v2-artifact");
      expect(headers["X-PAYMENT"]).toBeUndefined();
    });

    it("captures a feedback claim only from the job submission response", async () => {
      mockFetch(
        202,
        { job_id: "j1", estimated_seconds: 30 },
        {
          "x-dvmkit-router-feedback-claim": "router-claim",
        }
      );
      const receipt = await new HttpsTransport().submit(provider, { input: "hi" });
      expect(receipt.feedbackClaim).toBe("router-claim");
    });

    it("returns processing receipt on 202", async () => {
      mockFetch(202, { job_id: "j1", estimated_seconds: 30 });
      const t = new HttpsTransport();
      const receipt = await t.submit(provider, { input: "hi" });
      expect(receipt.status).toBe("processing");
      expect(receipt.estimatedSeconds).toBe(30);
    });

    it("returns payment-required receipt on 402 with required_msats", async () => {
      mockFetch(402, {
        error: "payment_required",
        required_msats: 10_000,
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base",
            maxAmountRequired: "1330",
          },
        ],
        mints: ["https://mint.example.com"],
      });
      const t = new HttpsTransport();
      const receipt = await t.submit(provider, { input: "hi" });
      expect(receipt.status).toBe("payment-required");
      expect(receipt.jobId).toBe("");
      expect(receipt.quotes).toHaveLength(1);
      const quote = receipt.quotes?.at(0);
      expect(quote?.priceMsats).toBe(10_000);
      expect(quote?.requiredUsdcMicro).toBe("1330");
      expect(quote?.x402PaymentRequired?.x402Version).toBe(1);
      expect(quote?.mints).toEqual(["https://mint.example.com"]);
      // No `price_micro` on the body, so there is no signable fiat figure —
      // the synthetic `upfront.amount` is a client-fx reconstruction rounded to
      // four decimals and must not be mistaken for one.
      expect(quote?.upfront.amount_micro).toBeUndefined();
    });

    it("prefers a v2 PAYMENT-REQUIRED challenge over the legacy body", async () => {
      const required: PaymentRequiredV2 = {
        x402Version: 2,
        resource: { url: "https://dvm.example.com/v1/job", mimeType: "application/json" },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "1440",
            asset: `0x${"1".repeat(40)}`,
            payTo: `0x${"2".repeat(40)}`,
            maxTimeoutSeconds: 60,
            extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
          },
        ],
        extensions: {},
      };
      mockFetch(
        402,
        {
          error: "payment_required",
          required_msats: 10_000,
          x402Version: 1,
          accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "1330" }],
        },
        { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) }
      );

      const receipt = await new HttpsTransport().submit(provider, { input: "hi" });
      const quote = receipt.quotes?.[0];
      expect(quote?.requiredUsdcMicro).toBe("1440");
      expect(quote?.x402PaymentRequired).toEqual(required);
    });

    // A v2-only server whose requirement carries no `extra` — legal per the
    // schema, and what two live x402.org kinds advertise. The strict decoder
    // used to throw here, and the v1-body fallback has nothing to fall back to,
    // so the caller was handed an unpayable quote.
    it("keeps a v2-only challenge payable when the requirement omits extra", async () => {
      const required: PaymentRequiredV2 = {
        x402Version: 2,
        resource: { url: "https://dvm.example.com/v1/job", mimeType: "application/json" },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "1440",
            asset: `0x${"1".repeat(40)}`,
            payTo: `0x${"2".repeat(40)}`,
            maxTimeoutSeconds: 60,
          },
        ],
        extensions: {},
      };
      mockFetch(
        402,
        { error: "payment_required", required_msats: 10_000 },
        { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) }
      );

      const receipt = await new HttpsTransport().submit(provider, { input: "hi" });
      const quote = receipt.quotes?.[0];
      expect(quote?.x402PaymentRequired).toEqual(required);
      expect(quote?.requiredUsdcMicro).toBe("1440");
    });

    // The provider's own integer, taken verbatim. Signing a
    // fund-and-draw off the rounded client-fx figure above would itself cause a
    // funding commitment mismatch.
    it("takes the 402's price_micro verbatim as the synthetic quote's exact price", async () => {
      mockFetch(402, {
        error: "payment_required",
        required_msats: 4_000,
        price_micro: 3174,
        price_currency: "usd",
      });
      const t = new HttpsTransport();
      const receipt = await t.submit(provider, { input: "hi" });
      const upfront = receipt.quotes?.at(0)?.upfront;
      expect(upfront?.amount_micro).toBe(3174);
      expect(upfront?.currency).toBe("usd");
      // The decimal restates the integer rather than being re-derived from a
      // rate — `roundUsd` would have rendered this 0.0032.
      expect(upfront?.amount).toBe(0.003174);
    });

    it("carries the provider's own currency on the exact figure", async () => {
      mockFetch(402, {
        error: "payment_required",
        required_msats: 4_000,
        price_micro: 200_000,
        price_currency: "eur",
      });
      const t = new HttpsTransport();
      const upfront = (await t.submit(provider, { input: "hi" })).quotes?.at(0)?.upfront;
      expect(upfront).toEqual({ amount: 0.2, currency: "eur", amount_micro: 200_000 });
    });

    it("labels an exact price off the credit menu when price_currency is absent", async () => {
      // The menu is denominated in the DVM's own pricing currency by
      // construction, so it beats defaulting a non-USD provider's price to
      // `usd` — a mislabel the caller would then display and budget against.
      mockFetch(402, {
        error: "payment_required",
        required_msats: 4_000,
        price_micro: 200_000,
        credit: {
          min_micro: 100_000,
          max_micro: 5_000_000,
          ttl_ms: 86_400_000,
          currency: "eur",
          funding: ["cashu"],
        },
      });
      const t = new HttpsTransport();
      const upfront = (await t.submit(provider, { input: "hi" })).quotes?.at(0)?.upfront;
      expect(upfront).toEqual({ amount: 0.2, currency: "eur", amount_micro: 200_000 });
    });

    it("falls back to usd when neither price_currency nor a credit menu states one", async () => {
      mockFetch(402, {
        error: "payment_required",
        required_msats: 4_000,
        price_micro: 200_000,
      });
      const t = new HttpsTransport();
      const upfront = (await t.submit(provider, { input: "hi" })).quotes?.at(0)?.upfront;
      expect(upfront?.currency).toBe("usd");
    });

    it("ignores a price_micro that isn't a positive safe integer", async () => {
      mockFetch(402, {
        error: "payment_required",
        required_msats: 4_000,
        price_micro: "3174",
      });
      const t = new HttpsTransport();
      const upfront = (await t.submit(provider, { input: "hi" })).quotes?.at(0)?.upfront;
      expect(upfront?.amount_micro).toBeUndefined();
    });

    // Short-pay still resolves to a receipt, not a throw — `payment_insufficient`
    // with `required_msats` means "send the difference", which the caller can act
    // on. This branch also applies without allowlisting payment codes.
    it("returns payment-required receipt on 402 payment_insufficient", async () => {
      mockFetch(402, {
        error: "payment_insufficient",
        required_msats: 10_000,
        received_msats: 5_000,
        display: "The payment was less than the amount required.",
        retryable: true,
        mints: ["https://mint.example.com"],
      });
      const t = new HttpsTransport();
      const receipt = await t.submit(provider, { input: "hi" });
      expect(receipt.status).toBe("payment-required");
      expect(receipt.quotes?.at(0)?.priceMsats).toBe(10_000);
      expect(receipt.quotes?.at(0)?.description).toContain("5000");
    });

    // The other half of that rule: `required_msats` alone does not make a body
    // payable. A rejection code carrying it (an SDK never does, but a DVM that
    // echoes the price back with its refusal would) must still throw — turning
    // it into a receipt would hand the agent a quote to pay for a payment the
    // DVM has already refused.
    it("throws rather than quoting when a rejection code carries required_msats", async () => {
      mockFetch(402, {
        error: "invalid_token",
        message: "Token could not be decoded.",
        display: "The payment token couldn't be read. Nothing was charged.",
        retryable: false,
        required_msats: 10_000,
      });
      const t = new HttpsTransport();
      await expect(
        t.submit(provider, { input: "hi" }, { cashuToken: "tok" })
      ).rejects.toMatchObject({ code: "invalid_token", data: { retryable: false } });
    });

    it("throws on 402 payment_invalid", async () => {
      mockFetch(402, { error: "payment_invalid", message: "Bad token" });
      const t = new HttpsTransport();
      await expect(t.submit(provider, { input: "hi" })).rejects.toThrow(DvmError);
      try {
        await t.submit(provider, { input: "hi" });
      } catch (e) {
        expect((e as DvmError).code).toBe("payment_invalid");
      }
    });

    it("throws with the DVM's code on 402 without required_msats", async () => {
      mockFetch(402, { error: "payment_required" });
      const t = new HttpsTransport();
      await expect(t.submit(provider, { input: "hi" })).rejects.toMatchObject({
        code: "payment_required",
      });
    });

    // Every payment code reaches the caller intact. Before, only
    // payment_invalid / wrong_lock_pubkey / proof_pending were recognised and
    // the rest collapsed to `payment_insufficient`, so an agent hitting an
    // accumulator rejection had neither the real reason nor anything to relay.
    it("preserves an accumulator rejection code and its copy on submit", async () => {
      mockFetch(402, {
        error: "invalid_token",
        message: "Token could not be decoded.",
        display: "The payment token couldn't be read. Nothing was charged.",
        hint: "The token was malformed or from an unsupported mint. Send a valid token.",
        retryable: false,
        mints: ["https://mint.example.com"],
      });
      const t = new HttpsTransport();
      await expect(
        t.submit(provider, { input: "hi" }, { cashuToken: "tok" })
      ).rejects.toMatchObject({
        code: "invalid_token",
        message: "Token could not be decoded.",
        hint: "The token was malformed or from an unsupported mint. Send a valid token.",
        data: {
          display: "The payment token couldn't be read. Nothing was charged.",
          retryable: false,
        },
      });
    });

    it("preserves a retryable payment code on submit", async () => {
      mockFetch(402, {
        error: "mint_unreachable",
        message: "Mint did not respond to checkstate.",
        display: "The payment couldn't be confirmed because the mint didn't respond.",
        hint: "The mint was unreachable or returned an invalid response; retry in a few seconds.",
        retryable: true,
      });
      const t = new HttpsTransport();
      await expect(
        t.submit(provider, { input: "hi" }, { cashuToken: "tok" })
      ).rejects.toMatchObject({ code: "mint_unreachable", data: { retryable: true } });
    });

    it("does not invent trusted prose from a provider-controlled payment code", async () => {
      mockFetch(402, { error: "wrong_lock_pubkey", message: "rotated" });
      const t = new HttpsTransport();
      await expect(
        t.submit(provider, { input: "hi" }, { cashuToken: "tok" })
      ).rejects.toMatchObject({
        code: "wrong_lock_pubkey",
        message: "rotated",
        hint: undefined,
        proseSources: { message: "provider" },
      });
    });

    it("passes AbortSignal to fetch when timeoutMs is set", async () => {
      mockFetch(200, { job_id: "j1", summary: "ok" });
      const t = new HttpsTransport();
      await t.submit(provider, { input: "hi" }, undefined, { timeoutMs: 5000 });
      const call = vi.mocked(fetch).mock.calls[0];
      const init = call[1] ?? {};
      expect(init).toHaveProperty("signal");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("does not pass AbortSignal when timeoutMs is absent", async () => {
      mockFetch(200, { job_id: "j1", summary: "ok" });
      const t = new HttpsTransport();
      await t.submit(provider, { input: "hi" });
      const call = vi.mocked(fetch).mock.calls[0];
      const init = call[1] ?? {};
      expect(init.signal).toBeUndefined();
    });

    it("throws DvmError('timeout') when submit fetch is aborted", async () => {
      const abortError = new DOMException("The operation was aborted", "AbortError");
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(abortError))
      );
      const t = new HttpsTransport();
      try {
        await t.submit(provider, { input: "hi" }, undefined, { timeoutMs: 50 });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("timeout");
      }
    });

    it("throws DvmError('provider_unreachable') when the submit connection dies", async () => {
      // `fetch` reports a refused/reset connection as a bare TypeError. It used
      // to propagate raw, so a paid submit that died below the timeout got
      // neither the retry-once nor the `spend_committed` annotation — the two
      // things standing between a lost connection and a stranded spend.
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new TypeError("fetch failed")))
      );
      const t = new HttpsTransport();
      try {
        await t.submit(provider, { input: "hi" }, { cashuToken: "tok" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("provider_unreachable");
      }
    });

    it("surfaces the signed receipt on a completed submit", async () => {
      mockFetch(200, { job_id: "j1", summary: "done", receipt: RECEIPT });
      const t = new HttpsTransport();
      expect((await t.submit(provider, { input: "hi" })).receipt).toEqual(RECEIPT);
    });

    it("marks an offered receipt missing a required field as unparseable", async () => {
      const { dvm_id: _missing, ...preShapeChangeReceipt } = RECEIPT;
      mockFetch(200, { job_id: "j1", summary: "done", receipt: preShapeChangeReceipt });
      const t = new HttpsTransport();
      const result = await t.submit(provider, { input: "hi" });
      expect(result).toMatchObject({
        receiptParseError: "shape_invalid",
      });
      expect(result).not.toHaveProperty("receipt");
    });

    it("carries no receipt on a 202 — the job is not terminal yet", async () => {
      mockFetch(202, { job_id: "j1", estimated_seconds: 30 });
      const t = new HttpsTransport();
      expect((await t.submit(provider, { input: "hi" })).receipt).toBeUndefined();
    });

    it("surfaces invalid_input when /v1/job returns invalid_input", async () => {
      mockFetch(400, {
        error: "invalid_input",
        message: "missing required field 'url'",
        hint: "See /v1/info for the schema.",
      });
      const t = new HttpsTransport();
      try {
        await t.submit(provider, { input: "hi" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("invalid_input");
        expect((e as DvmError).hint).toBe("See /v1/info for the schema.");
      }
    });

    // The payment rails' flat 503 envelope
    // (`{ error: "<code>", message, hint, display, retryable }`)
    // surfaces the DVM's code, display, hint and retryable as structured
    // fields rather than a stringified `provider_error` body.
    it("surfaces a flat typed 503 envelope as a structured DvmError", async () => {
      mockFetch(503, {
        error: "fx_rate_unavailable",
        message: "BTC/USD rate unavailable",
        hint: "Retry in a few seconds.",
        display: "We couldn't price this right now — try again shortly.",
        retryable: true,
      });
      const t = new HttpsTransport();
      try {
        await t.submit(provider, { input: "hi" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        const err = e as DvmError;
        expect(err.code).toBe("fx_rate_unavailable");
        expect(err.hint).toBe("Retry in a few seconds.");
        expect(err.data?.display).toBe("We couldn't price this right now — try again shortly.");
        expect(err.data?.retryable).toBe(true);
        expect(err.proseSources).toEqual({
          message: "provider",
          display: "provider",
          hint: "provider",
        });
      }
    });

    it("marks prose from an unknown provider code the same way", async () => {
      mockFetch(503, {
        error: "third_party_custom_refusal",
        message: "Custom provider message.",
        display: "Custom provider display.",
        hint: "Custom provider hint.",
      });
      const t = new HttpsTransport();

      await expect(t.submit(provider, { input: "hi" })).rejects.toMatchObject({
        code: "third_party_custom_refusal",
        proseSources: {
          message: "provider",
          display: "provider",
          hint: "provider",
        },
      });
    });

    // An unstructured 5xx body (HTML, plain text) has no envelope to lift, so
    // it stays a generic `provider_error` — the fallback is preserved.
    it("keeps provider_error for an unstructured 5xx body", async () => {
      mockFetch(502, "<html><body>502 Bad Gateway</body></html>");
      const t = new HttpsTransport();
      try {
        await t.submit(provider, { input: "hi" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DvmError);
        expect((e as DvmError).code).toBe("provider_error");
        expect((e as DvmError).proseSources).toEqual({ message: "provider" });
      }
    });
  });

  describe("requestResult", () => {
    it("posts only the freshly signed request body and parses the original job", async () => {
      mockFetch(200, {
        request_id: "request-1",
        job_id: "job-original",
        job_token: "job-token-original",
        status: "completed",
        summary: "done",
        transaction_hash: `0x${"ab".repeat(32)}`,
        receipt: { ...RECEIPT, job_id: "job-original" },
      });
      const t = new HttpsTransport();
      const result = await t.requestResult(provider, "request-1", {
        input: "",
        capability: "count",
        data: { request_id: "request-1", signature: "fresh-signature" },
      });

      expect(result).toMatchObject({
        jobId: "job-original",
        jobToken: "job-token-original",
        status: "completed",
        transactionHash: `0x${"ab".repeat(32)}`,
        receipt: { ...RECEIPT, job_id: "job-original" },
      });
      expect(fetch).toHaveBeenCalledWith(
        "https://dvm.example.com/v1/request-result/request-1",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "Content-Type": "application/json" }),
        })
      );
      const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
      expect(String(init.body)).toContain("fresh-signature");
      expect(String(init.body)).not.toContain("cashu_token");
      expect(String(init.body)).not.toContain("x402_payment");
      expect(String(init.body)).not.toContain("tempo_credential");
    });

    it("preserves unknown/not-found without inventing a failure or job", async () => {
      mockFetch(404, {
        error: "request_not_found",
        status: "unknown",
        request_id: "missing-id",
        message: "No matching accepted request is recorded.",
      });
      const t = new HttpsTransport();
      await expect(
        t.requestResult(provider, "missing-id", {
          input: "",
          capability: "count",
          data: { request_id: "missing-id", signature: "fresh-signature" },
        })
      ).rejects.toMatchObject({
        code: "request_not_found",
        data: { status: "unknown", request_id: "missing-id" },
      });
    });

    it.each([
      ["echoed request id", { request_id: "other" }],
      ["job id", { job_id: "" }],
      ["status", { status: "mystery" }],
      ["job token", { job_token: "bad\ntoken" }],
      ["transaction hash", { transaction_hash: "0x1234" }],
      ["receipt shape", { receipt: { ...RECEIPT, job_id: "job-original", signature: "short" } }],
      ["receipt job binding", { receipt: RECEIPT }],
    ])("rejects a malformed %s as unknown before it can be persisted", async (_field, patch) => {
      mockFetch(200, {
        request_id: "request-1",
        job_id: "job-original",
        status: "completed",
        ...patch,
      });
      const t = new HttpsTransport();
      await expect(
        t.requestResult(provider, "request-1", {
          input: "",
          capability: "count",
          data: { request_id: "request-1", signature: "fresh-signature" },
        })
      ).rejects.toMatchObject({
        code: "request_outcome_unknown",
        data: { request_id: "request-1", status: "unknown" },
      });
    });
  });

  describe("requestResume", () => {
    it("posts only the freshly signed body to the dedicated route", async () => {
      mockFetch(202, { status: "processing" });
      const t = new HttpsTransport();

      await t.requestResume(provider, "request-1", {
        input: "",
        capability: "count",
        data: { request_id: "request-1", signature: "fresh-signature" },
      });

      expect(fetch).toHaveBeenCalledWith(
        "https://dvm.example.com/v1/request-resume/request-1",
        expect.objectContaining({ method: "POST" })
      );
      const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
      expect(init.headers).toEqual(expect.objectContaining({ "Content-Type": "application/json" }));
      expect(String(init.body)).toContain("fresh-signature");
      expect(String(init.body)).not.toContain("cashu_token");
      expect(String(init.body)).not.toContain("x402_payment");
      expect(String(init.body)).not.toContain("tempo_credential");
      expect(JSON.stringify(init.headers)).not.toMatch(/authorization|x-payment|x-cashu/i);
    });

    it("preserves the server's no-acceptance refusal without retrying submit", async () => {
      mockFetch(409, {
        error: "request_not_accepted",
        request_id: "request-1",
        message: "No committed server acceptance is available.",
        server_acceptance: "absent",
        payment_state: "unknown",
      });
      const t = new HttpsTransport();

      await expect(
        t.requestResume(provider, "request-1", {
          input: "",
          capability: "count",
          data: { request_id: "request-1", signature: "fresh-signature" },
        })
      ).rejects.toMatchObject({
        code: "request_not_accepted",
        data: {
          request_id: "request-1",
          server_acceptance: "absent",
          payment_state: "unknown",
        },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("status", () => {
    it("returns completed status", async () => {
      mockFetch(
        200,
        { status: "completed", summary: "done" },
        { "X-Cashu-Change": "change_token" }
      );
      const t = new HttpsTransport();
      const s = await t.status("j1", provider);
      expect(s.status).toBe("completed");
      expect(s.summary).toBe("done");
      expect(s.cashuChange).toBe("change_token");
    });

    it("throws on 404", async () => {
      mockFetch(404, "Not found");
      const t = new HttpsTransport();
      await expect(t.status("j1", provider)).rejects.toThrow(DvmError);
    });

    it("throws when no provider endpoint", async () => {
      const t = new HttpsTransport();
      await expect(t.status("j1")).rejects.toThrow(DvmError);
    });

    it("surfaces the signed receipt — the recovery capture point", async () => {
      mockFetch(200, { status: "completed", summary: "done", receipt: RECEIPT });
      const t = new HttpsTransport();
      expect((await t.status("j1", provider)).receipt).toEqual(RECEIPT);
    });

    it("keeps a malformed offered receipt distinct from no receipt", async () => {
      const { dvm_id: _missing, ...preShapeChangeReceipt } = RECEIPT;
      mockFetch(200, { status: "completed", summary: "done", receipt: preShapeChangeReceipt });

      const result = await new HttpsTransport().status("j1", provider);
      expect(result).toMatchObject({
        receiptParseError: "shape_invalid",
      });
      expect(result).not.toHaveProperty("receipt");
    });
  });

  describe("getMessages", () => {
    it("fetches messages from /v1/job/:id/messages", async () => {
      const msgs = [
        { seq: 1, from: "provider", timestamp: 1000, type: "text", content: { text: "hello" } },
        { seq: 2, from: "provider", timestamp: 1001, type: "text", content: { text: "world" } },
      ];
      mockFetch(200, { messages: msgs });
      const t = new HttpsTransport();
      const result = await t.getMessages("j1", 0, provider);
      expect(result).toHaveLength(2);
      expect(result[0].seq).toBe(1);
      expect(result[1].content).toEqual({ text: "world" });
    });

    it("passes after parameter in URL", async () => {
      mockFetch(200, { messages: [] });
      const t = new HttpsTransport();
      await t.getMessages("j1", 5, provider);
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toContain("after=5");
    });

    it("throws when no provider endpoint", async () => {
      const t = new HttpsTransport();
      await expect(t.getMessages("j1", 0)).rejects.toThrow(DvmError);
    });

    it("throws on error response", async () => {
      mockFetch(500, "Internal Server Error");
      const t = new HttpsTransport();
      await expect(t.getMessages("j1", 0, provider)).rejects.toThrow(DvmError);
    });
  });

  describe("sendMessage", () => {
    it("POSTs message to /v1/job/:id/messages", async () => {
      mockFetch(200, {});
      const t = new HttpsTransport();
      await t.sendMessage("j1", { type: "text", content: { text: "hi" } }, provider);

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("https://dvm.example.com/v1/job/j1/messages");
      expect(fetchCall[1]?.method).toBe("POST");
      const body = JSON.parse((fetchCall[1] as { body: string }).body);
      expect(body.type).toBe("text");
      expect(body.content.text).toBe("hi");
    });

    it("throws when no provider endpoint", async () => {
      const t = new HttpsTransport();
      await expect(t.sendMessage("j1", { type: "text", content: { text: "hi" } })).rejects.toThrow(
        DvmError
      );
    });

    it("throws on error response", async () => {
      mockFetch(500, "Internal Server Error");
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "text", content: { text: "hi" } }, provider)
      ).rejects.toThrow(DvmError);
    });

    // A mid-job pay that races the job going terminal gets a 409.
    // Map it to a structured error with a `dvm messages` hint so an agent
    // following a stale next_action self-recovers instead of seeing a raw 409.
    it("surfaces 409 job-terminal as a structured DvmError with a recovery hint", async () => {
      mockFetch(409, { error: "Job is no longer active" });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({
        code: "job_terminal",
        hint: expect.stringContaining("dvm messages j1"),
      });
    });

    // The structured terminal-job body takes the same mapping — only a
    // payment envelope diverts off it.
    it("surfaces the structured job_not_active 409 as job_terminal too", async () => {
      mockFetch(409, {
        error: "job_not_active",
        message: "Job already reached a terminal status and no longer accepts messages.",
        hint: "The job is finished — fetch results with GET /v1/job/:id/messages.",
      });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({ code: "job_terminal" });
    });

    // The accumulator 409s a replayed mid-job payment while the job
    // is still live and still waiting to be paid. Reporting `job_terminal`
    // there told the agent to abandon a running job.
    it("surfaces a 409 replay_rejected as the DVM's own code, not job_terminal", async () => {
      mockFetch(409, {
        error: "replay_rejected",
        message: "Request id already recorded for this DVM.",
        display: "This payment was already submitted, so it wasn't charged again.",
        hint: "Don't re-send this payment — the proofs already landed under this request id. Only a genuinely new charge needs a fresh token and request id.",
        retryable: false,
      });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({
        code: "replay_rejected",
        hint: "Don't re-send this payment — the proofs already landed under this request id. Only a genuinely new charge needs a fresh token and request id.",
        data: {
          display: "This payment was already submitted, so it wasn't charged again.",
          retryable: false,
        },
      });
    });

    // Surface the SDK's structured 402 codes so the responder's
    // agent-wallet retry policy can key on the transient codes /
    // `wrong_lock_pubkey` for mid-job pays the way it does upfront.
    it("surfaces 402 payment_invalid as a structured DvmError", async () => {
      mockFetch(402, { error: "payment_invalid", message: "bad spend" });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({ code: "payment_invalid", message: "bad spend" });
    });

    // A rejected payment now carries display/hint/retryable end to
    // end — the SDK builds them via `paymentErrorBody`, the transport lifts them
    // into the DvmError so an agent can relay `display` verbatim and branch on
    // `retryable` without string-matching `message`.
    it("carries display/hint/retryable from a 402 payment_invalid through to the DvmError", async () => {
      mockFetch(402, {
        error: "payment_invalid",
        message: "x402 verification error",
        display:
          "The payment couldn't be verified, so the request wasn't accepted. Nothing was charged.",
        hint: "Request a fresh quote and pay again — the previous payment can't be reused.",
        retryable: false,
      });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({
        code: "payment_invalid",
        message: "x402 verification error",
        hint: "Request a fresh quote and pay again — the previous payment can't be reused.",
        data: {
          display:
            "The payment couldn't be verified, so the request wasn't accepted. Nothing was charged.",
          retryable: false,
        },
      });
    });

    it("surfaces 402 wrong_lock_pubkey as a structured DvmError", async () => {
      mockFetch(402, { error: "wrong_lock_pubkey", message: "rotated" });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({ code: "wrong_lock_pubkey" });
    });

    it("surfaces 402 proof_pending as a structured DvmError", async () => {
      mockFetch(402, { error: "proof_pending", message: "settling" });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({ code: "proof_pending" });
    });

    // The mid-job path used to collapse every code outside the
    // three-entry allowlist to `payment_insufficient`. It no longer allowlists
    // at all — whatever the DVM named is what the caller branches on.
    it("preserves an accumulator rejection code and its copy on sendMessage", async () => {
      mockFetch(402, {
        error: "proof_not_unspent",
        message: "Proof already spent at the mint.",
        display: "The payment token has already been spent. Nothing was charged.",
        hint: "Those funds are gone; pay with a fresh token.",
        retryable: false,
      });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({
        code: "proof_not_unspent",
        message: "Proof already spent at the mint.",
        hint: "Those funds are gone; pay with a fresh token.",
        data: {
          display: "The payment token has already been spent. Nothing was charged.",
          retryable: false,
        },
      });
    });

    it("leaves a missing provider hint absent on a legacy 402 body", async () => {
      mockFetch(402, { error: "proof_pending", message: "settling" });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({
        code: "proof_pending",
        hint: undefined,
        proseSources: { message: "provider" },
      });
    });

    it("uses payment_insufficient only when the 402 body names no code", async () => {
      mockFetch(402, { message: "nope" });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "payment", content: { cashu_token: "x" } }, provider)
      ).rejects.toMatchObject({ code: "payment_insufficient", message: "nope" });
    });

    // A typed 503 on the mid-job message path also survives as
    // structured fields — the new parse sits below the 402/409 special cases.
    it("surfaces a typed 503 envelope as a structured DvmError", async () => {
      mockFetch(503, {
        error: "fx_rate_unavailable",
        display: "Pricing is briefly unavailable.",
        hint: "Retry shortly.",
        retryable: true,
      });
      const t = new HttpsTransport();
      await expect(
        t.sendMessage("j1", { type: "text", content: { text: "hi" } }, provider)
      ).rejects.toMatchObject({
        code: "fx_rate_unavailable",
        hint: "Retry shortly.",
        data: { display: "Pricing is briefly unavailable.", retryable: true },
      });
    });
  });

  describe("cancel", () => {
    it("sends DELETE to /v1/job/:id", async () => {
      mockFetch(200, {});
      const t = new HttpsTransport();
      await t.cancel("j1", "no longer needed", provider);

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("https://dvm.example.com/v1/job/j1");
      expect(fetchCall[1]?.method).toBe("DELETE");
      const body = JSON.parse((fetchCall[1] as { body: string }).body);
      expect(body.reason).toBe("no longer needed");
    });

    it("sends DELETE without body when no reason", async () => {
      mockFetch(200, {});
      const t = new HttpsTransport();
      await t.cancel("j1", undefined, provider);

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect((fetchCall[1] as { body: string }).body).toBeUndefined();
    });

    it("throws when no provider endpoint", async () => {
      const t = new HttpsTransport();
      await expect(t.cancel("j1", "reason")).rejects.toThrow(DvmError);
    });

    it("throws on error response", async () => {
      mockFetch(500, "Internal Server Error");
      const t = new HttpsTransport();
      await expect(t.cancel("j1", "reason", provider)).rejects.toThrow(DvmError);
    });
  });

  describe("stream", () => {
    it("falls back to JSON when server responds with application/json instead of SSE", async () => {
      const msgs = [
        { seq: 1, from: "provider", timestamp: 1000, type: "text", content: { text: "scraped" } },
        {
          seq: 2,
          from: "provider",
          timestamp: 1001,
          type: "complete",
          content: { summary: "done" },
        },
      ];
      mockFetch(200, { messages: msgs }, { "content-type": "application/json" });
      const t = new HttpsTransport();
      const onMessage = vi.fn();
      const result = await t.stream("j1", 0, provider, { onMessage });
      expect(result.messages).toHaveLength(2);
      expect(result.reason).toBe("complete");
      expect(onMessage).toHaveBeenCalledTimes(2);
    });

    it("returns yield reason when last message is not terminal", async () => {
      const msgs = [
        { seq: 1, from: "provider", timestamp: 1000, type: "text", content: { text: "hi" } },
      ];
      mockFetch(200, { messages: msgs }, { "content-type": "application/json" });
      const t = new HttpsTransport();
      const result = await t.stream("j1", 0, provider);
      expect(result.reason).toBe("yield");
    });

    it("throws when no provider endpoint", async () => {
      const t = new HttpsTransport();
      await expect(t.stream("j1", 0)).rejects.toThrow(DvmError);
    });

    it("throws on error response", async () => {
      mockFetch(500, "Internal Server Error");
      const t = new HttpsTransport();
      await expect(t.stream("j1", 0, provider)).rejects.toThrow(DvmError);
    });
  });

  describe("job-credential 401", () => {
    // A read with no `X-Job-Token` now answers 401 with copy that says what's
    // missing. The transport has to carry the DVM's own code plus the
    // `hint`/`display` through — collapsing it into `provider_error` is what
    // left the 2026-06-29 incident undiagnosable from the caller's side.
    // Reachable from a current CLI: `loadJob(...)?.jobToken` is routinely
    // undefined for a job whose local state was never written.
    const CREDENTIAL_401 = {
      error: "job_credential_required",
      message: "This job requires the X-Job-Token returned by POST /v1/job.",
      display: "Couldn't retrieve your result — the request was missing its job credential.",
      hint: "Send the job_token from the POST /v1/job response as the X-Job-Token header.",
    };

    function expectCredentialError(err: unknown): void {
      expect(err).toBeInstanceOf(DvmError);
      const e = err as DvmError;
      expect(e.code).toBe("job_credential_required");
      expect(e.hint).toBe(CREDENTIAL_401.hint);
      expect(e.data?.display).toBe(CREDENTIAL_401.display);
    }

    it("surfaces the structured body on status / getMessages / stream / cancel", async () => {
      const t = new HttpsTransport();
      mockFetch(401, CREDENTIAL_401);
      await t.status("j1", provider).catch(expectCredentialError);
      mockFetch(401, CREDENTIAL_401);
      await t.getMessages("j1", 0, provider).catch(expectCredentialError);
      mockFetch(401, CREDENTIAL_401);
      await t.stream("j1", 0, provider).catch(expectCredentialError);
      mockFetch(401, CREDENTIAL_401);
      await t.cancel("j1", undefined, provider).catch(expectCredentialError);
      expect.assertions(16);
    });

    it("leaves an unstructured job-not-found 404 alone — its body is prose, not a machine code", async () => {
      // `{"error":"Job not found"}` would parse into a DvmError whose `code`
      // is the sentence, which is why the structured branch is 401-only.
      mockFetch(404, { error: "Job not found" });
      const t = new HttpsTransport();
      await expect(t.status("j1", provider)).rejects.toMatchObject({ code: "job_not_found" });
      mockFetch(404, { error: "Job not found" });
      await expect(t.getMessages("j1", 0, provider)).rejects.toMatchObject({
        code: "provider_error",
      });
    });
  });
});

describe("credit surfaces", () => {
  const MENU = {
    min_micro: 100_000,
    max_micro: 5_000_000,
    ttl_ms: 2_592_000_000,
    currency: "usd",
    funding: ["cashu"],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces the funding menu on the synthetic 402 quote", async () => {
    mockFetch(402, { error: "payment_required", required_msats: 5000, credit: MENU });
    const t = new HttpsTransport();
    const receipt = await t.submit(provider, { input: "x" });
    expect(receipt.status).toBe("payment-required");
    expect(receipt.quotes?.[0].credit).toEqual(MENU);
  });

  it("drops a partial menu block rather than surfacing it", async () => {
    mockFetch(402, {
      error: "payment_required",
      required_msats: 5000,
      credit: { min_micro: 100_000 },
    });
    const t = new HttpsTransport();
    const receipt = await t.submit(provider, { input: "x" });
    expect(receipt.quotes?.[0].credit).toBeUndefined();
  });

  it("insufficient_credit throws with the micro context + menu on data", async () => {
    mockFetch(402, {
      error: "insufficient_credit",
      message: "too low",
      display: "The prepaid balance is too low.",
      retryable: true,
      credit_id: "c1",
      remaining_micro: 50_000,
      shortfall_micro: 25_000,
      balance_micro: 60_000,
      credit: MENU,
    });
    const t = new HttpsTransport();
    await expect(t.submit(provider, { input: "x" })).rejects.toMatchObject({
      code: "insufficient_credit",
      data: {
        credit_id: "c1",
        remaining_micro: 50_000,
        shortfall_micro: 25_000,
        balance_micro: 60_000,
        credit: MENU,
        retryable: true,
      },
    });
  });

  it("funding_commitment_mismatch carries expected_micro onto data", async () => {
    // `buildStructuredError` drops unknown fields by default, so without the
    // re-attach the correction belt is left regexing a `message` the protocol
    // declares non-contractual.
    mockFetch(402, {
      error: "funding_commitment_mismatch",
      message: "fund.amount_micro (4800) does not match … at the quoted price (4761).",
      display: "The attached payment doesn't match the signed funding commitment.",
      retryable: false,
      expected_micro: 4_761,
    });
    const t = new HttpsTransport();
    await expect(t.submit(provider, { input: "x" })).rejects.toMatchObject({
      code: "funding_commitment_mismatch",
      data: { expected_micro: 4_761 },
    });
  });

  it("credit() posts the signed body with payment headers and returns the op result", async () => {
    const body = {
      op: "fund",
      funded_micro: 200_000,
      replayed: false,
      credit: {
        credit_id: "c1",
        currency: "usd",
        balance_micro: 200_000,
        remaining_micro: 200_000,
        expiry_ms: 1,
        expired: false,
        drainable: true,
        ledger_seq: 1,
      },
    };
    mockFetch(200, body);
    const t = new HttpsTransport();
    const result = await t.credit(
      provider,
      { op: "fund", pubkey: "aa" },
      { cashuToken: "cashuB...", cashuRequestId: "rid-1" }
    );
    expect(result).toEqual(body);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("https://dvm.example.com/v1/credit");
    const init = call[1];
    expect((init?.headers as Record<string, string>)["X-Cashu"]).toBe("cashuB...");
    expect((init?.headers as Record<string, string>)["X-Cashu-Request-Id"]).toBe("rid-1");
    expect(init?.body).toBe(JSON.stringify({ op: "fund", pubkey: "aa" }));
  });

  it("credit() preserves the batch acknowledgement header for caller state", async () => {
    mockFetch(200, { op: "fund" }, { "PAYMENT-RESPONSE": "settled-header" });
    await expect(new HttpsTransport().credit(provider, { op: "fund" })).resolves.toMatchObject({
      x402PaymentResponse: "settled-header",
    });
  });

  it("credit() decodes a batch PAYMENT-REQUIRED header onto structured errors", async () => {
    const required: PaymentRequiredV2 = {
      x402Version: 2,
      resource: { url: `${provider.endpoint}/v1/credit` },
      accepts: [
        {
          scheme: "batch-settlement",
          network: "eip155:84532",
          amount: "100000",
          asset: `0x${"11".repeat(20)}`,
          payTo: `0x${"22".repeat(20)}`,
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    };
    mockFetch(
      402,
      { error: "payment_required", message: "Sign a channel voucher." },
      { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) }
    );
    const err = await new HttpsTransport()
      .credit(provider, { op: "fund" })
      .catch((error: unknown) => error);
    expect(err).toMatchObject({
      code: "payment_required",
      data: { x402_payment_required: required },
    });
  });

  it("credit() lifts a v1 body challenge onto structured errors", async () => {
    const required = {
      x402Version: 1 as const,
      accepts: [
        {
          scheme: "exact" as const,
          network: "base",
          maxAmountRequired: "100000",
          resource: `${provider.endpoint}/v1/credit`,
          description: "Fund prepaid credit.",
          mimeType: "application/json",
          asset: `0x${"11".repeat(20)}`,
          payTo: `0x${"22".repeat(20)}`,
          maxTimeoutSeconds: 60,
        },
      ],
    };
    mockFetch(402, {
      error: "payment_required",
      message: "Sign an exact payment.",
      ...required,
    });

    const err = await new HttpsTransport()
      .credit(provider, { op: "fund" })
      .catch((error: unknown) => error);

    expect(err).toMatchObject({
      code: "payment_required",
      data: { x402_payment_required: required },
    });
  });

  it("credit() sends a journaled MPP credential verbatim", async () => {
    mockFetch(200, { op: "fund", funded_micro: 100_000, replayed: false });
    const t = new HttpsTransport();
    await t.credit(
      provider,
      { op: "fund", pubkey: "aa" },
      { mppCredentialRaw: "Payment durable-credential" }
    );
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Payment durable-credential");
  });

  it("credit() returns a well-formed balance menu with or without a Lightning floor", async () => {
    for (const menu of [MENU, { ...MENU, lightning_min_micro: 57_500 }]) {
      mockFetch(200, { op: "balance", credits: [], menu });
      const result = await new HttpsTransport().credit(provider, { op: "balance" });
      expect(result.menu).toEqual(menu);
    }
  });

  it("credit() drops malformed balance menus before they reach callers", async () => {
    for (const menu of [
      { ...MENU, min_micro: "100000" },
      { ...MENU, lightning_min_micro: "57500" },
    ]) {
      mockFetch(200, { op: "balance", credits: [], menu });
      const result = await new HttpsTransport().credit(provider, { op: "balance" });
      expect(result).not.toHaveProperty("menu");
    }
  });

  it("credit() surfaces a structured refusal with its context fields", async () => {
    mockFetch(400, {
      error: "credit_over_max",
      message: "over max",
      fundable_micro: 120_000,
    });
    const t = new HttpsTransport();
    await expect(t.credit(provider, { op: "fund" })).rejects.toMatchObject({
      code: "credit_over_max",
      data: { fundable_micro: 120_000 },
    });
  });

  // A Lightning funding's bolt11 only ever arrives on a 402, so
  // `buildStructuredError`'s unknown-field drop would otherwise throw away the
  // one thing the float exists to pay.
  it("credit() carries a lightning funding offer off the pending 402", async () => {
    const lightning = {
      invoice: "lnbcrt1000n1stub",
      payment_hash: "ab".repeat(32),
      amount_msats: 100_000,
      expires_at_ms: 1_800_000_000_000,
    };
    mockFetch(402, {
      error: "lightning_settlement_pending",
      message: "Pay the invoice.",
      credit_id: "c1",
      fund_id: "f1",
      lightning,
    });
    const t = new HttpsTransport();
    await expect(t.credit(provider, { op: "fund" })).rejects.toMatchObject({
      code: "lightning_settlement_pending",
      data: { lightning, credit_id: "c1", fund_id: "f1" },
    });
  });

  it("credit() drops a lightning block with no payable invoice", async () => {
    mockFetch(402, {
      error: "lightning_settlement_pending",
      message: "Pay the invoice.",
      lightning: { payment_hash: "ab".repeat(32), expires_at_ms: 1 },
    });
    const t = new HttpsTransport();
    // Surfacing it would hand the float a bolt11 of `undefined` to pay for an
    // amount of `undefined` — a malformed provider, not a degraded one.
    const err = await t.credit(provider, { op: "fund" }).catch((e: unknown) => e);
    expect((err as { data?: Record<string, unknown> }).data?.lightning).toBeUndefined();
  });

  it("credit() names the rail a bound credit refused a cross-rail top-up on", async () => {
    mockFetch(400, {
      error: "payment_invalid",
      message: "bound to lightning",
      credit_rail: "lightning",
    });
    const t = new HttpsTransport();
    await expect(t.credit(provider, { op: "fund" })).rejects.toMatchObject({
      code: "payment_invalid",
      data: { credit_rail: "lightning" },
    });
  });

  it("credit() preserves the instrument and channel a terminal refusal names", async () => {
    mockFetch(409, {
      error: "payment_invalid",
      message: "bound to a Tempo session",
      credit_rail: "tempo",
      credit_instrument: "tempo_session",
      credit_channel_id: `0x${"ab".repeat(32)}`,
      bound_credit_id: "credit-1",
      retryable: false,
    });
    const t = new HttpsTransport();
    await expect(t.credit(provider, { op: "fund" })).rejects.toMatchObject({
      code: "payment_invalid",
      data: {
        credit_rail: "tempo",
        credit_instrument: "tempo_session",
        credit_channel_id: `0x${"ab".repeat(32)}`,
        bound_credit_id: "credit-1",
        retryable: false,
      },
    });
  });

  // The two drain booleans answer different questions — whether a
  // drain row exists for the id just posted, and whether that id can ever be
  // posted again. Both have to survive the unknown-field drop, or the caller's
  // write-off recovery reads a bare `drain_conflict` and re-posts the dead id.
  it("credit() carries both drain booleans off a terminal refusal", async () => {
    mockFetch(409, {
      error: "drain_conflict",
      message: "x402 cooperative refund refused: settlement_written_off.",
      drain_id_retired: true,
    });
    const t = new HttpsTransport();
    await expect(t.credit(provider, { op: "drain" })).rejects.toMatchObject({
      code: "drain_conflict",
      data: { drain_id_retired: true },
    });

    // And the id that refusal admits rides with them — without it
    // the caller adopts nothing and mints a fresh drain into the same gate.
    mockFetch(409, {
      error: "settlement_pending",
      message: "an earlier reclaim is still being finalized",
      drain_registered: true,
      settlement_drain_id: "wedged-drain",
    });
    const still = await t.credit(provider, { op: "drain" }).catch((e: unknown) => e);
    expect(still).toMatchObject({
      code: "settlement_pending",
      data: { drain_registered: true, settlement_drain_id: "wedged-drain" },
    });
    expect((still as DvmError).data?.drain_id_retired).toBeUndefined();
  });

  // An expired Tempo close credential is safe to replace only when
  // the server explicitly binds a fresh challenge to the existing drain. The
  // transport used to drop both fields while preserving the challenge, so the
  // CLI correctly refused to refresh and left the cooperative reclaim stuck.
  it("credit() carries the explicit Tempo close-refresh authorization", async () => {
    mockFetch(402, {
      error: "payment_invalid",
      message: "The saved Tempo session close credential is no longer valid.",
      credential_refresh_required: true,
      drain_registered: true,
      drain_id: "saved-drain",
      retryable: true,
    });
    const t = new HttpsTransport();
    await expect(t.credit(provider, { op: "drain" })).rejects.toMatchObject({
      code: "payment_invalid",
      data: {
        credential_refresh_required: true,
        drain_registered: true,
        drain_id: "saved-drain",
        retryable: true,
      },
    });
  });
});
