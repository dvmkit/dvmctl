import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { configureDVM } from "@dvmkit/sdk";
import { afterAll, describe, expect, it } from "vitest";

import { isDescriptor, loadDescriptor } from "../load-handler";

describe("descriptor loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "dvm-load-handler-test-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeHandler(filename: string, code: string): string {
    const path = join(dir, filename);
    writeFileSync(path, code);
    return path;
  }

  it("recognizes complete configureDVM descriptors, not incomplete sketches", () => {
    const configured = configureDVM({ name: "Configured", onJob() {} });
    const sketch = Object.freeze({ name: "Sketch", config: { onJob() {} } });

    expect(isDescriptor(configured)).toBe(true);
    expect(isDescriptor(sketch)).toBe(false);
  });

  it("normalizes a frozen incomplete descriptor sketch", async () => {
    const path = writeHandler(
      "frozen-sketch.mjs",
      `export default Object.freeze({ name: "Frozen sketch", config: { onJob() {} } });`
    );

    const descriptor = await loadDescriptor(path);

    expect(descriptor).toMatchObject({
      name: "Frozen sketch",
      description: "",
      tags: [],
      currency: "usd",
      idleTimeout: 3600,
    });
    expect(Object.keys(descriptor.capabilities)).toEqual(["frozen-sketch"]);
    expect(descriptor.config).toMatchObject({ name: "Frozen sketch" });
    expect(descriptor.config.onJob).toBeTypeOf("function");
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it("finds a named dvm sketch", async () => {
    const path = writeHandler(
      "named-sketch.mjs",
      `export const dvm = { name: "Named", tags: ["test"], config: { onJob() {} } };`
    );

    expect((await loadDescriptor(path)).name).toBe("Named");
  });

  it("auto-detects the first descriptor-shaped export", async () => {
    const path = writeHandler(
      "auto-sketch.mjs",
      `export const helper = "not a descriptor";
export const myDvm = { name: "Auto", tags: ["test"], config: { onJob() {} } };`
    );

    expect((await loadDescriptor(path)).name).toBe("Auto");
  });

  it("normalizes a multi-capability sketch without a top-level onJob", async () => {
    const path = writeHandler(
      "multi-capability.mjs",
      `export default { name: "Multi", config: { capabilities: { alpha: { onJob() {} }, beta: { onJob() {} } } } };`
    );

    expect(Object.keys((await loadDescriptor(path)).capabilities)).toEqual(["alpha", "beta"]);
  });

  it("returns a configureDVM export unchanged", async () => {
    // `load-handler` calls the installed package's `isConfiguredDVMDescriptor`,
    // so only a descriptor built by that same instance passes through untouched.
    // A descriptor from anywhere else is a *different* instance — which is what
    // the next case covers.
    const configureUrl = pathToFileURL(resolve("node_modules/@dvmkit/sdk/dist/index.js")).href;
    const path = writeHandler(
      "configured.ts",
      `import { configureDVM } from ${JSON.stringify(configureUrl)};
export default configureDVM({ name: "Configured module", onJob() {} });`
    );

    const descriptor = await loadDescriptor(path);
    const mod = (await import(pathToFileURL(path).href)) as { default: unknown };

    expect(descriptor).toBe(mod.default);
  });

  it("renormalizes a descriptor from a different SDK module instance", async () => {
    const configureUrl = pathToFileURL(resolve("node_modules/@dvmkit/sdk/dist/index.js")).href;
    // The brand is a module-scoped WeakSet keyed on object identity, so a copy
    // is exactly what a second instance of the SDK produces as far as anything
    // here can observe: same shape, absent from this instance's set.
    const path = writeHandler(
      "external-configured.ts",
      `import { configureDVM } from ${JSON.stringify(configureUrl)};
export default { ...configureDVM({ name: "External configured", onJob() {} }) };`
    );

    const descriptor = await loadDescriptor(path);
    const mod = (await import(pathToFileURL(path).href)) as { default: unknown };

    expect(descriptor).not.toBe(mod.default);
    expect(isDescriptor(mod.default)).toBe(false);
    expect(isDescriptor(descriptor)).toBe(true);
    expect(descriptor).toMatchObject({
      name: "External configured",
      description: "",
      tags: [],
      currency: "usd",
      idleTimeout: 3600,
    });
  });

  it("names a missing required field when a sketch cannot be normalized", async () => {
    const path = writeHandler("missing-name.mjs", `export default { config: { onJob() {} } };`);

    await expect(loadDescriptor(path)).rejects.toThrow(/missing required "name" field/);
  });
});
