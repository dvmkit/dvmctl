import { requireAuth, resolveOrgScope } from "../../lib/platform.ts";
import { getBuilderTrace } from "../../lib/platform-client.ts";
import { renderTrace } from "../../lib/render-trace.ts";
import { info, json } from "../../shared/output.ts";

export interface TraceGetOptions {
  human?: boolean;
  color?: boolean;
  /** Org handle to read as, overriding the `dvmctl switch` context. */
  org?: string;
}

export async function traceGet(traceId: string, opts: TraceGetOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const result = await getBuilderTrace(platformUrl, token, traceId, {
    org: resolveOrgScope(opts),
  });

  if (opts.human) {
    const useColor = opts.color !== false && process.stdout.isTTY;
    info(renderTrace(result, { color: useColor }));
  } else {
    json(result);
  }
}
