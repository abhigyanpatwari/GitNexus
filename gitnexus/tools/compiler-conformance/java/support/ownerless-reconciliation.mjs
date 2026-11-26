import { reconcileOwnership as original } from '../../../../dist/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js';
import { probeOwnership } from '../../../../test/helpers/ownerless-registry-probe.ts';
export { validateOwnershipParity } from '../../../../dist/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js';

export const probe = { legacy: true, registrations: 0, reads: 0 };
export const reconcileOwnership = probeOwnership(original, probe);
