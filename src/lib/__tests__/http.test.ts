import { afterEach, describe, expect, it } from "vitest";

import {
  DECODABLE_ACCEPT_ENCODING,
  installGlobalAcceptEncoding,
  withDecodableAcceptEncoding,
} from "../http";

interface MarkedFetch {
  __dvmkitAcceptEncodingPatched?: boolean;
}

function acceptEncodingOf(init: Parameters<typeof fetch>[1]): string | null {
  return new Headers(init?.headers).get("accept-encoding");
}

describe("withDecodableAcceptEncoding", () => {
  it("pins a decodable Accept-Encoding when the caller sets none", () => {
    expect(acceptEncodingOf(withDecodableAcceptEncoding("https://x.example/v1/info"))).toBe(
      DECODABLE_ACCEPT_ENCODING
    );
  });

  it("preserves the caller's other headers, method, and body while adding Accept-Encoding", () => {
    const out = withDecodableAcceptEncoding("https://x.example/v1/job", {
      method: "POST",
      headers: { "X-Cashu": "tokenABC", "Content-Type": "application/json" },
      body: "{}",
    });
    const h = new Headers(out?.headers);
    expect(h.get("x-cashu")).toBe("tokenABC");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("accept-encoding")).toBe(DECODABLE_ACCEPT_ENCODING);
    expect(out?.method).toBe("POST");
    expect(out?.body).toBe("{}");
  });

  it("does not override an explicit Accept-Encoding from init", () => {
    const out = withDecodableAcceptEncoding("https://x.example/v1/info", {
      headers: { "Accept-Encoding": "identity" },
    });
    expect(acceptEncodingOf(out)).toBe("identity");
  });

  it("inherits an Accept-Encoding carried by a Request input when init omits headers", () => {
    const req = new Request("https://x.example/v1/info", {
      headers: { "accept-encoding": "identity" },
    });
    expect(acceptEncodingOf(withDecodableAcceptEncoding(req))).toBe("identity");
  });
});

describe("installGlobalAcceptEncoding", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("wraps global fetch once and is idempotent", () => {
    expect((globalThis.fetch as MarkedFetch).__dvmkitAcceptEncodingPatched).toBeUndefined();

    installGlobalAcceptEncoding();
    const patched = globalThis.fetch;
    expect((patched as MarkedFetch).__dvmkitAcceptEncodingPatched).toBe(true);

    installGlobalAcceptEncoding();
    expect(globalThis.fetch).toBe(patched);
  });
});
