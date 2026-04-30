import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GroupStatusNotice, summarizeGroupStatuses } from '../../src/components/GroupStatusNotice';
import type { GroupStatus } from '../../src/services/backend-client';

const makeStatus = (overrides: Partial<GroupStatus>): GroupStatus => ({
  group: 'product',
  lastSync: '2026-04-30T09:30:00.000Z',
  missingRepos: [],
  repos: {},
  summary: {
    repoCount: 2,
    missingCount: 0,
    indexStaleCount: 0,
    contractsStaleCount: 0,
    missing: false,
    indexStale: false,
    contractsStale: false,
    actionRequired: false,
  },
  missingGroupRepos: [],
  indexStaleRepos: [],
  contractsStaleRepos: [],
  recommendations: [],
  ...overrides,
});

describe('GroupStatusNotice', () => {
  it('summarizes stale contract snapshots across groups', () => {
    const health = summarizeGroupStatuses([
      makeStatus({
        group: 'product',
        summary: {
          repoCount: 2,
          missingCount: 0,
          indexStaleCount: 0,
          contractsStaleCount: 1,
          missing: false,
          indexStale: false,
          contractsStale: true,
          actionRequired: true,
        },
        contractsStaleRepos: ['app/backend'],
      }),
    ]);

    expect(health.hasAttention).toBe(true);
    expect(health.label).toBe('Contracts stale');
    expect(health.contractsStaleCount).toBe(1);
    expect(health.affectedGroups).toEqual(['product']);
  });

  it('renders nothing when every group is synced', () => {
    const { container } = render(<GroupStatusNotice groupStatuses={[makeStatus({})]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders compact badge text for stale groups', () => {
    render(
      <GroupStatusNotice
        variant="badge"
        groupStatuses={[
          makeStatus({
            summary: {
              repoCount: 2,
              missingCount: 0,
              indexStaleCount: 0,
              contractsStaleCount: 1,
              missing: false,
              indexStale: false,
              contractsStale: true,
              actionRequired: true,
            },
          }),
        ]}
      />,
    );

    expect(screen.getByTestId('group-status-notice')).toHaveTextContent('Group stale');
  });
});
