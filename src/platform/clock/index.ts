/**
 * CLAUDE.md "Demo mode": all time comes from an injected Clock. No `new Date()`,
 * no `Date.now()`, anywhere else in src/ — an ESLint rule (eslint.config.js) fails
 * the build on either, everywhere except this file, which is the one sanctioned
 * place allowed to touch the system clock.
 */
export interface Clock {
  now(): Date;
}

/** The demo's anchor instant: 2026-07-30T12:00:00+05:00 (Asia/Karachi), as UTC. */
export const DEMO_ANCHOR = new Date("2026-07-30T07:00:00.000Z");

/** Real wall-clock time. Only ever constructed when DEMO_MODE is explicitly off. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * A settable, advanceable clock. `DEMO_MODE=true` pins it to DEMO_ANCHOR by default.
 * `advance`/`set` back the (not yet built) `POST /internal/demo/advance-clock` and
 * `POST /internal/demo/reset` endpoints from Prompt 4 — the capability lives here
 * now so that phase doesn't have to touch this module's invariants later.
 */
export class DemoClock implements Clock {
  #current: Date;

  constructor(startAt: Date = DEMO_ANCHOR) {
    this.#current = startAt;
  }

  now(): Date {
    return this.#current;
  }

  set(at: Date): void {
    this.#current = at;
  }

  advance(byMs: number): void {
    this.#current = new Date(this.#current.getTime() + byMs);
  }

  reset(): void {
    this.#current = DEMO_ANCHOR;
  }
}

/** `DEMO_MODE=true` (the default for this build) pins the clock; anything else uses the real one. */
export function createClock(env: NodeJS.ProcessEnv = process.env): Clock {
  return env["DEMO_MODE"] === "false" ? new SystemClock() : new DemoClock();
}
