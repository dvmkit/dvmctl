/**
 * The test budget for suites that spend nearly all of their wall-clock in fork/exec rather
 * than in the code under test.
 *
 * Applied per suite — or per test, where only part of a file spawns — rather than as a
 * global `testTimeout`, which would hand the same 30s to every in-process test in the repo,
 * where 5s is still the sensor we want. Reach for the narrowest scope that covers the
 * spawning tests and leave the rest of the file on the default.
 *
 * Size from measured fork/exec work and an observed contention multiplier. Keep fixed
 * waits separate: they do not scale by that multiplier. Compare the resulting cost with
 * the deadline for the test or hook being sized.
 *
 * Hooks are separate. Vitest's 10s `hookTimeout` does not inherit a test or `describe`
 * timeout, so a spawn-heavy `beforeEach` / `beforeAll` needs its own narrow budget as the
 * final argument (for example, `beforeEach(setup, SPAWN_HEAVY_TIMEOUT)`). Size it from the
 * hook's measured work using that method, but compare with 10s instead of the default test's
 * 5s. Hoist immutable fixture construction first where cases can safely share it; leave a
 * hook on the default when the remaining setup lands comfortably below that threshold.
 *
 */
export const SPAWN_HEAVY_TIMEOUT = 30_000;
