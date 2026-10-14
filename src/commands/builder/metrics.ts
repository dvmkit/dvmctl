import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface MetricsOptions {
  hours?: string;
  human?: boolean;
  org?: string;
}

export async function metrics(slug: string, opts: MetricsOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const hours = opts.hours ? Number(opts.hours) : 24;
  const result = await platformClient.getMetrics(platformUrl, token, dvmId, hours);

  if (opts.human) {
    if (result.length === 0) {
      info(`No metrics for "${slug}" in the last ${hours} hours.`);
      return;
    }

    let total = 0;
    let ok = 0;
    let clientErr = 0;
    let serverErr = 0;
    let latencyMs = 0;
    for (const m of result) {
      total += m.totalRequests;
      ok += m.status2xx;
      clientErr += m.status4xx;
      serverErr += m.status5xx;
      latencyMs += m.totalLatencyMs;
    }

    const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) : "0.0");
    const avgLatency = total > 0 ? Math.round(latencyMs / total) : 0;

    info(`  Last ${hours} hours:`);
    info(`    Total requests:   ${total.toLocaleString()}`);
    info(`    Success (2xx):    ${ok.toLocaleString()} (${pct(ok)}%)`);
    info(`    Client err (4xx): ${clientErr.toLocaleString()} (${pct(clientErr)}%)`);
    info(`    Server err (5xx): ${serverErr.toLocaleString()} (${pct(serverErr)}%)`);
    info(`    Avg latency:      ${avgLatency}ms`);
  } else {
    json({ dvmId, slug, hours, metrics: result });
  }
}
