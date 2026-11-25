import { configureDVM } from "@dvmkit/sdk";
import { expect, it } from "vitest";

import { createDevHost } from "../serve-dev.ts";
import { SDK_VERSION } from "../version.ts";

it("completes a local job after the handler wakes", async () => {
  const server = await createDevHost(configureDVM({
    name: "Watch",
    capability: "watch",
    async onJob(ctx) {
      await ctx.sleep("watch-interval", 100);
      ctx.complete("watch finished");
    },
  }), { port: 0, env: {}, devMode: true }).serve();

  try {
    const response = await fetch(`${server.url}/v1/job`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "watch", data: "check again" }),
    });
    expect(response.ok).toBe(true);
    const { job_id, job_token } = await response.json();
    await expect.poll(async () => {
      const status = await fetch(`${server.url}/v1/job/${job_id}`, {
        headers: { "x-job-token": job_token },
      });
      return status.json();
    }).toMatchObject({ status: "completed", summary: "watch finished" });
  } finally {
    await server.close();
  }
});

function host() {
  return createDevHost(configureDVM({ name: "Echo", capability: "echo", onJob() {} }), { devMode: true });
}

it("adds the serving version while preserving the SDK page and its headers", async () => {
  const { app } = host();
  const page = '<html><body><h1>Echo</h1><form id="job">Test a job</form></body></html>';
  app.get("/_dev", (context) => context.html(page, 200, { "x-page": "sdk", "content-length": String(Buffer.byteLength(page)) }));
  const response = await app.request("http://localhost/_dev");
  expect(response.status).toBe(200);
  expect(response.headers.get("x-page")).toBe("sdk");
  expect(response.headers.get("content-length")).toBeNull();
  const body = await response.text();
  expect(body).toContain(`Serving @dvmkit/sdk ${SDK_VERSION}`);
  expect(body).toContain('<h1>Echo</h1>');
  expect(body).toContain('<form id="job">Test a job</form>');
});

it.each([
  { status: 200, contentType: "application/json", body: '{"message":"ok"}' },
  { status: 503, contentType: "text/html", body: "<h1>Unavailable</h1>" },
])("leaves other routes and dev responses with $status $contentType alone", async ({ status, contentType, body }) => {
  const { app } = host();
  app.get("/other", (context) => context.html("<h1>Other</h1>"));
  app.get("/_dev", () => new Response(body, { status, headers: { "content-type": contentType } }));
  expect(await (await app.request("http://localhost/other")).text()).toBe("<h1>Other</h1>");
  const response = await app.request("http://localhost/_dev");
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(body);
});
