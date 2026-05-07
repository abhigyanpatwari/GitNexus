import { describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { resolveAgentLensFocus } from '../../src/lib/agent-lens-focus';

const createNode = (id: string, label: GraphNode['label'], name: string): GraphNode => ({
  id,
  label,
  properties: { name },
});

describe('agent lens focus', () => {
  it('prioritizes impact nodes over tool and citation nodes', () => {
    const nodeById = new Map<string, GraphNode>([
      ['impact:fn', createNode('impact:fn', 'Function', 'zeta')],
      ['tool:file', createNode('tool:file', 'File', 'alpha.ts')],
      ['citation:class', createNode('citation:class', 'Class', 'Beta')],
    ]);

    const resolved = resolveAgentLensFocus({
      isEnabled: true,
      impactNodeIds: new Set(['impact:fn']),
      toolNodeIds: new Set(['tool:file']),
      citationNodeIds: new Set(['citation:class']),
      currentToolCalls: [
        { id: 'tool-2', name: 'query' },
        { id: 'tool-1', name: 'impact' },
      ],
      nodeById,
    });

    expect(resolved.focalNodeId).toBe('impact:fn');
    expect(resolved.focalSource).toBe('impact');
    expect(resolved.signature).toContain('calls=tool-1:impact,tool-2:query');
  });

  it('falls back from tool nodes to citation nodes and sorts deterministically', () => {
    const nodeById = new Map<string, GraphNode>([
      ['tool:z', createNode('tool:z', 'File', 'z-last.ts')],
      ['tool:a', createNode('tool:a', 'File', 'a-first.ts')],
      ['citation:b', createNode('citation:b', 'Class', 'Bravo')],
    ]);

    const toolResolved = resolveAgentLensFocus({
      isEnabled: true,
      impactNodeIds: new Set(),
      toolNodeIds: new Set(['tool:z', 'tool:a']),
      citationNodeIds: new Set(['citation:b']),
      currentToolCalls: [{ id: 'tool-1', name: 'query' }],
      nodeById,
    });

    expect(toolResolved.toolNodeIds).toEqual(['tool:a', 'tool:z']);
    expect(toolResolved.focalNodeId).toBe('tool:a');
    expect(toolResolved.focalSource).toBe('tool');

    const citationResolved = resolveAgentLensFocus({
      isEnabled: true,
      impactNodeIds: new Set(),
      toolNodeIds: new Set(),
      citationNodeIds: new Set(['citation:b']),
      currentToolCalls: [],
      nodeById,
    });

    expect(citationResolved.focalNodeId).toBe('citation:b');
    expect(citationResolved.focalSource).toBe('citation');
  });

  it('disables the focus signature when highlights are off or empty', () => {
    const nodeById = new Map<string, GraphNode>([['tool:a', createNode('tool:a', 'File', 'a.ts')]]);

    const disabled = resolveAgentLensFocus({
      isEnabled: false,
      impactNodeIds: new Set(),
      toolNodeIds: new Set(['tool:a']),
      citationNodeIds: new Set(),
      currentToolCalls: [{ id: 'tool-1', name: 'query' }],
      nodeById,
    });

    expect(disabled.focalNodeId).toBe('tool:a');
    expect(disabled.signature).toBeNull();

    const empty = resolveAgentLensFocus({
      isEnabled: true,
      impactNodeIds: new Set(),
      toolNodeIds: new Set(),
      citationNodeIds: new Set(),
      currentToolCalls: [{ id: 'tool-1', name: 'query' }],
      nodeById,
    });

    expect(empty.focalNodeId).toBeNull();
    expect(empty.signature).toBeNull();
  });
});
