import type { DVMDescriptor, ZodLike } from "@dvmkit/sdk";
import { createDVMHost, type DVMHostOpts, type DVMHost } from "@dvmkit/sdk/server";

import { SDK_VERSION } from "./version.ts";

export function createDevHost(
  descriptor: DVMDescriptor<unknown, ZodLike | undefined>,
  opts: DVMHostOpts
): DVMHost {
  const host = createDVMHost(opts);
  // Register before mount so the SDK's existing dev page remains the responder.
  host.app.use("/_dev", async (context, next) => {
    await next();
    if (context.res.status !== 200 || !context.res.headers.get("content-type")?.startsWith("text/html")) return;
    const html = await context.res.text();
    const notice = `<p data-dvmctl-sdk>Serving @dvmkit/sdk ${SDK_VERSION} (dvmctl's pinned SDK)</p>`;
    const headers = new Headers(context.res.headers);
    context.res = new Response(html.replace("</h1>", `</h1>\n${notice}`), { status: context.res.status, headers });
    context.res.headers.delete("content-length");
  });
  host.mount(descriptor);
  return host;
}
