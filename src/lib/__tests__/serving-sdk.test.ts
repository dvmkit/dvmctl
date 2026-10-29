import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as output from "../../shared/output.ts";
import { projectSdkVersion, warnSdkMismatch } from "../serving-sdk.ts";
import { SDK_VERSION } from "../version.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dvmctl-sdk-version-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function install(directory: string, version: unknown, name = "@dvmkit/sdk"): void {
  const manifest = join(directory, "node_modules/@dvmkit/sdk/package.json");
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ name, version }));
}

it("reports the nearest installed SDK rather than a declared range or the caller's cwd", () => {
  install(root, "0.15.0");
  const project = join(root, "packages/service");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "@dvmkit/sdk": "^0.12.0" } }));
  install(project, "0.16.1");
  expect(projectSdkVersion(join(project, "src/handler.ts"))).toBe("0.16.1");
});

it("finds a workspace-hoisted installation", () => {
  install(root, "0.16.1");
  expect(projectSdkVersion(join(root, "packages/service/src/handler.ts"))).toBe("0.16.1");
});

it("reads a linked SDK installation", () => {
  const target = join(root, "linked-sdk");
  mkdirSync(target);
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@dvmkit/sdk", version: "0.16.1" }));
  mkdirSync(join(root, "node_modules/@dvmkit"), { recursive: true });
  symlinkSync(target, join(root, "node_modules/@dvmkit/sdk"), "junction");
  expect(projectSdkVersion(join(root, "handler.ts"))).toBe("0.16.1");
});

it.each([
  { version: "0.16.1\nforged diagnostic", name: "@dvmkit/sdk" },
  { version: 16, name: "@dvmkit/sdk" },
  { version: "0.16.1", name: "other-package" },
])("does not report invalid package metadata: %j", ({ version, name }) => {
  install(root, version, name);
  expect(projectSdkVersion(join(root, "handler.ts"))).toBeUndefined();
});

it("tolerates missing and malformed installations", () => {
  const handler = join(root, "handler.ts");
  expect(projectSdkVersion(handler)).toBeUndefined();
  install(root, "0.16.1");
  writeFileSync(join(root, "node_modules/@dvmkit/sdk/package.json"), "{");
  expect(projectSdkVersion(handler)).toBeUndefined();
});

it("warns with both versions when the installed project SDK differs", () => {
  const info = vi.spyOn(output, "info").mockImplementation(() => {});
  install(root, "0.16.1");
  warnSdkMismatch(join(root, "handler.ts"));
  expect(info).toHaveBeenCalledOnce();
  expect(info.mock.calls[0][0]).toContain(`dvmctl serves with @dvmkit/sdk ${SDK_VERSION}`);
  expect(info.mock.calls[0][0]).toContain("project has @dvmkit/sdk 0.16.1 installed");
});

it("does not warn for matching or uninstalled SDKs", () => {
  const info = vi.spyOn(output, "info").mockImplementation(() => {});
  const handler = join(root, "handler.ts");
  warnSdkMismatch(handler);
  install(root, SDK_VERSION);
  warnSdkMismatch(handler);
  expect(info).not.toHaveBeenCalled();
});
