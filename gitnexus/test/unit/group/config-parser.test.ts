import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadGroupConfig,
  parseGroupConfig,
  serializeGroupConfig,
} from '../../../src/core/group/config-parser.js';

const VALID_YAML = `
version: 1
name: company
description: "All company microservices"
repos:
  hr/hiring/backend: hr-hiring-backend
  hr/hiring/ui: hr-hiring-ui
links:
  - from: hr/hiring/backend
    to: hr/hiring/ui
    type: http
    contract: "/api/users"
    role: provider
packages:
  hr/common:
    npm: "@hr/common"
detect:
  http: true
  grpc: false
  topics: false
  shared_libs: true
  embedding_fallback: false
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`;

const HTTP_MAPPING_YAML = `
version: 1
name: company
repos:
  frontend: libra-client
  backend: libra-server
http_mappings:
  - from: frontend
    to:
      repo: backend
      service: order-service
    methods: [GET, POST]
    match: /api/titans/:service/:version/*rest
    when:
      service: order
      version: 1.0.0
    rewrite: /orders/*rest
`;

describe('parseGroupConfig', () => {
  it('parses valid group.yaml', () => {
    const config = parseGroupConfig(VALID_YAML);
    expect(config.name).toBe('company');
    expect(config.version).toBe(1);
    expect(Object.keys(config.repos)).toHaveLength(2);
    expect(config.repos['hr/hiring/backend']).toBe('hr-hiring-backend');
    expect(config.links).toHaveLength(1);
    expect(config.links[0].type).toBe('http');
    expect(config.links[0].role).toBe('provider');
    expect(config.packages['hr/common'].npm).toBe('@hr/common');
    expect(config.detect.http).toBe(true);
    expect(config.detect.grpc).toBe(false);
  });

  it('applies defaults for missing optional fields', () => {
    const minimal = `
version: 1
name: test
repos:
  app: my-app
`;
    const config = parseGroupConfig(minimal);
    expect(config.description).toBe('');
    expect(config.links).toEqual([]);
    expect(config.httpMappings).toEqual([]);
    expect(config.packages).toEqual({});
    expect(config.detect.http).toBe(true);
    expect(config.matching.bm25_threshold).toBe(0.7);
  });

  it('parses http mapping rules', () => {
    const config = parseGroupConfig(HTTP_MAPPING_YAML);
    expect(config.httpMappings).toHaveLength(1);
    expect(config.httpMappings[0].from).toBe('frontend');
    expect(config.httpMappings[0].to.repo).toBe('backend');
    expect(config.httpMappings[0].to.service).toBe('order-service');
    expect(config.httpMappings[0].methods).toEqual(['GET', 'POST']);
    expect(config.httpMappings[0].match).toBe('/api/titans/:service/:version/*rest');
    expect(config.httpMappings[0].when).toEqual({
      service: 'order',
      version: '1.0.0',
    });
    expect(config.httpMappings[0].rewrite).toBe('/orders/*rest');
  });

  it('accepts legacy camelCase httpMappings when loading existing YAML', () => {
    const yaml = `
version: 1
name: company
repos:
  frontend: libra-client
  backend: libra-server
httpMappings:
  - from: frontend
    to:
      repo: backend
    match: /api/titans/trading/:version{/*rest}
    rewrite: /{*rest}
`;
    const config = parseGroupConfig(yaml);
    expect(config.httpMappings).toHaveLength(1);
    expect(config.httpMappings[0].match).toBe('/api/titans/trading/:version{/*rest}');
  });

  it('serializes group config back to snake_case yaml shape', () => {
    const config = parseGroupConfig(HTTP_MAPPING_YAML);
    const serialized = serializeGroupConfig(config);
    expect(serialized).toHaveProperty('http_mappings');
    expect(serialized).not.toHaveProperty('httpMappings');
    expect(serialized).toMatchObject({
      version: 1,
      name: 'company',
      repos: {
        frontend: 'libra-client',
        backend: 'libra-server',
      },
    });
  });

  it('throws on missing required fields', () => {
    expect(() => parseGroupConfig('version: 1')).toThrow(/name.*required/i);
    expect(() => parseGroupConfig('name: test')).toThrow(/version.*required/i);
    expect(() => parseGroupConfig('version: 1\nname: test')).toThrow(/repos.*required/i);
  });

  it('allows empty repos object (fresh group before first add)', () => {
    const yaml = `version: 1
name: new-group
repos: {}
`;
    const config = parseGroupConfig(yaml);
    expect(Object.keys(config.repos)).toHaveLength(0);
  });

  it('loadGroupConfig reads group.yaml from disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-group-load-'));
    const yaml = `version: 1
name: disk-test
repos:
  a: repo-a
`;
    await fs.writeFile(path.join(dir, 'group.yaml'), yaml, 'utf-8');
    const config = await loadGroupConfig(dir);
    expect(config.name).toBe('disk-test');
    expect(config.repos.a).toBe('repo-a');
  });

  it('throws on invalid version', () => {
    expect(() => parseGroupConfig('version: 2\nname: test\nrepos:\n  a: b')).toThrow(/version/i);
  });

  it('throws on invalid link role', () => {
    const yaml = `
version: 1
name: test
repos:
  a: repo-a
  b: repo-b
links:
  - from: a
    to: b
    type: http
    contract: "/api"
    role: invalid
`;
    expect(() => parseGroupConfig(yaml)).toThrow(/role/i);
  });

  it('throws when link references non-existent repo path', () => {
    const yaml = `
version: 1
name: test
repos:
  a: repo-a
links:
  - from: a
    to: nonexistent
    type: http
    contract: "/api"
    role: provider
`;
    expect(() => parseGroupConfig(yaml)).toThrow(/nonexistent/i);
  });

  it('throws when http mapping references non-existent repo path', () => {
    const yaml = `
version: 1
name: test
repos:
  frontend: repo-a
http_mappings:
  - from: frontend
    to:
      repo: backend
    match: /api/:service/*rest
    rewrite: /svc/*rest
`;
    expect(() => parseGroupConfig(yaml)).toThrow(/backend/i);
  });
});
