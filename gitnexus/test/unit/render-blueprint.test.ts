/**
 * Invariants of the repo-root `render.yaml`, which nothing else in CI parses.
 *
 * Two kinds: couplings the Blueprint documents but cannot enforce
 * (`disk.mountPath` = `GITNEXUS_HOME`, `PORT` = the port `Dockerfile.cli` binds),
 * and the choices that keep the deploy closed (the API server is private, the
 * public proxy always has a token). Without these, a plausible-looking edit puts
 * the API back on the internet with every other test green.
 *
 * Full schema conformance is `render blueprints validate render.yaml`, which
 * needs network and an account; checked here is only the pragma pointing at it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const blueprintSource = readFileSync(path.join(monorepoRoot, 'render.yaml'), 'utf8');
const dockerfileSource = readFileSync(path.join(monorepoRoot, 'Dockerfile.cli'), 'utf8');

const SCHEMA_PRAGMA = '# yaml-language-server: $schema=https://render.com/schema/render.yaml.json';

interface EnvVar {
  key: string;
  value?: string | number;
  generateValue?: boolean;
  fromService?: { type?: string; name?: string; property?: string };
}

interface Service {
  type: string;
  name: string;
  envVars?: EnvVar[];
  disk?: { mountPath?: string };
}

interface Blueprint {
  projects?: { environments?: { services?: Service[] }[] }[];
  services?: Service[];
}

const blueprint = load(blueprintSource) as Blueprint;

/** Services sit under projects → environments, or at the top level. */
const services: Service[] = [
  ...(blueprint.services ?? []),
  ...(blueprint.projects ?? []).flatMap((project) =>
    (project.environments ?? []).flatMap((environment) => environment.services ?? []),
  ),
];

/**
 * Every key and value in the document, comments excluded by construction —
 * parsing drops them. The Blueprint documents in comments what it deliberately
 * does NOT set, and those comments are what stop the next editor re-adding it,
 * so a mention in prose is the documentation and a mention here is the bug.
 * Covers shapes the interfaces above don't model (envVarGroups, dockerCommand).
 */
const blueprintData = JSON.stringify(blueprint);

const envVarKeys = services.flatMap((service) => (service.envVars ?? []).map((entry) => entry.key));

const SERVER = 'gitnexus-server';
const WEB = 'gitnexus-web';

/** Looked up per test, so a rename fails each assertion with its own message. */
function serviceNamed(name: string): Service {
  const match = services.find((service) => service.name === name);
  if (!match) {
    throw new Error(
      `render.yaml has no service named "${name}". If the rename is intentional, ` +
        'update this test — the invariants below are about that service.',
    );
  }
  return match;
}

function envVar(service: Service, key: string): EnvVar | undefined {
  return (service.envVars ?? []).find((entry) => entry.key === key);
}

/** Absent as an env var name, and absent anywhere else in the document. */
function expectNeverSet(pattern: RegExp): void {
  expect(envVarKeys.filter((key) => pattern.test(key))).toEqual([]);
  expect(blueprintData).not.toMatch(pattern);
}

describe('render.yaml ↔ Dockerfile.cli couplings', () => {
  it('mounts the disk at GITNEXUS_HOME', () => {
    // One key of a multi-line `ENV`.
    const home = /^\s*(?:ENV\s+)?GITNEXUS_HOME=(\S+)/m.exec(dockerfileSource)?.[1];
    expect(home, 'Dockerfile.cli must set GITNEXUS_HOME').toBeTruthy();
    expect(serviceNamed(SERVER).disk?.mountPath).toBe(home);
  });

  it('routes to the port the image binds', () => {
    // ... --port \"${PORT:-4747}\" — the backslashes are literal in the CMD.
    const dockerfilePort = /--port\s+\\?"?\$\{PORT:-(\d+)\}/.exec(dockerfileSource)?.[1];
    expect(dockerfilePort, "Dockerfile.cli's CMD must bind a default port").toBeTruthy();
    const port = envVar(serviceNamed(SERVER), 'PORT')?.value;
    expect(port, 'render.yaml must set PORT on gitnexus-server').toBeDefined();
    expect(String(port)).toBe(dockerfilePort);
  });
});

describe('render.yaml topology', () => {
  it('keeps the API server off the internet', () => {
    // `web` would give `serve` a public URL, and `serve` has no auth of its own.
    expect(serviceNamed(SERVER).type).toBe('pserv');
  });

  it('never sets GITNEXUS_PUBLIC_ORIGIN', () => {
    // `serve` refuses to start with it set and no serve-native auth
    // (assertServeAuthForPublicOrigin), and behind the proxy it has no job.
    expectNeverSet(/GITNEXUS_PUBLIC_ORIGIN/);
  });

  it('ships no Azure DevOps credential knob', () => {
    // A token holder could POST /api/analyze an Azure URL, spend the operator's
    // PAT, then read the private repo back through /api/file and /api/grep.
    expectNeverSet(/AZURE_DEVOPS_/);
  });

  it('points the proxy at the private server over the private network', () => {
    expect(envVar(serviceNamed(WEB), 'GITNEXUS_UPSTREAM_URL')?.fromService).toMatchObject({
      type: 'pserv',
      name: SERVER,
      property: 'hostport',
    });
  });

  it('always generates an edge token for the public proxy', () => {
    // docker-server.mjs refuses to start with an upstream and no token, so this
    // line is what makes the one-click deploy authenticated rather than broken.
    expect(envVar(serviceNamed(WEB), 'GITNEXUS_SERVE_AUTH_TOKEN')?.generateValue).toBe(true);
  });

  it('declares the schema so editors and `render blueprints validate` find it', () => {
    expect(blueprintSource.split('\n')[0]).toBe(SCHEMA_PRAGMA);
  });
});
