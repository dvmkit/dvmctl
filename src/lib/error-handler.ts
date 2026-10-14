import { asProviderText, DvmError } from "@dvmkit/sdk/internal";

import { info, json } from "../shared/output.ts";
import { feedbackHumanHint, feedbackNudge } from "./builder-feedback-nudges.ts";
import { isPlatformError } from "./platform-error-tag.ts";
import { takeFeedbackNoticeFields } from "./feedback-notice.ts";

/**
 * Catch errors from a command action and exit the process when the command
 * finishes.
 *
 * The explicit `process.exit` is here because NWC keeps persistent websocket
 * connections to its relays that prevent Node's event loop from draining —
 * without an explicit exit the CLI would print its output and then hang
 * indefinitely. The OS reaps the open sockets and any pending timers for us on
 * exit, while an exit code already selected by the command is preserved.
 */
export function catchErrors(fn: () => void | Promise<void>, human?: boolean): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(
        () => {
          const hint = feedbackHumanHint();
          if (hint) info(hint);
          process.exit(process.exitCode ?? 0);
        },
        (err: unknown) => handleError(err, human)
      );
    } else {
      const hint = feedbackHumanHint();
      if (hint) info(hint);
    }
  } catch (err) {
    handleError(err, human);
  }
}

/**
 * Format an error and exit. Used by the CLI error boundary.
 *
 * The feedback-notice sink drains here because the sync failed arc reports
 * failure by throwing; its nudge must accompany that terminal JSON emission.
 * Nothing stashes a nudge outside a job-terminal moment, so the spread is
 * empty on other errors.
 *
 * Human mode doesn't drain: the prose already went to stderr when the notice
 * was stashed.
 */
export function handleError(err: unknown, human?: boolean): never {
  if (err instanceof DvmError) {
    const nudge = feedbackNudge({ failed: true, platformError: isPlatformError(err), errorCode: err.code });
    if (human) {
      // JSON spreads `data` last, so its relay fields are authoritative when
      // an error also uses the older positional `display`. Resolve human mode
      // the same way, including the human-directed next step carried only in
      // `data`, so the two renderings cannot drift (tracked change, tracked change).
      const dataDisplay = err.data?.display;
      const display = typeof dataDisplay === "string" ? dataDisplay : err.display;
      const dataNextStep = err.data?.next_step;
      const nextStep = typeof dataNextStep === "string" ? dataNextStep : undefined;
      info([`Error: ${err.message}`, display, nextStep, err.hint, nudge.feedback_hint].filter(Boolean).join("\n"));
    } else {
      const error: Record<string, unknown> = {
        code: err.code,
        message: err.message,
        ...(err.display ? { display: err.display } : {}),
        ...(err.hint ? { hint: err.hint } : {}),
        ...(err.data ?? {}),
      };
      for (const field of ["message", "display", "hint"] as const) {
        const value = error[field];
        if (err.proseSources?.[field] === "provider" && typeof value === "string") {
          error[field] = asProviderText(value);
        }
      }
      json({
        error,
        ...takeFeedbackNoticeFields(),
        ...nudge,
      });
    }
    process.exit(1);
  }

  // Unknown errors may come from any dependency. Their messages are unbounded
  // third-party content, so publish only a bounded class/code fingerprint.
  const nudge = feedbackNudge({ failed: true, errorCode: "internal" });
  const diagnostic = unknownErrorDiagnostic(err);
  const message = `An unexpected internal error occurred (${diagnostic.label}).`;
  if (human) {
    info([`Error: ${message}`, nudge.feedback_hint].filter(Boolean).join("\n"));
  } else {
    json({
      error: {
        code: "internal",
        message,
        error_name: diagnostic.name,
        ...(diagnostic.code ? { error_code: diagnostic.code } : {}),
      },
      ...takeFeedbackNoticeFields(),
      ...nudge,
    });
  }
  process.exit(1);
}

function unknownErrorDiagnostic(err: unknown): { name: string; code?: string; label: string } {
  const name = unknownErrorName(err);
  const code = unknownErrorCode(err);
  return { name, ...(code ? { code } : {}), label: code ? `${name}:${code}` : name };
}

function unknownErrorName(err: unknown): string {
  if (!(err instanceof Error)) return `thrown_${typeof err}`;
  try {
    const prototype = Object.getPrototypeOf(err) as { constructor?: unknown } | null;
    const constructor = prototype?.constructor;
    const name = typeof constructor === "function" ? constructor.name : "";
    return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

function unknownErrorCode(err: unknown): string | undefined {
  if ((typeof err !== "object" && typeof err !== "function") || err === null) return undefined;
  try {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && /^E[A-Z0-9_]{1,31}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
