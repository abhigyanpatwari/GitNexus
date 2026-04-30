import { AlertTriangle } from '@/lib/lucide-icons';
import type { GroupStatus } from '../services/backend-client';

export interface GroupStatusHealth {
  hasAttention: boolean;
  affectedGroups: string[];
  contractsStaleCount: number;
  indexStaleCount: number;
  missingCount: number;
  label: string;
  title: string;
}

const countFrom = (
  status: GroupStatus,
  key: 'contractsStaleCount' | 'indexStaleCount' | 'missingCount',
  fallback: number,
): number => {
  const value = status.summary?.[key];
  return typeof value === 'number' ? value : fallback;
};

export function summarizeGroupStatuses(groupStatuses: GroupStatus[] = []): GroupStatusHealth {
  const affectedGroups: string[] = [];
  let contractsStaleCount = 0;
  let indexStaleCount = 0;
  let missingCount = 0;

  for (const status of groupStatuses) {
    const staleContracts = countFrom(
      status,
      'contractsStaleCount',
      status.contractsStaleRepos?.length ?? 0,
    );
    const staleIndexes = countFrom(status, 'indexStaleCount', status.indexStaleRepos?.length ?? 0);
    const missing = countFrom(status, 'missingCount', status.missingGroupRepos?.length ?? 0);
    const needsAttention = Boolean(
      status.summary?.actionRequired || staleContracts || staleIndexes || missing,
    );

    contractsStaleCount += staleContracts;
    indexStaleCount += staleIndexes;
    missingCount += missing;
    if (needsAttention) affectedGroups.push(status.group);
  }

  const hasAttention = affectedGroups.length > 0;
  const label =
    contractsStaleCount > 0
      ? 'Contracts stale'
      : indexStaleCount > 0
        ? 'Index stale'
        : missingCount > 0
          ? 'Group missing repos'
          : 'Groups synced';
  const detail = [
    contractsStaleCount > 0 ? `${contractsStaleCount} contract snapshot(s) stale` : '',
    indexStaleCount > 0 ? `${indexStaleCount} repo index(es) stale` : '',
    missingCount > 0 ? `${missingCount} missing repo(s)` : '',
  ]
    .filter(Boolean)
    .join('; ');

  return {
    hasAttention,
    affectedGroups,
    contractsStaleCount,
    indexStaleCount,
    missingCount,
    label,
    title: hasAttention
      ? `${label}: ${detail}. Groups: ${affectedGroups.join(', ')}.`
      : 'Group contracts are synced.',
  };
}

interface GroupStatusNoticeProps {
  groupStatuses: GroupStatus[];
  variant?: 'badge' | 'bar';
}

export const GroupStatusNotice = ({ groupStatuses, variant = 'bar' }: GroupStatusNoticeProps) => {
  const health = summarizeGroupStatuses(groupStatuses);
  if (!health.hasAttention) return null;

  const text =
    variant === 'badge'
      ? health.affectedGroups.length > 1
        ? `${health.affectedGroups.length} groups`
        : 'Group stale'
      : health.label;

  const className =
    variant === 'badge'
      ? 'ml-1 flex shrink-0 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-200'
      : 'flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200';

  return (
    <div className={className} title={health.title} data-testid="group-status-notice">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  );
};
