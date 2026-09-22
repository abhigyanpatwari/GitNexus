import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { GraphNode } from 'gitnexus-shared';
import { CodeReferencesPanel } from '../../src/components/CodeReferencesPanel';
import { BackendError, readFile } from '../../src/services/backend-client';

const fileNode: GraphNode = {
  id: 'File:src/foo.ts',
  label: 'File',
  properties: { name: 'foo.ts', filePath: 'src/foo.ts' },
};

// Mutable mock state: the useAppState factory closes over this object so each
// test can reassign fields (e.g. currentRepo) before rendering.
const appState = {
  graph: null,
  selectedNode: fileNode,
  codeReferences: [],
  removeCodeReference: vi.fn(),
  clearCodeReferences: vi.fn(),
  setSelectedNode: vi.fn(),
  codeReferenceFocus: null,
  projectName: 'reels',
  currentRepo: undefined as string | undefined,
};

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => appState,
}));

vi.mock('../../src/services/backend-client', () => ({
  readFile: vi.fn(),
  BackendError: class BackendError extends Error {
    constructor(
      message: string,
      _status: number,
      public readonly code: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }: { children?: ReactNode }) => <pre>{children}</pre>,
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  vscDarkPlus: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const citationReads = () =>
  vi.mocked(readFile).mock.calls.filter(([, opts]) => opts && 'startLine' in (opts as object));

describe('CodeReferencesPanel repo identity (#2420)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.codeReferences = [];
    appState.selectedNode = fileNode;
    appState.projectName = 'reels';
    appState.currentRepo = undefined;
    vi.mocked(readFile).mockResolvedValue({ content: 'const a = 1;', totalLines: 1 });
  });

  it('reads the selected file from the active repo path, not the display name', () => {
    appState.currentRepo = '/ws/b/reels';
    appState.projectName = 'reels';

    render(<CodeReferencesPanel onFocusNode={vi.fn()} />);

    expect(readFile).toHaveBeenCalledWith('src/foo.ts', { repo: '/ws/b/reels' });
  });

  it('falls back to the project display name when no repo path is active', () => {
    appState.currentRepo = undefined;
    appState.projectName = 'reels';

    render(<CodeReferencesPanel onFocusNode={vi.fn()} />);

    expect(readFile).toHaveBeenCalledWith('src/foo.ts', { repo: 'reels' });
  });

  it('renders the dedicated source-unavailable state for retained indexes without a checkout', async () => {
    vi.mocked(readFile).mockRejectedValue(
      new BackendError('source unavailable', 410, 'source_unavailable'),
    );

    render(<CodeReferencesPanel onFocusNode={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('graph:codePanel.sourceUnavailable')).toBeInTheDocument();
    });
  });

  it('does not free replacement-batch citation ids when a cancelled repo-switch batch settles', async () => {
    appState.codeReferences = [
      {
        id: 'cite-1',
        filePath: 'src/foo.ts',
        startLine: 0,
        endLine: 0,
        source: 'ai',
      },
    ];
    appState.currentRepo = '/ws/a/reels';

    let releaseFirst!: (value: { content: string; startLine: number; totalLines: number }) => void;
    const firstCitation = new Promise<{ content: string; startLine: number; totalLines: number }>(
      (resolve) => {
        releaseFirst = resolve;
      },
    );
    vi.mocked(readFile).mockImplementation((_path, opts) => {
      if (opts && 'startLine' in opts) return firstCitation;
      return Promise.resolve({ content: 'const a = 1;', totalLines: 1 });
    });

    const { rerender } = render(<CodeReferencesPanel onFocusNode={vi.fn()} />);
    await waitFor(() => expect(citationReads()).toHaveLength(1));

    vi.mocked(readFile).mockImplementation((_path, opts) => {
      if (opts && 'startLine' in opts) {
        return Promise.resolve({ content: 'const a = 1;', startLine: 0, totalLines: 1 });
      }
      return Promise.resolve({ content: 'const a = 1;', totalLines: 1 });
    });
    appState.currentRepo = '/ws/b/reels';
    rerender(<CodeReferencesPanel onFocusNode={vi.fn()} />);

    await waitFor(() => expect(citationReads()).toHaveLength(2));
    expect(citationReads()[1]?.[1]).toEqual(expect.objectContaining({ repo: '/ws/b/reels' }));

    releaseFirst({ content: 'stale', startLine: 0, totalLines: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(citationReads()).toHaveLength(2);
  });
});
