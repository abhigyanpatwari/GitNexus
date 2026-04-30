import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { CodeReferencesPanel } from '../../src/components/CodeReferencesPanel';

const { appState, readFileMock } = vi.hoisted(() => ({
  appState: {
    graph: null,
    selectedNode: null as GraphNode | null,
    codeReferences: [],
    removeCodeReference: vi.fn(),
    clearCodeReferences: vi.fn(),
    setSelectedNode: vi.fn(),
    codeReferenceFocus: null,
    projectName: 'test-project',
  },
  readFileMock: vi.fn().mockResolvedValue({ content: '', startLine: 0 }),
}));

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => appState,
}));

vi.mock('../../src/services/backend-client', () => ({
  readFile: readFileMock,
}));

describe('CodeReferencesPanel semantic anchors', () => {
  afterEach(() => {
    appState.selectedNode = null;
    appState.codeReferences = [];
    appState.setSelectedNode.mockClear();
    appState.clearCodeReferences.mockClear();
    appState.removeCodeReference.mockClear();
    readFileMock.mockClear();
  });

  it('renders selected node purpose, tags, and anchor metadata', () => {
    appState.selectedNode = {
      id: 'Function:src/auth.ts:authGate',
      label: 'Function',
      properties: {
        name: 'authGate',
        filePath: 'src/auth.ts',
        startLine: 10,
        endLine: 18,
        summary: 'Function authGate implements behavior in auth.ts.',
        purpose: 'Use this behavior anchor to trace callers before editing.',
        tags: ['function', 'exported'],
        anchorModel: 'heuristic-v1',
        anchorHash: 'abc12345',
        anchorVersion: 1,
        anchorGeneratedAt: '2026-04-30T01:02:03.000Z',
      },
    };

    render(<CodeReferencesPanel onFocusNode={vi.fn()} />);

    expect(screen.getByText('Semantic Anchor')).toBeInTheDocument();
    expect(
      screen.getByText('Function authGate implements behavior in auth.ts.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Use this behavior anchor to trace callers before editing.'),
    ).toBeInTheDocument();
    expect(screen.getByText('function')).toBeInTheDocument();
    expect(screen.getByText('exported')).toBeInTheDocument();
    expect(screen.getByText('heuristic-v1')).toBeInTheDocument();
    expect(screen.getByText('abc12345')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
  });
});
