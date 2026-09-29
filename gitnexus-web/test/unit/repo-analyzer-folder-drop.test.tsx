/**
 * Folder drag-and-drop on RepoAnalyzer's Local Folder tab.
 *
 * A dropped folder is walked client-side (src/lib/folder-drop.ts) and then
 * takes the exact path the "Upload a folder" picker takes: filterRepoFiles ->
 * uploadFolder -> streamAnalyzeProgress. These tests drive the drop with
 * fixture FileSystemEntry objects (jsdom has no File and Directory Entries
 * API) and assert the upload the server would receive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RepoAnalyzer } from '../../src/components/RepoAnalyzer';
import { i18nReady } from '../../src/i18n';
import {
  cancelAnalyze,
  streamAnalyzeProgress,
  uploadFolder,
} from '../../src/services/backend-client';

vi.mock('../../src/services/backend-client', () => ({
  BackendError: class BackendError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code: string,
      public readonly retryAfterMs?: number,
    ) {
      super(message);
      this.name = 'BackendError';
    }
  },
  startAnalyze: vi.fn(),
  cancelAnalyze: vi.fn(),
  streamAnalyzeProgress: vi.fn(),
  uploadFolder: vi.fn(),
}));

const JOB = { jobId: 'job-1', status: 'queued' };

// ── Fixtures ─────────────────────────────────────────────────────────────────

function fileEntry(name: string, size = 1): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/browser-root/${name}`,
    file: (ok: (f: File) => void) => ok(new File([new Uint8Array(size)], name)),
  } as unknown as FileSystemFileEntry;
}

/** A file whose `file()` callback is released manually, to hold the walk open. */
function deferredFileEntry(name: string) {
  let release: (() => void) | undefined;
  const entry = {
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/browser-root/${name}`,
    file: (ok: (f: File) => void) => {
      release = () => ok(new File(['x'], name));
    },
  } as unknown as FileSystemFileEntry;
  return { entry, release: () => release?.() };
}

function dirEntry(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/browser-root/${name}`,
    createReader: () => {
      let done = false;
      return {
        readEntries: (ok: (entries: FileSystemEntry[]) => void) => {
          if (done) return ok([]);
          done = true;
          ok(children);
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

function dataTransfer(entries: (FileSystemEntry | null)[], supported = true) {
  const items = entries.map((e) => (supported ? { webkitGetAsEntry: () => e } : {}));
  return { items, types: ['Files'], files: [], dropEffect: 'none' };
}

const filesDrag = { dataTransfer: { types: ['Files'], items: [], dropEffect: 'none' } };

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await i18nReady;
  vi.clearAllMocks();
  vi.mocked(cancelAnalyze).mockResolvedValue(undefined as never);
  vi.mocked(uploadFolder).mockResolvedValue(JOB);
  vi.mocked(streamAnalyzeProgress).mockImplementation(() => new AbortController());
});

function renderLocalTab() {
  const onComplete = vi.fn();
  render(<RepoAnalyzer variant="onboarding" onComplete={onComplete} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Local Folder' }));
  return { zone: screen.getByTestId('folder-drop-zone'), onComplete };
}

const REPO = () =>
  dirEntry('repo', [
    fileEntry('a.ts'),
    dirEntry('src', [fileEntry('b.ts')]),
    dirEntry('node_modules', [fileEntry('dep.js')]),
    dirEntry('.git', [fileEntry('HEAD')]),
  ]);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('folder drop on the Local Folder tab', () => {
  it('uploads a dropped folder through the existing upload path', async () => {
    const { zone } = renderLocalTab();

    fireEvent.drop(zone, { dataTransfer: dataTransfer([REPO()]) });
    await act(async () => {});

    expect(uploadFolder).toHaveBeenCalledTimes(1);
    const [files = [], manifest = [], signal] = vi.mocked(uploadFolder).mock.calls[0] ?? [];
    expect(manifest).toEqual(['repo/a.ts', 'repo/src/b.ts']);
    expect(files.map((f) => f.webkitRelativePath)).toEqual(manifest);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(streamAnalyzeProgress).toHaveBeenCalledWith(
      'job-1',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('shows the reading state while the folder is walked', async () => {
    const { zone } = renderLocalTab();
    const held = deferredFileEntry('slow.ts');
    const repo = dirEntry('repo', [fileEntry('a.ts'), held.entry]);

    fireEvent.drop(zone, { dataTransfer: dataTransfer([repo]) });
    await act(async () => {});

    expect(screen.getByTestId('drop-reading')).toBeInTheDocument();
    expect(screen.getByTestId('upload-folder')).toBeDisabled();
    expect(uploadFolder).not.toHaveBeenCalled();

    await act(async () => {
      held.release();
    });

    expect(screen.queryByTestId('drop-reading')).toBeNull();
    expect(uploadFolder).toHaveBeenCalledTimes(1);
  });

  it('refuses a loose file', async () => {
    const { zone } = renderLocalTab();

    fireEvent.drop(zone, { dataTransfer: dataTransfer([fileEntry('a.ts')]) });
    await act(async () => {});

    expect(uploadFolder).not.toHaveBeenCalled();
    expect(
      screen.getByText('Drop a single folder, not files or several folders.'),
    ).toBeInTheDocument();
  });

  it('refuses several folders at once', async () => {
    const { zone } = renderLocalTab();

    fireEvent.drop(zone, {
      dataTransfer: dataTransfer([
        dirEntry('a', [fileEntry('x')]),
        dirEntry('b', [fileEntry('y')]),
      ]),
    });
    await act(async () => {});

    expect(uploadFolder).not.toHaveBeenCalled();
    expect(
      screen.getByText('Drop a single folder, not files or several folders.'),
    ).toBeInTheDocument();
  });

  it('explains when the browser cannot read dropped folders', async () => {
    const { zone } = renderLocalTab();

    fireEvent.drop(zone, { dataTransfer: dataTransfer([REPO()], false) });
    await act(async () => {});

    expect(uploadFolder).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'This browser cannot read a dropped folder. Use the “Upload a folder” button instead.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('upload-folder')).toBeEnabled();
  });

  it('shows the existing empty-folder message for a folder without analyzable files', async () => {
    const { zone } = renderLocalTab();

    fireEvent.drop(zone, {
      dataTransfer: dataTransfer([dirEntry('repo', [dirEntry('node_modules', [fileEntry('x')])])]),
    });
    await act(async () => {});

    expect(uploadFolder).not.toHaveBeenCalled();
    expect(screen.getByText('No analyzable files found in that folder.')).toBeInTheDocument();
  });

  it('aborts the walk on a mode switch and never uploads', async () => {
    const { zone } = renderLocalTab();
    const held = deferredFileEntry('slow.ts');
    const repo = dirEntry('repo', [fileEntry('a.ts'), held.entry]);

    fireEvent.drop(zone, { dataTransfer: dataTransfer([repo]) });
    await act(async () => {});
    expect(screen.getByTestId('drop-reading')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /GitHub/ }));
    await act(async () => {
      held.release();
    });

    expect(uploadFolder).not.toHaveBeenCalled();
    expect(screen.queryByTestId('drop-reading')).toBeNull();
    expect(screen.queryByText(/single folder|cannot read/)).toBeNull();
  });

  it('keeps the highlight while the cursor crosses the button, clears it on leave', () => {
    const { zone } = renderLocalTab();
    const button = screen.getByTestId('upload-folder');

    fireEvent.dragEnter(zone, filesDrag);
    expect(zone).toHaveAttribute('data-drag-active', 'true');
    expect(screen.getByTestId('drop-hint')).toHaveTextContent('Release to upload this folder');

    fireEvent.dragEnter(button, filesDrag);
    fireEvent.dragLeave(button, filesDrag);
    expect(zone).toHaveAttribute('data-drag-active', 'true');

    fireEvent.dragLeave(zone, filesDrag);
    expect(zone).not.toHaveAttribute('data-drag-active');
    expect(screen.getByTestId('drop-hint')).toHaveTextContent('or drop a folder here');
  });

  it('catches a drop that lands on the path input inside the panel', async () => {
    renderLocalTab();

    fireEvent.drop(screen.getByPlaceholderText(/project/), {
      dataTransfer: dataTransfer([REPO()]),
    });
    await act(async () => {});

    expect(uploadFolder).toHaveBeenCalledTimes(1);
  });

  it('disables Analyze while a dropped folder is being read', async () => {
    const { zone } = renderLocalTab();
    fireEvent.change(screen.getByPlaceholderText(/project/), { target: { value: '/srv/repo' } });
    expect(screen.getByRole('button', { name: /Analyze Repository/ })).toBeEnabled();

    const held = deferredFileEntry('slow.ts');
    fireEvent.drop(zone, { dataTransfer: dataTransfer([dirEntry('repo', [held.entry])]) });
    await act(async () => {});
    expect(screen.getByRole('button', { name: /Analyze Repository/ })).toBeDisabled();

    await act(async () => {
      held.release();
    });
    expect(uploadFolder).toHaveBeenCalledTimes(1);
  });

  it('ignores drags that carry no files', () => {
    const { zone } = renderLocalTab();

    fireEvent.dragEnter(zone, { dataTransfer: { types: ['text/plain'], items: [] } });
    expect(zone).not.toHaveAttribute('data-drag-active');

    fireEvent.drop(zone, { dataTransfer: { types: ['text/plain'], items: [] } });
    expect(uploadFolder).not.toHaveBeenCalled();
  });

  it("does not let an aborted drop clear a later drop's reading state", async () => {
    const { zone } = renderLocalTab();
    const heldA = deferredFileEntry('slow-a.ts');
    fireEvent.drop(zone, { dataTransfer: dataTransfer([dirEntry('repo-a', [heldA.entry])]) });
    await act(async () => {});
    expect(screen.getByTestId('drop-reading')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /GitHub/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Local Folder' }));
    const zoneB = screen.getByTestId('folder-drop-zone');
    const heldB = deferredFileEntry('slow-b.ts');
    fireEvent.drop(zoneB, { dataTransfer: dataTransfer([dirEntry('repo-b', [heldB.entry])]) });
    await act(async () => {});
    expect(screen.getByTestId('drop-reading')).toBeInTheDocument();

    await act(async () => {
      heldA.release();
    });

    expect(screen.getByTestId('drop-reading')).toBeInTheDocument();
    expect(screen.getByTestId('upload-folder')).toBeDisabled();
    expect(uploadFolder).not.toHaveBeenCalled();

    await act(async () => {
      heldB.release();
    });

    expect(screen.queryByTestId('drop-reading')).toBeNull();
    expect(uploadFolder).toHaveBeenCalledTimes(1);
    const [, manifest] = vi.mocked(uploadFolder).mock.calls[0] ?? [];
    expect(manifest).toEqual(['repo-b/slow-b.ts']);
  });

  it('ignores a drop while an upload is already in flight', async () => {
    const { zone } = renderLocalTab();
    vi.mocked(uploadFolder).mockImplementation(() => new Promise(() => {}));

    fireEvent.drop(zone, { dataTransfer: dataTransfer([REPO()]) });
    await act(async () => {});
    expect(uploadFolder).toHaveBeenCalledTimes(1);

    fireEvent.drop(zone, { dataTransfer: dataTransfer([REPO()]) });
    await act(async () => {});
    expect(uploadFolder).toHaveBeenCalledTimes(1);
  });
});
