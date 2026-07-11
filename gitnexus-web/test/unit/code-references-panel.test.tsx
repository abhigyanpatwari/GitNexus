import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { GraphNode } from 'gitnexus-shared';
import { CodeReferencesPanel } from '../../src/components/CodeReferencesPanel';
import { readFile } from '../../src/services/backend-client';

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

describe('CodeReferencesPanel repo identity (#2420)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
