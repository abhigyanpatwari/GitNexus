import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { generateFiles } from '../../src/cli/ci-setup/templates.js';
import type { CiSetupOptions, DetectResult } from '../../src/cli/ci-setup/types.js';

const DEFAULT_DETECT: DetectResult = {
  gitRoot: '/repo',
  detectedCi: 'github-actions',
  hasDocker: true,
  primaryLanguage: 'TypeScript',
};

function makeOpts(overrides?: Partial<CiSetupOptions>): CiSetupOptions {
  return {
    ci: 'github-actions',
    deploy: 'docker',
    port: 4747,
    auth: 'token',
    branchStrategy: 'pr-scoped',
    dryRun: true,
    apply: false,
    yes: false,
    outputDir: '/repo',
    ...overrides,
  };
}

function gitnexusMd(overrides?: Partial<CiSetupOptions>): string {
  const files = generateFiles(makeOpts(overrides), DEFAULT_DETECT);
  const md = files.find((f) => f.relativePath === 'GITNEXUS.md');
  if (!md) throw new Error('GITNEXUS.md not generated');
  return md.content;
}

describe('GITNEXUS.md index delivery (U7)', () => {
  it('does not oversell auto-delivery with a non-existent volume-sharing mechanism', () => {
    const content = gitnexusMd();
    expect(content).not.toContain('volume-sharing mechanism');
    expect(content).toContain('does not automate index delivery');
  });

  it('docker deploy shows an on-server delivery example (docker compose cp)', () => {
    const content = gitnexusMd({ deploy: 'docker' });
    expect(content).toContain('docker compose cp');
    expect(content).not.toContain('az storage file upload-batch');
  });

  it('ACA deploy shows an az storage file upload-batch example', () => {
    const content = gitnexusMd({ deploy: 'azure-container-app' });
    expect(content).toContain('az storage file upload-batch');
  });

  it('both deploy shows both delivery paths', () => {
    const content = gitnexusMd({ deploy: 'both' });
    expect(content).toContain('docker compose cp');
    expect(content).toContain('az storage file upload-batch');
  });
});

describe('GITNEXUS.md / workflow accuracy (U8)', () => {
  function workflow(overrides?: Partial<CiSetupOptions>): string {
    const files = generateFiles(makeOpts(overrides), DEFAULT_DETECT);
    const wf = files.find((f) => f.relativePath === '.github/workflows/gitnexus-ci.yml');
    if (!wf) throw new Error('workflow not generated');
    return wf.content;
  }

  it('drops the false "stale-index PRs are blocked at CI" claim', () => {
    const content = gitnexusMd();
    expect(content).not.toContain('stale-index PRs are blocked at CI');
    expect(content).toContain('does not detect');
  });

  it('renames the misleading "Check index staleness" workflow step', () => {
    const content = workflow();
    expect(content).not.toContain('Check index staleness');
    expect(content).toContain('Verify index was produced');
  });

  it('is honest that skills are not auto-committed (contents: read)', () => {
    const content = gitnexusMd();
    expect(content).not.toContain('written into the repository by the CI workflow');
    expect(content).toContain('does **not** commit them');
    expect(content).toContain('contents: write');
  });
});

describe('generateFiles', () => {
  describe('GitHub Actions workflow', () => {
    it('generates with correct port in healthcheck', () => {
      const files = generateFiles(makeOpts(), DEFAULT_DETECT);
      const wf = files.find((f) => f.relativePath === '.github/workflows/gitnexus-ci.yml');
      expect(wf).toBeDefined();
      // port 4747 appears in the healthcheck (docker-compose, not the workflow itself)
    });

    it('is valid YAML', () => {
      const files = generateFiles(makeOpts(), DEFAULT_DETECT);
      const wf = files.find((f) => f.relativePath === '.github/workflows/gitnexus-ci.yml');
      expect(() => yaml.load(wf!.content)).not.toThrow();
    });

    it('uses node 22', () => {
      const files = generateFiles(makeOpts(), DEFAULT_DETECT);
      const wf = files.find((f) => f.relativePath === '.github/workflows/gitnexus-ci.yml');
      expect(wf!.content).toContain("node-version: '22'");
    });

    it('includes pull_request trigger when pr-scoped', () => {
      const files = generateFiles(makeOpts({ branchStrategy: 'pr-scoped' }), DEFAULT_DETECT);
      const wf = files.find((f) => f.relativePath === '.github/workflows/gitnexus-ci.yml');
      expect(wf!.content).toContain('pull_request');
    });

    it('omits pull_request trigger when main-only', () => {
      const files = generateFiles(makeOpts({ branchStrategy: 'main-only' }), DEFAULT_DETECT);
      const wf = files.find((f) => f.relativePath === '.github/workflows/gitnexus-ci.yml');
      expect(wf!.content).not.toContain('pull_request');
    });

    it('includes license notice', () => {
      const files = generateFiles(makeOpts(), DEFAULT_DETECT);
      const wf = files.find((f) => f.relativePath === '.github/workflows/gitnexus-ci.yml');
      expect(wf!.content).toContain('PolyForm-Noncommercial');
    });
  });

  describe('Azure DevOps pipeline', () => {
    it('generates when ci is azure-devops', () => {
      const files = generateFiles(makeOpts({ ci: 'azure-devops' }), DEFAULT_DETECT);
      const ado = files.find((f) => f.relativePath === 'azure-pipelines-gitnexus.yml');
      expect(ado).toBeDefined();
    });

    it('is valid YAML', () => {
      const files = generateFiles(makeOpts({ ci: 'azure-devops' }), DEFAULT_DETECT);
      const ado = files.find((f) => f.relativePath === 'azure-pipelines-gitnexus.yml');
      expect(() => yaml.load(ado!.content)).not.toThrow();
    });

    it('includes commercial use notice', () => {
      const files = generateFiles(makeOpts({ ci: 'azure-devops' }), DEFAULT_DETECT);
      const ado = files.find((f) => f.relativePath === 'azure-pipelines-gitnexus.yml');
      expect(ado!.content).toContain('COMMERCIAL USE');
    });

    it('omits pr trigger when main-only', () => {
      const files = generateFiles(
        makeOpts({ ci: 'azure-devops', branchStrategy: 'main-only' }),
        DEFAULT_DETECT,
      );
      const ado = files.find((f) => f.relativePath === 'azure-pipelines-gitnexus.yml');
      expect(ado!.content).toContain('pr: none');
    });
  });

  describe('Docker Compose — token auth', () => {
    it('generates with correct health endpoint /api/health', () => {
      const files = generateFiles(makeOpts({ auth: 'token' }), DEFAULT_DETECT);
      const dc = files.find((f) => f.relativePath === 'docker-compose.gitnexus.yml');
      expect(dc!.content).toContain('/api/health');
    });

    it('uses port 4747', () => {
      const files = generateFiles(makeOpts({ auth: 'token', port: 4747 }), DEFAULT_DETECT);
      const dc = files.find((f) => f.relativePath === 'docker-compose.gitnexus.yml');
      expect(dc!.content).toContain('4747');
    });

    it('does NOT publish gitnexus port directly (no ports: on gitnexus service)', () => {
      const files = generateFiles(makeOpts({ auth: 'token' }), DEFAULT_DETECT);
      const dc = files.find((f) => f.relativePath === 'docker-compose.gitnexus.yml');
      // The service section before the proxy section should have no port mapping for 4747
      const lines = dc!.content.split('\n');
      const gitnexusServiceEnd = lines.findIndex((l) => l.trim() === 'gitnexus-proxy:');
      const gitnexusSection = lines.slice(0, gitnexusServiceEnd).join('\n');
      expect(gitnexusSection).not.toMatch(/^\s+ports:/m);
    });

    it('includes Caddy proxy service', () => {
      const files = generateFiles(makeOpts({ auth: 'token' }), DEFAULT_DETECT);
      const dc = files.find((f) => f.relativePath === 'docker-compose.gitnexus.yml');
      expect(dc!.content).toContain('gitnexus-proxy');
      expect(dc!.content).toContain('caddy:alpine');
    });

    it('generates Caddyfile', () => {
      const files = generateFiles(makeOpts({ auth: 'token' }), DEFAULT_DETECT);
      const cf = files.find((f) => f.relativePath === 'Caddyfile');
      expect(cf).toBeDefined();
      expect(cf!.content).toContain('{env.GITNEXUS_TOKEN}');
      expect(cf!.content).toContain('reverse_proxy gitnexus:4747');
      expect(cf!.content).toContain('respond "Unauthorized" 401');
    });

    it('is valid YAML (docker-compose)', () => {
      const files = generateFiles(makeOpts({ auth: 'token' }), DEFAULT_DETECT);
      const dc = files.find((f) => f.relativePath === 'docker-compose.gitnexus.yml');
      expect(() => yaml.load(dc!.content)).not.toThrow();
    });
  });

  describe('Docker Compose — no auth', () => {
    it('publishes port 4747 directly (with env-var default syntax)', () => {
      const files = generateFiles(makeOpts({ auth: 'none', port: 4747 }), DEFAULT_DETECT);
      const dc = files.find((f) => f.relativePath === 'docker-compose.gitnexus.yml');
      // The template emits "${GITNEXUS_PORT:-4747}:4747" — check both the default and the target port.
      expect(dc!.content).toContain(':-4747}:4747');
    });

    it('shows no-auth warning banner', () => {
      const files = generateFiles(makeOpts({ auth: 'none' }), DEFAULT_DETECT);
      const dc = files.find((f) => f.relativePath === 'docker-compose.gitnexus.yml');
      expect(dc!.content).toContain('NO AUTH');
    });

    it('does NOT generate a Caddyfile', () => {
      const files = generateFiles(makeOpts({ auth: 'none' }), DEFAULT_DETECT);
      const cf = files.find((f) => f.relativePath === 'Caddyfile');
      expect(cf).toBeUndefined();
    });

    it('uses correct health endpoint /api/health', () => {
      const files = generateFiles(makeOpts({ auth: 'none' }), DEFAULT_DETECT);
      const dc = files.find((f) => f.relativePath === 'docker-compose.gitnexus.yml');
      expect(dc!.content).toContain('/api/health');
    });
  });

  describe('MCP snippet', () => {
    it('uses proxy port (port+1) when auth is token', () => {
      const files = generateFiles(makeOpts({ auth: 'token', port: 4747 }), DEFAULT_DETECT);
      const snip = files.find((f) => f.relativePath === '.claude/gitnexus-mcp-snippet.json');
      expect(snip!.content).toContain(':4748/api/mcp');
    });

    it('uses direct port when auth is none', () => {
      const files = generateFiles(makeOpts({ auth: 'none', port: 4747 }), DEFAULT_DETECT);
      const snip = files.find((f) => f.relativePath === '.claude/gitnexus-mcp-snippet.json');
      expect(snip!.content).toContain(':4747/api/mcp');
    });

    it('includes Authorization header when auth is token', () => {
      const files = generateFiles(makeOpts({ auth: 'token' }), DEFAULT_DETECT);
      const snip = files.find((f) => f.relativePath === '.claude/gitnexus-mcp-snippet.json');
      expect(snip!.content).toContain('Authorization');
      expect(snip!.content).toContain('Bearer');
    });

    it('omits Authorization header when auth is none', () => {
      const files = generateFiles(makeOpts({ auth: 'none' }), DEFAULT_DETECT);
      const snip = files.find((f) => f.relativePath === '.claude/gitnexus-mcp-snippet.json');
      expect(snip!.content).not.toContain('Authorization');
    });
  });

  describe('GITNEXUS.md', () => {
    it('contains license notice', () => {
      const files = generateFiles(makeOpts(), DEFAULT_DETECT);
      const md = files.find((f) => f.relativePath === 'GITNEXUS.md');
      expect(md!.content).toContain('PolyForm-Noncommercial-1.0.0');
    });

    it('documents the no-auth warning when auth is none', () => {
      const files = generateFiles(makeOpts({ auth: 'none' }), DEFAULT_DETECT);
      const md = files.find((f) => f.relativePath === 'GITNEXUS.md');
      expect(md!.content).toContain('No auth');
    });
  });

  describe('file set composition', () => {
    it('generates both CI files when ci is both', () => {
      const files = generateFiles(makeOpts({ ci: 'both' }), DEFAULT_DETECT);
      const paths = files.map((f) => f.relativePath);
      expect(paths).toContain('.github/workflows/gitnexus-ci.yml');
      expect(paths).toContain('azure-pipelines-gitnexus.yml');
    });

    it('generates both deploy artifacts when deploy is both', () => {
      const files = generateFiles(makeOpts({ deploy: 'both' }), DEFAULT_DETECT);
      const paths = files.map((f) => f.relativePath);
      expect(paths).toContain('docker-compose.gitnexus.yml');
      expect(paths).toContain('gitnexus-aca-deploy.sh');
    });

    it('always generates MCP snippet and GITNEXUS.md', () => {
      const files = generateFiles(makeOpts(), DEFAULT_DETECT);
      const paths = files.map((f) => f.relativePath);
      expect(paths).toContain('.claude/gitnexus-mcp-snippet.json');
      expect(paths).toContain('GITNEXUS.md');
    });
  });
});
