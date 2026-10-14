import { HttpsTransport } from "./https.ts";

/**
 * Build the default `HttpsTransport` for the dvm CLI — the single plug point
 * all CLI commands share so subsequent client-auth work (subscription bearer
 * tokens, tracked change) can layer in here without touching each command site.
 */
export function createDvmTransport(): HttpsTransport {
  return new HttpsTransport();
}
