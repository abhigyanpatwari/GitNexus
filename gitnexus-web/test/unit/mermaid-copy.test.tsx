/**
 * #787: the Copy Mermaid button of the expanded diagram copies the source the
 * diagram is drawn from. A diagram written by the AI in chat carries its own
 * source and no process steps.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n, { i18nReady } from '../../src/i18n';
import { MermaidDiagram } from '../../src/components/MermaidDiagram';
import { ProcessFlowModal } from '../../src/components/ProcessFlowModal';
import { generateProcessMermaid, type ProcessData } from '../../src/lib/mermaid-generator';

// jsdom has no layout, so Mermaid cannot measure text: record what each
// diagram is drawn from and return a placeholder SVG instead.
const { renderMermaid } = vi.hoisted(() => ({
  renderMermaid: vi.fn(async (_id: string, _code: string) => ({ svg: '<svg></svg>' })),
}));

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: renderMermaid, parseError: undefined },
}));

const AI_DIAGRAM = `graph TD
  A[handleLogin] --> B[validateUser]
  B --> C[createSession]`;

const writeText = vi.fn(async (_text: string) => {});

beforeAll(async () => {
  await i18nReady;
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  renderMermaid.mockClear();
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
});

describe('Copy Mermaid', () => {
  it('copies the AI diagram that the chat expands, not a placeholder', async () => {
    render(<MermaidDiagram code={AI_DIAGRAM} />);
    fireEvent.click(screen.getByTitle('Expand'));

    fireEvent.click(await screen.findByRole('button', { name: 'Copy Mermaid' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(AI_DIAGRAM);
  });

  it('copies the same source the modal draws', async () => {
    const aiProcess: ProcessData = {
      id: 'ai-generated',
      label: 'AI Generated Diagram',
      processType: 'intra_community',
      steps: [],
      rawMermaid: AI_DIAGRAM,
    };
    render(<ProcessFlowModal process={aiProcess} onClose={() => {}} />);
    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Copy Mermaid' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(renderMermaid.mock.calls[0][1]).toBe(AI_DIAGRAM);
    expect(writeText).toHaveBeenCalledWith(AI_DIAGRAM);
  });

  it('still copies the generated flowchart of a process from the graph', async () => {
    const process: ProcessData = {
      id: 'proc:login',
      label: 'Login flow',
      processType: 'intra_community',
      steps: [
        { id: 'fn:a', name: 'handleLogin', filePath: 'src/auth.ts', stepNumber: 1 },
        { id: 'fn:b', name: 'createSession', filePath: 'src/session.ts', stepNumber: 2 },
      ],
    };
    render(<ProcessFlowModal process={process} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy Mermaid' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(generateProcessMermaid(process));
    expect(writeText.mock.calls[0][0]).toContain('handleLogin');
  });
});
