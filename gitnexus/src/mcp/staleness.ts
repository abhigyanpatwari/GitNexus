/**
 * Staleness Check — re-export from core (see `core/git-staleness.ts` and
 * `core/staleness-status.ts`).
 */

export type { StalenessInfo, StalenessPayload, StalenessStatus } from '../core/staleness-status.js';
export { checkStaleness } from '../core/git-staleness.js';
export { stalenessPayload, stalenessStatus } from '../core/staleness-status.js';
