import { t } from './i18n/index.js';
import {
  formatSlotSize,
  type StaleBranchReason,
  type StaleBranchSlot,
} from '../storage/stale-branch-slots.js';

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
  }
};

export const formatStaleSlotLine = (slot: StaleBranchSlot): string =>
  t('clean.stale.item', {
    branch: slot.branch,
    reason: staleReasonLabel(slot.reason),
    path: slot.dir ?? '(registry only)',
    size: formatSlotSize(slot.sizeBytes),
  });
