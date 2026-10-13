/**
 * Feedback nudges — the words and the sink.
 *
 * The copy rules are requirements, not style: the nudge is read by an agent
 * that will relay and act on it, so "offers rather than instructs", "no CLI
 * persona", and "names the concrete win" are pinned here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as output from "../../shared/output";
import {
  buildFeedbackHint,
  buildFeedbackNudge,
  noteFeedbackHint,
  noteFeedbackNudge,
  resetFeedbackNotices,
  takeFeedbackNoticeFields,
} from "../feedback-notice";

vi.mock("../../shared/output", () => ({ info: vi.fn() }));

const DVM = "dvmkit--scribe";
const JOB = "job_abc123";

function nudge(overrides: Partial<Parameters<typeof buildFeedbackNudge>[0]> = {}) {
  return buildFeedbackNudge({
    code: "feedback_job_failed",
    dvmId: DVM,
    jobId: JOB,
    approval: "ask",
    postureSource: "default",
    ...overrides,
  });
}

beforeEach(() => {
  resetFeedbackNotices();
});

describe("buildFeedbackNudge", () => {
  it("carries the machine block beside the relayable prose", () => {
    const n = nudge();
    expect(n).toMatchObject({
      code: "feedback_job_failed",
      dvm_id: DVM,
      job_id: JOB,
      approval: "ask",
      posture_source: "default",
      command: `dvm feedback --job ${JOB}`,
    });
    expect(n.display).toBeTruthy();
    expect(n.hint).toBeTruthy();
    expect(n.intro).toBeUndefined();
  });

  it.each(["feedback_job_failed", "feedback_first_success"] as const)(
    "meets every copy requirement (%s)",
    (code) => {
      const n = nudge({ code, intro: true });
      const copy = `${n.display} ${n.hint} ${n.intro ?? ""}`;

      // Names the concrete destination without promising third-party behavior.
      expect(copy).toContain("reaches the builder");
      expect(copy).not.toMatch(/reads it|fixes/);
      // No CLI persona.
      expect(copy).not.toMatch(/\b(I|I'll|I'd|me|my|we|we'll|our)\b/);
      // Offers rather than instructs — no imperative opener on the display.
      expect(n.display).not.toMatch(/^(Run|Send|Set|Use|You should|You must)\b/);
      // Names the exact command.
      expect(copy).toContain(`dvm feedback --job ${JOB}`);
      // Coaches actionability: expected-vs-got and concrete detail.
      expect(n.hint).toMatch(/expected|what came back/i);
      expect(n.hint).toContain("concrete detail");
      expect(n.hint).toContain("versions");
    }
  );

  it("under 'ask', tells the agent to summarize the substance and get a yes first", () => {
    const n = nudge({ approval: "ask" });
    expect(n.hint).toContain("substance");
    expect(n.hint).toContain("get a yes before running the command");
  });

  it("under 'auto', says no approval is needed instead of demanding one", () => {
    const n = nudge({ approval: "auto" });
    expect(n.approval).toBe("auto");
    expect(n.hint).not.toContain("get a yes");
    expect(n.hint).toContain("'auto'");
  });

  it("failed hint says to skip sending when the failure was the request's own input", () => {
    const n = nudge({ code: "feedback_job_failed" });
    expect(n.hint).toContain("own bad input");
    expect(n.hint).toContain("skip");
    // The first-success hint carries no such rider.
    expect(nudge({ code: "feedback_first_success" }).hint).not.toContain("bad input");
  });

  it("intro names the default, all three postures, and (under ask) the relay instruction", () => {
    const ask = nudge({ intro: true, approval: "ask" });
    expect(ask.intro).toContain("on by default");
    expect(ask.intro).toContain("--posture ask");
    expect(ask.intro).toContain("--posture auto");
    expect(ask.intro).toContain("--posture off");
    expect(ask.intro).toContain("Relay these options");

    const auto = nudge({ intro: true, approval: "auto" });
    expect(auto.intro).toContain("on by default");
    expect(auto.intro).not.toContain("Relay these options");
  });

  it("shell-quotes the job id into the command", () => {
    const n = nudge({ jobId: "job; echo $HOME" });
    expect(n.command).toBe("dvm feedback --job 'job; echo $HOME'");
  });
});

describe("buildFeedbackHint", () => {
  it("is about a dozen words, offers, and names the exact command", () => {
    const hint = buildFeedbackHint(JOB);
    expect(hint).toBe(`Fell short? 'dvm feedback --job ${JOB}' reaches the builder.`);
    // Short enough to ride every successful terminal without weight.
    expect(hint.split(/\s+/).length).toBeLessThanOrEqual(12);
    // Offers, and promises no third-party behavior.
    expect(hint).not.toMatch(/reads it|fixes/);
    expect(hint).not.toMatch(/\b(I|me|my|we|our)\b/);
  });
});

describe("the deferred sink", () => {
  it("noteFeedbackNudge prints prose to stderr in both modes and stashes only in JSON mode", () => {
    const n = nudge();
    noteFeedbackNudge(n, true);
    expect(output.info).toHaveBeenCalledWith(`${n.display} ${n.hint}`);
    expect(takeFeedbackNoticeFields()).toEqual({});

    noteFeedbackNudge(n);
    expect(takeFeedbackNoticeFields()).toEqual({ feedback_nudge: n });
  });

  it("noteFeedbackHint never prints — the micro-nudge is agent-facing only", () => {
    noteFeedbackHint(buildFeedbackHint(JOB));
    expect(output.info).not.toHaveBeenCalled();
    expect(takeFeedbackNoticeFields()).toEqual({ feedback_hint: buildFeedbackHint(JOB) });

    noteFeedbackHint(buildFeedbackHint(JOB), true);
    expect(takeFeedbackNoticeFields()).toEqual({});
  });

  it("a second nudge replaces the first, and take clears", () => {
    const first = nudge();
    const second = nudge({ code: "feedback_first_success" });
    noteFeedbackNudge(first);
    noteFeedbackNudge(second);
    expect(takeFeedbackNoticeFields()).toEqual({ feedback_nudge: second });
    // Cleared: a second terminal emission spreads nothing.
    expect(takeFeedbackNoticeFields()).toEqual({});
  });

  it("resetFeedbackNotices drops without emitting", () => {
    noteFeedbackNudge(nudge());
    resetFeedbackNotices();
    expect(takeFeedbackNoticeFields()).toEqual({});
  });
});
