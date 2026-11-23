import path from 'node:path';
import {
  acquireIndexLock,
  requireExclusiveIndexLock,
  type AcquireOptions,
  type IndexLockHandle,
} from './index-lock.js';
import { storeRootOfCheckoutSlot } from './shared-store.js';
import { getGlobalDir } from './global-dir.js';

/** File-backed admission locks must outlive deletion of both member and store.
 * Keep their empty parent directories: deleting a held gate lets a second
 * process acquire a different lock at the same pathname. */
export function sharedMemberGatePath(storeRoot: string, member: string): string {
  // Store keys are unique within GITNEXUS_HOME. Keep the names as path
  // components so filesystem aliases and Windows casing share the same gate.
  return path.join(
    getGlobalDir(),
    'locks',
    'shared-members',
    path.basename(storeRoot),
    path.basename(member),
  );
}

/** Admit flat and branch writers under the member gate used by shared-store GC.
 * Once admitted, their index locks protect files without serializing siblings.
 * GC holds the persistent gate through member, graph, and store deletion. */
export async function acquireAnalysisSlotLock(
  directory: string,
  options: AcquireOptions = {},
): Promise<IndexLockHandle> {
  const slot = path.resolve(directory);
  const branches = path.dirname(slot);
  const member = path.basename(branches) === 'branches' ? path.dirname(branches) : slot;
  const storeRoot = storeRootOfCheckoutSlot(member);
  if (!storeRoot) return acquireIndexLock(directory, options);
  const gatePath = sharedMemberGatePath(storeRoot, member);
  const gate = await acquireIndexLock(gatePath, { ...options, sweep: false });
  try {
    requireExclusiveIndexLock(gate, `Cannot acquire the shared member gate at ${gatePath}.`);
    if (slot === member) return await acquireIndexLock(directory, options);
    const memberLock = await acquireIndexLock(member, { ...options, sweep: false });
    try {
      requireExclusiveIndexLock(memberLock, `Cannot acquire the shared member lock at ${member}.`);
      return await acquireIndexLock(directory, options);
    } finally {
      memberLock.release();
    }
  } finally {
    gate.release();
  }
}
