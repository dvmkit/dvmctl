import { configureDVM } from "@dvmkit/sdk";
import { expect, it } from "vitest";

import { createDevHost } from "../serve-dev.ts";
import { SDK_VERSION } from "../version.ts";

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
