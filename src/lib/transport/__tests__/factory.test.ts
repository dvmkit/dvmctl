import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDvmTransport } from "../index";

const provider = { endpoint: "https://dvm.example.com" };

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ name: "T" })),
        json: () => Promise.resolve({ name: "T" }),
        headers: { get: () => null },
      })
    )
  );
}

describe("createDvmTransport", () => {
  beforeEach(() => {
    mockFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends no auth headers", async () => {
    await createDvmTransport().describe(provider);
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const init = fetchCall[1] as { headers?: Record<string, string> } | undefined;
    // The only header describe() carries is the transport's default
    // Accept-Encoding (see src/lib/http.ts) — never auth material.
    const nonEncodingHeaders = Object.keys(init?.headers ?? {}).filter(
      (name) => name.toLowerCase() !== "accept-encoding"
    );
    expect(nonEncodingHeaders).toEqual([]);
  });
});
