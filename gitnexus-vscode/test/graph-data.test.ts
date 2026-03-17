import { describe, expect, it } from 'vitest';
import { buildGraphPayload } from '../src/webview/graph-data';

describe('buildGraphPayload', () => {
  it('builds repo, module, process, and symbol nodes', () => {
    const payload = buildGraphPayload(
      'GitNexus',
      [
        { name: 'Auth Module', symbols: 24 },
        { name: 'Search Module', symbols: 16 },
      ],
      [
        { name: 'Auth Login Flow', type: 'request', steps: 6 },
        { name: 'Search Query Flow', type: 'request', steps: 8 },
      ],
      'AuthService',
    );

    expect(payload.title).toContain('Interactive Graph');
    expect(payload.nodes.some((node) => node.kind === 'repo')).toBe(true);
    expect(payload.nodes.some((node) => node.kind === 'module')).toBe(true);
    expect(payload.nodes.some((node) => node.kind === 'process')).toBe(true);
    expect(payload.nodes.some((node) => node.kind === 'symbol')).toBe(true);
    expect(payload.edges.length).toBeGreaterThan(0);
  });

  it('limits rendered module and process counts', () => {
    const modules = Array.from({ length: 30 }, (_, index) => ({
      name: `Module ${index}`,
      symbols: index + 1,
    }));

    const processes = Array.from({ length: 40 }, (_, index) => ({
      name: `Process ${index}`,
      type: 'request',
      steps: index + 1,
    }));

    const payload = buildGraphPayload('GitNexus', modules, processes);

    const moduleCount = payload.nodes.filter((node) => node.kind === 'module').length;
    const processCount = payload.nodes.filter((node) => node.kind === 'process').length;

    expect(moduleCount).toBe(20);
    expect(processCount).toBe(24);
  });
});
