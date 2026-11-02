import { t } from './i18n/index.js';
import { type StaleBranchReason, type StaleBranchSlot } from '../storage/stale-branch-slots.js';

export const formatSlotSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const staleReasonLabel = (reason: StaleBranchReason): string => {
  switch (reason) {
    case 'ref-missing':
      return t('clean.stale.reason.refMissing');
    case 'disk-only':
      return t('clean.stale.reason.diskOnly');
    case 'registry-only':
      return t('clean.stale.reason.registryOnly');
    case 'heads-unavailable':
      return t('clean.stale.reason.headsUnavailable');
    case 'probe-failed':
      return t('clean.stale.reason.probeFailed');
    case 'listing-failed':
      return t('clean.stale.reason.listingFailed');
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
};

export const formatStaleSlotLine = (slot: StaleBranchSlot): string =>
  t('clean.stale.item', {
    branch: slot.branch,
    reason: staleReasonLabel(slot.reason),
    path: slot.dir ?? t('clean.stale.registryOnlyPath'),
    size: formatSlotSize(slot.sizeBytes),
  });
