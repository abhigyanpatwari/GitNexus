import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadGroupConfigMock = vi.fn();
const getGroupDirMock = vi.fn(() => '/fake/.gitnexus/groups/missing');
const getDefaultGitnexusDirMock = vi.fn(() => '/fake/.gitnexus');
const readContractRegistryMock = vi.fn(() => null);
const listGroupsMock = vi.fn(() => []);
const syncGroupMock = vi.fn();

vi.mock('../../src/core/group/config-parser.js', async () => {
  const { GroupNotFoundError } = await vi.importActual<
    typeof import('../../src/core/group/config-parser.js')
  >('../../src/core/group/config-parser.js');
  return { loadGroupConfig: loadGroupConfigMock, GroupNotFoundError };
});

vi.mock('../../src/core/group/storage.js', () => ({
  getDefaultGitnexusDir: getDefaultGitnexusDirMock,
  getGroupDir: getGroupDirMock,
  readContractRegistry: readContractRegistryMock,
  listGroups: listGroupsMock,
}));

vi.mock('../../src/core/group/sync.js', () => ({ syncGroup: syncGroupMock }));
vi.mock('../../src/core/git-staleness.js', () => ({ checkStaleness: vi.fn() }));

describe('GroupService — missing group error handling', () => {
  let GroupService: typeof import('../../src/core/group/service.js').GroupService;
  let GroupNotFoundError: typeof import('../../src/core/group/config-parser.js').GroupNotFoundError;
  let service: InstanceType<typeof import('../../src/core/group/service.js').GroupService>;

  const stubPort = {
    resolveRepo: vi.fn(),
    impact: vi.fn(),
    query: vi.fn(),
    impactByUid: vi.fn(),
    contextByUid: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetModules();
    loadGroupConfigMock.mockReset();
    ({ GroupService } = await import('../../src/core/group/service.js'));
    ({ GroupNotFoundError } = await import('../../src/core/group/config-parser.js'));
    service = new GroupService(stubPort as never);
    loadGroupConfigMock.mockRejectedValue(new GroupNotFoundError('missing'));
  });

  it('groupSync returns friendly error for missing group', async () => {
    const result = await service.groupSync({ name: 'missing' });
    expect(result).toEqual({
      error: 'Group "missing" not found. Run group_list to see configured groups.',
    });
  });

  it('groupQuery returns friendly error for missing group', async () => {
    const result = await service.groupQuery({ name: 'missing', query: 'auth' });
    expect(result).toEqual({
      error: 'Group "missing" not found. Run group_list to see configured groups.',
    });
  });

  it('groupStatus returns friendly error for missing group', async () => {
    const result = await service.groupStatus({ name: 'missing' });
    expect(result).toEqual({
      error: 'Group "missing" not found. Run group_list to see configured groups.',
    });
  });

  it('groupSync re-throws non-ENOENT errors', async () => {
    loadGroupConfigMock.mockRejectedValue(new Error('YAML parse error'));
    await expect(service.groupSync({ name: 'bad-yaml' })).rejects.toThrow('YAML parse error');
  });

  it('groupQuery re-throws non-ENOENT errors', async () => {
    loadGroupConfigMock.mockRejectedValue(new Error('YAML parse error'));
    await expect(service.groupQuery({ name: 'bad-yaml', query: 'auth' })).rejects.toThrow(
      'YAML parse error',
    );
  });

  it('groupStatus re-throws non-ENOENT errors', async () => {
    loadGroupConfigMock.mockRejectedValue(new Error('YAML parse error'));
    await expect(service.groupStatus({ name: 'bad-yaml' })).rejects.toThrow('YAML parse error');
  });

  it('groupList returns friendly error for missing group', async () => {
    const result = await service.groupList({ name: 'missing' });
    expect(result).toEqual({
      error: 'Group "missing" not found. Run group_list to see configured groups.',
    });
  });
});
