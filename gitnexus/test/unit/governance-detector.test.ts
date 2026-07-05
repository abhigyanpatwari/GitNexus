import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildGovernanceGraphPatch,
  detectGovernance,
  formatGovernanceContext,
} from '../../src/core/governance/detector.js';

function makeRepo(): string {
  return mkdtempSync(path.join(tmpdir(), 'gitnexus-governance-'));
}

describe('governance detector', () => {
  it('detects MCP, Cedar, surfaces, and Veritas Acta governance surfaces', () => {
    const root = makeRepo();
    mkdirSync(path.join(root, '.veritasacta'), { recursive: true });
    writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          payments: { command: 'node', args: ['server.js'], allowedHosts: ['api.example.com'] },
        },
      }),
    );
    writeFileSync(
      path.join(root, 'policy.cedar'),
      'permit(principal, action == Action::"read", resource);\n',
    );
    writeFileSync(
      path.join(root, 'surfaces.yaml'),
      'surfaces:\n  checkout:\n    allowed_hosts:\n      - api.example.com\n    require_receipts: true\n',
    );
    writeFileSync(
      path.join(root, '.veritasacta/config.json'),
      JSON.stringify({ receipts: { required: true }, policy: { id: 'checkout-v1' } }),
    );

    const report = detectGovernance(root);

    expect(report.surfaces.map((s) => s.kind).sort()).toEqual([
      'cedar',
      'mcp',
      'surfaces',
      'veritas-acta',
    ]);
    expect(report.surfaces.flatMap((s) => s.constraints).some((c) => c.kind === 'mcp-server')).toBe(
      true,
    );
    expect(
      report.surfaces.flatMap((s) => s.constraints).some((c) => c.kind === 'cedar-policy-set'),
    ).toBe(true);
    expect(report.contextMarkdown).toContain('Governance boundaries detected by GitNexus');
  });

  it('detects sensitive operations and links them to matching governance constraints', () => {
    const root = makeRepo();
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'surfaces.yaml'),
      'network:\n  allowed_hosts:\n    - api.example.com\nexecution:\n  command_allowlist:\n    - git\n',
    );
    writeFileSync(
      path.join(root, 'src/agent.ts'),
      'import { exec } from "node:child_process";\nawait fetch("https://api.example.com");\nexec("git status");\nprocess.env.API_TOKEN;\n',
    );

    const report = detectGovernance(root);

    expect(report.operations.map((op) => op.kind)).toEqual(
      expect.arrayContaining(['network', 'exec', 'secret-access']),
    );
    expect(
      report.graphPatch.nodes.some((node) => node.id.startsWith('governance:operation:')),
    ).toBe(true);
    expect(
      report.graphPatch.relationships.some((rel) =>
        rel.reason.startsWith('governance-boundary-applies'),
      ),
    ).toBe(true);
  });

  it('emits a reversible graph patch using existing node labels and relationship types', () => {
    const root = makeRepo();
    writeFileSync(path.join(root, '.agent-governance.json'), JSON.stringify({ sandbox: true }));
    writeFileSync(
      path.join(root, 'tool.py'),
      'import subprocess\nsubprocess.run(["git", "status"])\n',
    );

    const report = detectGovernance(root);
    const patch = buildGovernanceGraphPatch(report.surfaces, report.operations);

    expect(patch.nodes.length).toBeGreaterThan(0);
    expect(patch.nodes.every((node) => node.label === 'CodeElement')).toBe(true);
    expect(patch.relationships.every((rel) => ['DEFINES', 'USES'].includes(rel.type))).toBe(true);
  });

  it('formats no-surface guidance without inventing permissions', () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'client.ts'), 'fetch("https://example.com")\n');
    const report = detectGovernance(root);
    const text = formatGovernanceContext(report);

    expect(report.surfaces).toHaveLength(0);
    expect(text).toContain('Do not infer network, exec, or write permissions');
  });
});
