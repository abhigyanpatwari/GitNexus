import { describe, expect, it } from 'vitest';
import { generateProcessMermaid, generateSimpleMermaid } from '../../src/lib/mermaid-generator';
import type { ProcessData } from '../../src/lib/mermaid-generator';

describe('generateProcessMermaid', () => {
  it('returns placeholder for empty steps', () => {
    const process: ProcessData = {
      id: 'p1',
      label: 'Empty',
      processType: 'intra_community',
      steps: [],
    };
    expect(generateProcessMermaid(process)).toContain('No steps found');
  });

  it('generates a linear chain without edges', () => {
    const process: ProcessData = {
      id: 'p1',
      label: 'GET -> Handler',
      processType: 'intra_community',
      steps: [
        { id: 'fn:a', name: 'handleGet', filePath: 'src/routes.ts', stepNumber: 1 },
        { id: 'fn:b', name: 'validate', filePath: 'src/validate.ts', stepNumber: 2 },
        { id: 'fn:c', name: 'respond', filePath: 'src/respond.ts', stepNumber: 3 },
      ],
    };

    const result = generateProcessMermaid(process);
    expect(result).toContain('graph TD');
    expect(result).toContain('handleGet');
    expect(result).toContain('validate');
    expect(result).toContain('respond');
    // Linear chain: a -> b -> c
    expect(result).toContain('-->');
  });

  it('uses CALLS edges when provided', () => {
    const process: ProcessData = {
      id: 'p1',
      label: 'Branching',
      processType: 'intra_community',
      steps: [
        { id: 'fn:a', name: 'entry', filePath: 'src/a.ts', stepNumber: 1 },
        { id: 'fn:b', name: 'branchA', filePath: 'src/b.ts', stepNumber: 2 },
        { id: 'fn:c', name: 'branchB', filePath: 'src/c.ts', stepNumber: 3 },
      ],
      edges: [
        { from: 'fn:a', to: 'fn:b', type: 'CALLS' },
        { from: 'fn:a', to: 'fn:c', type: 'CALLS' },
      ],
    };

    const result = generateProcessMermaid(process);
    // Both edges should appear
    expect(result).toContain('fn_a --> fn_b');
    expect(result).toContain('fn_a --> fn_c');
  });

  it('applies entry and terminal classes', () => {
    const process: ProcessData = {
      id: 'p1',
      label: 'Flow',
      processType: 'intra_community',
      steps: [
        { id: 'fn:start', name: 'start', filePath: 'src/a.ts', stepNumber: 1 },
        { id: 'fn:end', name: 'end', filePath: 'src/b.ts', stepNumber: 2 },
      ],
    };

    const result = generateProcessMermaid(process);
    expect(result).toContain(':::entry');
    expect(result).toContain(':::terminal');
  });

  it('uses subgraphs for cross-community processes with clusters', () => {
    const process: ProcessData = {
      id: 'p1',
      label: 'Cross',
      processType: 'cross_community',
      steps: [
        { id: 'fn:a', name: 'a', filePath: 'src/a.ts', stepNumber: 1, cluster: 'Auth' },
        { id: 'fn:b', name: 'b', filePath: 'src/b.ts', stepNumber: 2, cluster: 'DB' },
      ],
    };

    const result = generateProcessMermaid(process);
    expect(result).toContain('subgraph');
    expect(result).toContain('Auth');
    expect(result).toContain('DB');
  });
});

describe('generateSimpleMermaid', () => {
  it('generates a preview with entry and terminal', () => {
    const result = generateSimpleMermaid('POST -> ShouldRedact', 5);
    expect(result).toContain('graph LR');
    expect(result).toContain('POST');
    expect(result).toContain('ShouldRedact');
    expect(result).toContain('3 steps');
  });

  it('handles labels without arrow', () => {
    const result = generateSimpleMermaid('SingleNode', 2);
    expect(result).toContain('graph LR');
    expect(result).toContain('SingleNode');
  });
});
