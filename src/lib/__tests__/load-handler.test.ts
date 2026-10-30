import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { configureDVM, type DVMDescriptor } from "@dvmkit/sdk";
import { afterAll, describe, expect, it } from "vitest";

import { isDescriptor, loadDescriptor } from "../load-handler";

describe("descriptor loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "dvm-load-handler-test-"));
  const foreignSdk = join(dir, "foreign-sdk");
  mkdirSync(foreignSdk);
  cpSync(resolve("node_modules/@dvmkit/sdk/package.json"), join(foreignSdk, "package.json"));
  cpSync(resolve("node_modules/@dvmkit/sdk/dist"), join(foreignSdk, "dist"), { recursive: true });
  symlinkSync(resolve("node_modules"), join(foreignSdk, "node_modules"), "junction");
  const foreignSdkUrl = pathToFileURL(join(foreignSdk, "dist/index.js")).href;

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

  it("returns a same-instance multi-capability descriptor unchanged", async () => {
    const configureUrl = pathToFileURL(resolve("node_modules/@dvmkit/sdk/dist/index.js")).href;
    const path = writeHandler(
      "configured-multi.ts",
      `import { configureDVM } from ${JSON.stringify(configureUrl)};
export default configureDVM({ name: "Configured multi", capabilities: { alpha: { onJob() {} }, beta: { onJob() {} } } });`
    );
    const mod = (await import(pathToFileURL(path).href)) as { default: unknown };

    expect(await loadDescriptor(path)).toBe(mod.default);
  });

  it("renormalizes a descriptor from a different SDK module instance", async () => {
    const path = writeHandler(
      "external-configured.ts",
      `import { configureDVM } from ${JSON.stringify(foreignSdkUrl)};
export default configureDVM({ name: "External configured", state: { count: 7 }, onJob() {} });`
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
      state: { count: 7 },
    });
    expect(descriptor.config.state).toEqual({ count: 7 });
    expect(descriptor.capabilities["external-configured"].state).toEqual({ count: 7 });
  });

  it("loads a foreign multi-capability descriptor without merging its state mirror", async () => {
    const path = writeHandler(
      "external-multi.ts",
      `import { configureDVM, isConfiguredDVMDescriptor, z } from ${JSON.stringify(foreignSdkUrl)};
export default configureDVM({
  name: "External multi", description: "Two handlers", tags: ["test"], idleTimeout: 60,
  capabilities: {
    alpha: { input: z.object({ text: z.string() }), example: { text: "hello" }, state: { count: 3 }, onJob(ctx) { ctx.complete(ctx.input.text); } },
    beta: { state: { count: 9 }, onJob(ctx) { ctx.complete("beta"); } }
  }
});
export { isConfiguredDVMDescriptor };`
    );
    const mod = (await import(pathToFileURL(path).href)) as {
      default: DVMDescriptor;
      isConfiguredDVMDescriptor: (value: unknown) => boolean;
    };
    expect(mod.isConfiguredDVMDescriptor(mod.default)).toBe(true);
    expect(isDescriptor(mod.default)).toBe(false);

    const descriptor = await loadDescriptor(path);

    expect(isDescriptor(descriptor)).toBe(true);
    expect(descriptor).not.toBe(mod.default);
    expect(descriptor).toMatchObject({
      name: "External multi", description: "Two handlers", tags: ["test"], idleTimeout: 60,
    });
    expect(Object.keys(descriptor.capabilities)).toEqual(["alpha", "beta"]);
    expect(descriptor.config.capabilities).toBe(mod.default.config.capabilities);
    expect(descriptor.config.state).toBeUndefined();
    expect(descriptor.capabilities.alpha.state).toEqual({ count: 3 });
    expect(descriptor.capabilities.beta.state).toEqual({ count: 9 });
    expect(descriptor.capabilities.alpha.input).toBe(mod.default.capabilities.alpha.input);
    expect(descriptor.capabilities.alpha.example).toEqual({ text: "hello" });
    expect(descriptor.capabilities.alpha.onJob).toBe(mod.default.capabilities.alpha.onJob);
    expect(descriptor.capabilities.beta.onJob).toBe(mod.default.capabilities.beta.onJob);
    expect(mod.default.state).toEqual({});
    expect(mod.default.config.state).toBeUndefined();
  });

  it("preserves top-level state on a single-capability sketch", async () => {
    const path = writeHandler(
      "state-sketch.mjs",
      `export default { name: "State sketch", state: { count: 5 }, config: { onJob() {} } };`
    );

    const descriptor = await loadDescriptor(path);

    expect(descriptor.config.state).toEqual({ count: 5 });
    expect(descriptor.capabilities["state-sketch"].state).toEqual({ count: 5 });
  });

  it.each(["state: {}", "onJob() {}", "input: {}", "price: '$0.01'"])(
    "rejects genuine flat/multi conflicts declared in config: %s",
    async (flatField) => {
      const path = writeHandler(
        `mixed-config-${flatField.split(":")[0].replace(/\W/g, "")}.mjs`,
        `export default { name: "Mixed", state: {}, capabilities: {}, config: {
  capabilities: { alpha: { onJob() {} }, beta: { onJob() {} } }, ${flatField}
} };`
      );

      await expect(loadDescriptor(path)).rejects.toThrow(/pass either the flat single-capability shape/);
    }
  );

  it("rejects flat state on a multi-capability sketch without resolved mirrors", async () => {
    const path = writeHandler(
      "mixed-sketch.mjs",
      `export default { name: "Mixed sketch", state: {}, config: { capabilities: { alpha: { onJob() {} }, beta: { onJob() {} } } } };`
    );

    await expect(loadDescriptor(path)).rejects.toThrow(/pass either the flat single-capability shape/);
  });

  it("names a missing required field when a sketch cannot be normalized", async () => {
    const path = writeHandler("missing-name.mjs", `export default { config: { onJob() {} } };`);

    await expect(loadDescriptor(path)).rejects.toThrow(/missing required "name" field/);
  });
});
