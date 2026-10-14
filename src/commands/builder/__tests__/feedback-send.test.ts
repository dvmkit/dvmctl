import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({ requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })), resolveOrgScope: vi.fn(() => "team") }));
vi.mock("../../../lib/platform-client", () => ({ sendBuilderFeedback: vi.fn(async () => ({ id: "feedback-1", created_at: "2026-09-29T12:00:00Z", display: "Sent to the dvmkit team." })) }));
vi.mock("../../../lib/builder-feedback-nudges", async (importOriginal) => ({ ...await importOriginal<typeof import("../../../lib/builder-feedback-nudges")>(), lastFeedbackPrompt: vi.fn(() => ({ command: "deploy", error_code: "deploy_failed", trigger: "failure", trace_id: "trace-1" })), feedbackPosture: vi.fn(() => ({ posture: "ask", source: "default" })), setFeedbackPosture: vi.fn() }));
vi.mock("../../../shared/output", () => ({ info: vi.fn(), json: vi.fn() }));
vi.mock("../../../shared/builder-store", () => ({ findBuilderDvmsByHandle: vi.fn(() => []) }));

import { requireAuth } from "../../../lib/platform";
import { sendBuilderFeedback } from "../../../lib/platform-client";
import { json } from "../../../shared/output";
import { findBuilderDvmsByHandle } from "../../../shared/builder-store";
import { lastFeedbackPrompt } from "../../../lib/builder-feedback-nudges";
import { create } from "../create";
import { feedbackSend } from "../feedback-send";

const originalCwd = process.cwd();
let projectDir: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lastFeedbackPrompt).mockReturnValue({ command: "deploy", error_code: "deploy_failed", trigger: "failure", trace_id: "trace-1" });
  vi.mocked(findBuilderDvmsByHandle).mockReturnValue([]);
});
afterEach(() => {
  process.chdir(originalCwd);
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  projectDir = undefined;
  vi.unstubAllEnvs();
});

describe("builder feedback send", () => {
  it("rejects more than 4096 UTF-8 bytes before authentication or network I/O", async () => {
    await expect(feedbackSend("é".repeat(2049), {})).rejects.toMatchObject({ code: "feedback_body_invalid" });
    expect(requireAuth).not.toHaveBeenCalled();
    expect(sendBuilderFeedback).not.toHaveBeenCalled();
  });
  it("reports only an installed public SDK version and never attributes another project's DVM", async () => {
    projectDir = mkdtempSync(join(tmpdir(), "feedback-project-"));
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "other-dvm", dvmkit: {}, dependencies: { "@dvmkit/sdk": "git+ssh://private.example/secret-token" } }));
    mkdirSync(join(projectDir, "node_modules", "@dvmkit", "sdk"), { recursive: true });
    writeFileSync(join(projectDir, "node_modules", "@dvmkit", "sdk", "package.json"), JSON.stringify({ name: "@dvmkit/sdk", version: "0.6.0-rc.1" }));
    process.chdir(projectDir);
    await feedbackSend("Project feedback", {});
    const request = vi.mocked(sendBuilderFeedback).mock.calls[0][2];
    expect(request.context?.sdk_version).toBe("0.6.0-rc.1");
    expect(request.context?.dvm_id).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("private.example");
    expect(findBuilderDvmsByHandle).toHaveBeenCalledWith("other-dvm");
  });
  it("reports the installed SDK version from a generated DVM project", async () => {
    projectDir = mkdtempSync(join(tmpdir(), "feedback-scaffold-"));
    const generatedDir = join(projectDir, "generated-dvm");
    await create(generatedDir, { description: "Generated project" });
    mkdirSync(join(generatedDir, "node_modules", "@dvmkit", "sdk"), { recursive: true });
    writeFileSync(join(generatedDir, "node_modules", "@dvmkit", "sdk", "package.json"), JSON.stringify({ name: "@dvmkit/sdk", version: "0.6.0-rc.1" }));
    process.chdir(generatedDir);

    await feedbackSend("Project feedback", { trace: "deploy-trace" });
    const request = vi.mocked(sendBuilderFeedback).mock.calls[0][2];
    expect(request.trace_id).toBe("deploy-trace");
    expect(request.context?.sdk_version).toBe("0.6.0-rc.1");
  });
  it("uses a first-deploy ID only with its trace and the same generated project", async () => {
    projectDir = mkdtempSync(join(tmpdir(), "feedback-identity-"));
    const first = join(projectDir, "first", "service");
    const second = join(projectDir, "second", "service");
    await create(first, { description: "First DVM" });
    await create(second, { description: "Second DVM" });
    vi.mocked(lastFeedbackPrompt).mockReturnValue({ command: "deploy", trigger: "first_deploy", dvm_id: "first-id", trace_id: "deploy-trace", project_key: createHash("sha256").update(realpathSync.native(first)).digest("hex") });

    process.chdir(first);
    await feedbackSend("First project", { trace: "deploy-trace" });
    expect(vi.mocked(sendBuilderFeedback).mock.calls[0][2].context?.dvm_id).toBe("first-id");
    expect(JSON.stringify(vi.mocked(sendBuilderFeedback).mock.calls[0][2])).not.toContain("project_key");

    await feedbackSend("Unrelated trace", { trace: "other-trace" });
    expect(vi.mocked(sendBuilderFeedback).mock.calls[1][2].context?.dvm_id).toBeUndefined();

    process.chdir(second);
    await feedbackSend("Second project", { trace: "deploy-trace" });
    expect(vi.mocked(sendBuilderFeedback).mock.calls[2][2].context?.dvm_id).toBeUndefined();
  });
  it("uses one local DVM identity but omits an ambiguous handle", async () => {
    projectDir = mkdtempSync(join(tmpdir(), "feedback-store-"));
    const generatedDir = join(projectDir, "service");
    await create(generatedDir, { description: "Generated project" });
    process.chdir(generatedDir);
    const first = { handle: "service", canonical_dvm_id: "first-id", current_rotation_index: 0, updated_at: "2026-09-29T12:00:00Z" };
    vi.mocked(findBuilderDvmsByHandle).mockReturnValue([first]);

    await feedbackSend("Project feedback", {});
    expect(vi.mocked(sendBuilderFeedback).mock.calls[0][2].context?.dvm_id).toBe("first-id");

    vi.mocked(findBuilderDvmsByHandle).mockReturnValue([first, { ...first, canonical_dvm_id: "second-id" }]);
    await feedbackSend("Project feedback", {});
    expect(vi.mocked(sendBuilderFeedback).mock.calls[1][2].context?.dvm_id).toBeUndefined();
  });
  it("omits a DVM ID when the matching prompt conflicts with the local store", async () => {
    projectDir = mkdtempSync(join(tmpdir(), "feedback-conflict-"));
    const generatedDir = join(projectDir, "service");
    await create(generatedDir, { description: "Generated project" });
    process.chdir(generatedDir);
    vi.mocked(lastFeedbackPrompt).mockReturnValue({ command: "deploy", trigger: "first_deploy", dvm_id: "prompt-id", trace_id: "deploy-trace", project_key: createHash("sha256").update(realpathSync.native(generatedDir)).digest("hex") });
    vi.mocked(findBuilderDvmsByHandle).mockReturnValue([{ handle: "service", canonical_dvm_id: "other-id", current_rotation_index: 0, updated_at: "2026-09-29T12:00:00Z" }]);

    await feedbackSend("Project feedback", { trace: "deploy-trace" });
    expect(vi.mocked(sendBuilderFeedback).mock.calls[0][2].context?.dvm_id).toBeUndefined();
  });
  it("omits SDK metadata from a directory that is not a DVM project", async () => {
    projectDir = mkdtempSync(join(tmpdir(), "feedback-nonproject-"));
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "other" }));
    mkdirSync(join(projectDir, "node_modules", "@dvmkit", "sdk"), { recursive: true });
    writeFileSync(join(projectDir, "node_modules", "@dvmkit", "sdk", "package.json"), JSON.stringify({ name: "@dvmkit/sdk", version: "0.6.0-rc.1" }));
    process.chdir(projectDir);
    await feedbackSend("General feedback", {});
    const request = vi.mocked(sendBuilderFeedback).mock.calls[0][2];
    expect(request.context?.sdk_version).toBeUndefined();
    expect(request.context?.dvm_id).toBeUndefined();
  });
  it("sends the selected body and a bounded context through the platform contract", async () => {
    vi.stubEnv("SECRET_TOKEN", "must-never-send");
    await feedbackSend("The deploy failed", { trace: "explicit-trace" });
    expect(sendBuilderFeedback).toHaveBeenCalledOnce();
    const [url, token, request, org] = vi.mocked(sendBuilderFeedback).mock.calls[0];
    expect([url, token, org]).toEqual(["https://platform.example", "tok", "team"]);
    expect(request).toMatchObject({ body: "The deploy failed", trace_id: "explicit-trace", context: { command: "deploy", error_code: "deploy_failed", trigger: "failure" } });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("must-never-send");
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ id: "feedback-1", display: "Sent to the dvmkit team." }));
  });
});
