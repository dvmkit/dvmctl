import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const DVM_ID = "550e8400-e29b-41d4-a716-446655440000";
const cli = join(process.cwd(), "dist/dvmctl.js");

function runCli(context, args, platformUrl = "http://127.0.0.1:1") {
  const root = mkdtempSync(join(tmpdir(), "dvmctl-visibility-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        HOME: root,
        DVMCTL_CONFIG_DIR: root,
        DVMKIT_CONFIG_DIR: root,
        DVM_CONFIG_DIR: root,
        DVMKIT_API_KEY: "test-key",
        DVMKIT_PLATFORM_URL: platformUrl,
      },
      timeout: 15_000,
    }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
  });
}

test("visibility help exposes both choices and org selection", async (context) => {
  const result = await runCli(context, ["visibility", "--help"]);
  assert.equal(result.status, 0);
  for (const option of ["--hidden", "--listed", "--org", "--human"]) {
    assert.ok(result.stdout.includes(option));
  }
});

for (const flags of [[], ["--hidden", "--listed"]]) {
  test(`visibility rejects invalid choices before contacting the platform: ${flags.join(" ") || "none"}`, async (context) => {
    const result = await runCli(context, ["visibility", "my-dvm", ...flags]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "bad_request");
  });
}

test("built CLI maps visibility flags to authenticated requests and serializes role errors", async (context) => {
  const requests = [];
  let deny = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/api/v1/builder/dvms?org=my-org") {
        res.end(JSON.stringify({
          dvms: [{ id: DVM_ID, slug: "my-dvm", dvmkitUrl: null }],
          org: { id: "org-1", handle: "my-org", role: "admin", personal: false },
        }));
      } else if (req.method === "PUT" && req.url === `/api/v1/builder/dvms/${DVM_ID}/visibility`) {
        if (deny) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: { code: "forbidden", message: "Forbidden" } }));
        } else {
          res.end(JSON.stringify({ slug: "my-dvm", hidden: JSON.parse(body).hidden }));
        }
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const platformUrl = `http://127.0.0.1:${server.address().port}`;

  for (const [flag, hidden] of [["--hidden", true], ["--listed", false]]) {
    const result = await runCli(context, ["visibility", "my-dvm", flag, "--org", "my-org"], platformUrl);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.slug, "my-dvm");
    assert.equal(output.hidden, hidden);
    const request = requests.at(-1);
    assert.equal(request.method, "PUT");
    assert.equal(request.path, `/api/v1/builder/dvms/${DVM_ID}/visibility`);
    assert.equal(request.headers.authorization, "Bearer test-key");
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(request.body), { hidden });
  }

  deny = true;
  const result = await runCli(context, ["visibility", "my-dvm", "--hidden", "--org", "my-org"], platformUrl);
  assert.equal(result.status, 1);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.code, "forbidden");
  assert.match(error.hint, /admin.*org/i);
  assert.equal(requests.length, 6);
});
