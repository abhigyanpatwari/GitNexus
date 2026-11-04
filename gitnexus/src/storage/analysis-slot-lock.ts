import path from 'node:path';
import {
  acquireIndexLock,
  requireExclusiveIndexLock,
  type AcquireOptions,
  type IndexLockHandle,
} from './index-lock.js';
import { storeRootOfCheckoutSlot } from './shared-store.js';

/** Admit branch writers under the member gate used by shared-store GC. Once
 * admitted, the branch lock protects their files without serializing siblings.
 * GC holds the gate while listing and trying branch locks, so a new branch
 * cannot start writing between that listing and deletion of its member. */
export async function acquireAnalysisSlotLock(
  directory: string,
  options: AcquireOptions = {},
): Promise<IndexLockHandle> {
  const branches = path.dirname(path.resolve(directory));
  const member = path.dirname(branches);
  if (path.basename(branches) !== 'branches' || !storeRootOfCheckoutSlot(member))
    return acquireIndexLock(directory, options);
  const gate = await acquireIndexLock(member, { ...options, sweep: false });
  try {
    requireExclusiveIndexLock(gate, `Cannot acquire the shared member gate at ${member}.`);
    return await acquireIndexLock(directory, options);
  } finally {
    gate.release();
  }
}
