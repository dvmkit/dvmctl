# Agent guidance

Load `.agents/skills/public-readme/SKILL.md` before changing README.md or a root community file.

Keep comments when they explain a constraint, reason, unit, lifecycle, compatibility promise, or API behavior that code alone does not show. Remove narration, stale history, review provenance, and boilerplate. Keep functional JavaScript JSDoc types, licenses, and tooling directives. Public or exported status alone does not require JSDoc.

Write tests for a meaningful production failure or an independently specified contract. Exercise the production behavior at the cheapest boundary that catches the failure. Mock external dependencies, not the behavior under test. **No tautological tests:** do not assert a fixture against itself, language behavior, implementation spelling, prose, or mock output alone. Do not calculate an expected result with the same implementation without an independent contract. Round trips, idempotence and retry/replay properties remain valid when a production defect can violate them.

Before adding, changing, or auditing tests, read [.agents/skills/test-audit/SKILL.md](.agents/skills/test-audit/SKILL.md).

Source guards are appropriate when a source property is the architecture contract. When adding or changing a guard, include a deliberately invalid example it must reject. Keep release, security, cleanup, recovery, lifecycle, and package-boundary coverage. Before removing a test, identify the retained test that covers each distinct failure, or record that the removed assertion had no meaningful contract. There is no deletion quota. Prose/comment-only and other reversible low-impact edits need no new tests merely because a file changed; required gates still apply. Do not add tests that only pin this guidance. Claims that an observable failure cannot happen require a test reaching that failure; otherwise narrow the claim.

This repository owns the authoritative builder CLI source, behavioral tests, and releases. Author changes directly in `src/` and keep the corresponding behavior tests beside the implementation. There is no private-source export or generated source mirror. Consume shared runtime behavior through declared packages and platform behavior through the service contract; do not add dependencies on another repository checkout.

Preserve both source behavior coverage and the `node:test` package, installed-consumer, and release safeguards. Run `npm run test:source -- <path>` for focused behavior checks and `npm run test:package` for artifact checks after building. `npm run verify` runs both suites with build, lint, and typecheck. Do not add package exports solely to reach code in tests.

Run the repository verification after the last substantive edit. Do not publish from local development. Commit only files belonging to the change, with a public-safe Conventional Commit subject.
