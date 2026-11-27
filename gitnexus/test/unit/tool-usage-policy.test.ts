/**
 * The Always Do / Never Do policy has one source.
 *
 * `ai-context-block-golden.json` was captured from `generateGitNexusContent`
 * on upstream main before that text moved into `tool-usage-policy.ts`. A byte
 * mismatch means the injected AGENTS.md / CLAUDE.md block changed.
 */

import fs from 'fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateAIContextFiles, generateGitNexusContent } from '../../src/cli/ai-context.js';
import {
  DEFAULT_POLICY_RUNNER,
  DEFAULT_POLICY_RUNNER_PATH,
  mcpServerInstructions,
  renderToolUsagePolicy,
} from '../../src/mcp/tool-usage-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const STATS = { files: 7, nodes: 50, edges: 100, communities: 2, clusters: 3, processes: 5 };

const GOLDEN = JSON.parse(
  readFileSync(path.join(HERE, '../fixtures/ai-context-block-golden.json'), 'utf8'),
) as Record<string, string>;

function policySection(block: string): string {
  const start = block.indexOf('## Always Do');
  const end = block.indexOf('\n\n## Resources');
  if (start < 0 || end < start) {
    throw new Error('tool-usage policy section not found');
  }
  return block.slice(start, end);
}

function expectFileBlockMatchesPolicy(opts: {
  runnerPath?: string;
  defaultBranch?: string;
  hasPdg?: boolean;
  hasSpringActuator?: boolean;
}): void {
  const runnerPath = opts.runnerPath ?? DEFAULT_POLICY_RUNNER_PATH;
  const defaultBranch = opts.defaultBranch ?? 'main';
  const block = generateGitNexusContent('TestProject', STATS, {
    runnerPath,
    defaultBranch,
    hasPdg: opts.hasPdg,
    hasSpringActuator: opts.hasSpringActuator,
  });
  expect(policySection(block)).toBe(
    renderToolUsagePolicy({
      runner: `node ${runnerPath}`,
      defaultBranch,
      hasPdg: opts.hasPdg,
      hasSpringActuator: opts.hasSpringActuator,
    }),
  );
}

describe('tool-usage policy source', () => {
  it('keeps generateGitNexusContent byte-identical to the pre-extraction block', () => {
    const cases: Record<string, string> = {
      default: generateGitNexusContent('TestProject', STATS),
      pdg: generateGitNexusContent('TestProject', STATS, { hasPdg: true }),
      spring: generateGitNexusContent('TestProject', STATS, { hasSpringActuator: true }),
      pdgAndSpring: generateGitNexusContent('TestProject', STATS, {
        hasPdg: true,
        hasSpringActuator: true,
      }),
      branch: generateGitNexusContent('TestProject', STATS, { defaultBranch: 'develop' }),
      quotedBranch: generateGitNexusContent('TestProject', STATS, { defaultBranch: 'we"ird' }),
      backtickBranch: generateGitNexusContent('TestProject', STATS, { defaultBranch: 'main`evil' }),
      runner: generateGitNexusContent('TestProject', STATS, {
        runnerPath: '.gitnexus-store/run.cjs',
      }),
      noStats: generateGitNexusContent('TestProject', STATS, { noStats: true }),
      skipSkills: generateGitNexusContent('TestProject', STATS, { skipSkills: true }),
      groups: generateGitNexusContent('TestProject', STATS, { groupNames: ['platform'] }),
      emptyStats: generateGitNexusContent('Empty', {}),
    };

    expect(Object.keys(cases).sort()).toEqual(Object.keys(GOLDEN).sort());
    for (const [name, content] of Object.entries(cases)) {
      expect(content, name).toBe(GOLDEN[name]);
    }
  });

  it('renders the file block and the server instructions from renderToolUsagePolicy', () => {
    expectFileBlockMatchesPolicy({});
    expectFileBlockMatchesPolicy({ hasPdg: true });
    expectFileBlockMatchesPolicy({ hasSpringActuator: true });
    expectFileBlockMatchesPolicy({ hasPdg: true, hasSpringActuator: true });
    expectFileBlockMatchesPolicy({ defaultBranch: 'develop' });
    expectFileBlockMatchesPolicy({ runnerPath: '.gitnexus-store/run.cjs' });

    const baseline = renderToolUsagePolicy({
      runner: DEFAULT_POLICY_RUNNER,
      defaultBranch: 'main',
    });
    expect(policySection(GOLDEN.default)).toBe(baseline);
    expect(mcpServerInstructions()).toBe(`Follow this GitNexus tool-usage policy.\n\n${baseline}`);
    expect(mcpServerInstructions()).not.toContain('## Resources');
    expect(mcpServerInstructions()).not.toContain('## CLI');
    expect(mcpServerInstructions()).not.toContain('pdg_query');
    expect(mcpServerInstructions()).not.toContain('Spring Actuator');
  });

  it('keeps the policy bullets in the shared module only', () => {
    const bullet = 'MUST run impact before code/config/test edits.';
    const policy = readFileSync(path.join(SRC, 'mcp/tool-usage-policy.ts'), 'utf8');
    const aiContext = readFileSync(path.join(SRC, 'cli/ai-context.ts'), 'utf8');
    const server = readFileSync(path.join(SRC, 'mcp/server.ts'), 'utf8');

    expect(policy).toContain('## Always Do');
    expect(policy).toContain('## Never Do');
    expect(policy).toContain(bullet);
    expect(aiContext).not.toContain('## Always Do');
    expect(aiContext).not.toContain('## Never Do');
    expect(aiContext).not.toContain(bullet);
    expect(server).not.toContain(bullet);
    expect(aiContext).toContain("from '../mcp/tool-usage-policy.js'");
    expect(server).toContain("from './tool-usage-policy.js'");
    expect(server).toContain('instructions: mcpServerInstructions()');
  });

  it('writes that same policy into CLAUDE.md and AGENTS.md', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-policy-'));
    try {
      await generateAIContextFiles(dir, path.join(dir, '.gitnexus'), 'Proj', STATS, undefined, {
        skipSkills: true,
      });
      const expected = renderToolUsagePolicy({
        runner: DEFAULT_POLICY_RUNNER,
        defaultBranch: 'main',
      });
      for (const name of ['CLAUDE.md', 'AGENTS.md']) {
        const written = await fs.readFile(path.join(dir, name), 'utf8');
        expect(policySection(written), name).toBe(expected);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
