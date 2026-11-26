/**
 * The `--stale-policy` values (#3127).
 *
 * Kept free of imports on purpose: `index.ts` builds the option from these at
 * startup, and pulling in `stale-policy.ts` there would load the logger (via
 * `cli-message.ts`) before any command runs.
 */
export const STALE_POLICIES = ['warn', 'ignore', 'error'] as const;

export type StalePolicy = (typeof STALE_POLICIES)[number];

/** `warn` leaves every tool result exactly as the backend returned it. */
export const DEFAULT_STALE_POLICY: StalePolicy = 'warn';
