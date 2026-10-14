import { describe, expect, it } from "vitest";
import { parseVmConfig, VmConfigError } from "../vm-config";
describe("parseVmConfig", () => {
  it("returns empty config for undefined/null input", () => {
    expect(parseVmConfig(undefined)).toEqual({});
    expect(parseVmConfig(null)).toEqual({});
  });

  it("returns empty config for an empty object", () => {
    expect(parseVmConfig({})).toEqual({});
  });

  it("parses snake_case keys into camelCase VmConfig", () => {
    expect(
      parseVmConfig({
        memory_mb: 1024,
        cpu_count: 2,
        cpu_kind: "shared",
        min_machines_running: 0,
        max_machines: 2,
      })
    ).toEqual({
      memoryMb: 1024,
      cpuCount: 2,
      cpuKind: "shared",
      minMachinesRunning: 0,
      maxMachines: 2,
    });
  });

  it("accepts camelCase keys (for wire-format compatibility)", () => {
    expect(parseVmConfig({ memoryMb: 1024, cpuCount: 2 })).toEqual({
      memoryMb: 1024,
      cpuCount: 2,
    });
  });

  it("accepts a partial config (only one field)", () => {
    expect(parseVmConfig({ memory_mb: 1024 })).toEqual({ memoryMb: 1024 });
  });

  it("ignores unknown keys for forward compatibility", () => {
    expect(parseVmConfig({ memory_mb: 512, gpu: true, future_field: "x" })).toEqual({
      memoryMb: 512,
    });
  });

  it("rejects non-object input (array)", () => {
    expect(() => parseVmConfig([])).toThrow(VmConfigError);
    expect(() => parseVmConfig([1, 2, 3])).toThrow(/must be an object/);
  });

  it("rejects non-object input (primitive)", () => {
    expect(() => parseVmConfig("nope")).toThrow(VmConfigError);
    expect(() => parseVmConfig(42)).toThrow(VmConfigError);
  });

  it("rejects negative memory_mb", () => {
    expect(() => parseVmConfig({ memory_mb: -1 })).toThrow(/memory_mb/);
  });

  it("rejects fractional memory_mb", () => {
    expect(() => parseVmConfig({ memory_mb: 512.5 })).toThrow(/memory_mb/);
  });

  it("rejects memory_mb below 256", () => {
    expect(() => parseVmConfig({ memory_mb: 128 })).toThrow(/memory_mb/);
  });

  it("rejects memory_mb above 16384", () => {
    expect(() => parseVmConfig({ memory_mb: 32_000 })).toThrow(/memory_mb/);
  });

  it("rejects cpu_kind not in shared|performance", () => {
    expect(() => parseVmConfig({ cpu_kind: "gpu" })).toThrow(/cpu_kind/);
  });

  it("rejects cpu_count outside 1..16", () => {
    expect(() => parseVmConfig({ cpu_count: 0 })).toThrow(/cpu_count/);
    expect(() => parseVmConfig({ cpu_count: 32 })).toThrow(/cpu_count/);
  });

  it("rejects max_machines < min_machines_running", () => {
    expect(() => parseVmConfig({ min_machines_running: 2, max_machines: 1 })).toThrow(
      /max_machines/
    );
  });

  it("checks the minimum against the default one-machine maximum", () => {
    expect(() => parseVmConfig({ min_machines_running: 40 })).toThrow(
      /`max_machines` \(1\) must be >= `min_machines_running` \(40\)/
    );
  });

  it("accepts a large minimum when it does not exceed the maximum", () => {
    expect(parseVmConfig({ min_machines_running: 40, max_machines: 40 })).toEqual({
      minMachinesRunning: 40,
      maxMachines: 40,
    });
  });

  it.each([
    [{ max_machines: 0 }, /max_machines.*1 and 100/],
    [{ max_machines: 20.5 }, /max_machines.*integer/],
    [{ max_machines: 101 }, /max_machines.*1 and 100/],
    [{ min_machines_running: 101 }, /min_machines_running.*0 and 100/],
  ])("rejects a machine declaration outside the platform range: %j", (config, message) => {
    expect(() => parseVmConfig(config)).toThrow(message);
  });

  it("throws VmConfigError with code invalid_vm_config", () => {
    try {
      parseVmConfig({ memory_mb: -1 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VmConfigError);
      expect((err as VmConfigError).code).toBe("invalid_vm_config");
    }
  });

  it("rejects both snake_case and camelCase set for the same field", () => {
    expect(() => parseVmConfig({ memory_mb: 1024, memoryMb: 2048 })).toThrow(/both set/);
  });
});
