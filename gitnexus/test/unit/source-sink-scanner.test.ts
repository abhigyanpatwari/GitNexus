import { describe, it, expect } from 'vitest';
import {
  SOURCE_CATALOG,
  SINK_CATALOG,
  isSourceAdjacent,
  isSinkAdjacent,
  mergeCatalogs,
  compilePatterns,
  getMatchingSources,
  getMatchingSinks,
  type UserSecurityConfig,
} from '../../src/security/catalogs.js';
import { buildSourceSinkPaths, type SourceSinkPath } from '../../src/security/source-sink-scanner.js';

describe('SOURCE_CATALOG', () => {
  it('contains user input sources', () => {
    const names = SOURCE_CATALOG.map(s => s.pattern);
    expect(names).toContain('request.json');
    expect(names).toContain('req.body');
    expect(names).toContain('request.GET');
  });

  it('each source has a category', () => {
    for (const source of SOURCE_CATALOG) {
      expect(['user_input', 'environment', 'file_read', 'network']).toContain(source.category);
    }
  });

  it('contains Go sources', () => {
    const patterns = SOURCE_CATALOG.map(s => s.pattern);
    expect(patterns).toContain('r.Body');
    expect(patterns).toContain('r.URL.Query()');
    expect(patterns).toContain('r.FormValue');
    expect(patterns).toContain('r.Header.Get');
  });

  it('contains Rust/Actix sources', () => {
    const patterns = SOURCE_CATALOG.map(s => s.pattern);
    expect(patterns).toContain('web::Json');
    expect(patterns).toContain('web::Query');
    expect(patterns).toContain('web::Path');
  });

  it('contains Spring annotation sources', () => {
    const patterns = SOURCE_CATALOG.map(s => s.pattern);
    expect(patterns).toContain('@RequestBody');
    expect(patterns).toContain('@RequestParam');
    expect(patterns).toContain('@PathVariable');
  });

  it('contains Rails sources', () => {
    const patterns = SOURCE_CATALOG.map(s => s.pattern);
    expect(patterns).toContain('params[');
  });

  it('contains Ktor sources', () => {
    const patterns = SOURCE_CATALOG.map(s => s.pattern);
    expect(patterns).toContain('call.receive');
    expect(patterns).toContain('call.parameters');
  });
});

describe('SINK_CATALOG', () => {
  it('contains dangerous sinks', () => {
    const names = SINK_CATALOG.map(s => s.pattern);
    expect(names).toContain('eval');
    expect(names).toContain('exec');
    expect(names).toContain('innerHTML');
  });

  it('each sink has an OWASP category', () => {
    for (const sink of SINK_CATALOG) {
      expect(sink.owasp).toBeDefined();
    }
  });

  it('contains Go sinks', () => {
    const patterns = SINK_CATALOG.map(s => s.pattern);
    expect(patterns).toContain('os.exec');
    expect(patterns).toContain('sql.Query');
    expect(patterns).toContain('template.HTML');
  });

  it('contains Rust sinks', () => {
    const patterns = SINK_CATALOG.map(s => s.pattern);
    expect(patterns).toContain('Command::new');
    expect(patterns).toContain('sqlx::query');
  });

  it('contains Spring sinks', () => {
    const patterns = SINK_CATALOG.map(s => s.pattern);
    expect(patterns).toContain('jdbcTemplate.query');
    expect(patterns).toContain('Runtime.exec');
  });

  it('contains Rails sinks', () => {
    const patterns = SINK_CATALOG.map(s => s.pattern);
    expect(patterns).toContain('system(');
    expect(patterns).toContain('ActiveRecord::Base.connection.execute');
  });
});

describe('isSourceAdjacent', () => {
  it('matches function that reads request body', () => {
    const content = `async function handlePOST(req) { const data = await req.json(); }`;
    expect(isSourceAdjacent('handlePOST', content)).toBe(true);
  });

  it('does not match function without user input', () => {
    const content = `function add(a, b) { return a + b; }`;
    expect(isSourceAdjacent('add', content)).toBe(false);
  });

  it('matches Go HTTP handler reading body', () => {
    const content = `func handler(w http.ResponseWriter, r *http.Request) { body := r.Body }`;
    expect(isSourceAdjacent('handler', content, 'go')).toBe(true);
  });

  it('matches Spring annotation in Java content', () => {
    const content = `public ResponseEntity create(@RequestBody UserDto dto) { return ok(); }`;
    expect(isSourceAdjacent('create', content, 'java')).toBe(true);
  });
});

describe('isSinkAdjacent', () => {
  it('matches function with database write', () => {
    const content = `async function save(data) { await prisma.grant.create({ data }); }`;
    expect(isSinkAdjacent('save', content)).toBe(true);
  });

  it('matches function with exec call', () => {
    const content = `function run(cmd) { exec(cmd); }`;
    expect(isSinkAdjacent('run', content)).toBe(true);
  });

  it('does not match safe function', () => {
    const content = `function format(s) { return s.trim(); }`;
    expect(isSinkAdjacent('format', content)).toBe(false);
  });

  it('matches Go sql.Query sink', () => {
    const content = `func getUser(db *sql.DB, id string) { rows, _ := db.sql.Query("SELECT * FROM users WHERE id=" + id) }`;
    expect(isSinkAdjacent('getUser', content, 'go')).toBe(true);
  });

  it('matches Rust Command::new sink', () => {
    const content = `fn run_cmd(input: &str) { Command::new(input).output().unwrap(); }`;
    expect(isSinkAdjacent('run_cmd', content, 'rust')).toBe(true);
  });
});

describe('mergeCatalogs', () => {
  it('returns built-in catalogs when user config is null', () => {
    const result = mergeCatalogs(null);
    expect(result.sources).toEqual(SOURCE_CATALOG);
    expect(result.sinks).toEqual(SINK_CATALOG);
  });

  it('merges user-defined sources with built-in catalog', () => {
    const userConfig: UserSecurityConfig = {
      sources: [
        { pattern: 'myCustomInput', category: 'user_input', description: 'Custom input source' },
      ],
    };
    const result = mergeCatalogs(userConfig);
    expect(result.sources.length).toBe(SOURCE_CATALOG.length + 1);
    expect(result.sources[result.sources.length - 1].pattern).toBe('myCustomInput');
  });

  it('merges user-defined sinks with built-in catalog', () => {
    const userConfig: UserSecurityConfig = {
      sinks: [
        { pattern: 'dangerousOp', owasp: 'A03-injection', severity: 'high', description: 'Custom sink' },
      ],
    };
    const result = mergeCatalogs(userConfig);
    expect(result.sinks.length).toBe(SINK_CATALOG.length + 1);
    expect(result.sinks[result.sinks.length - 1].pattern).toBe('dangerousOp');
  });

  it('merged catalogs work with compilePatterns and getMatchingSources', () => {
    const userConfig: UserSecurityConfig = {
      sources: [
        { pattern: 'myCustomInput', category: 'user_input', description: 'Custom input source' },
      ],
      sinks: [
        { pattern: 'dangerousOp', owasp: 'A03-injection', severity: 'high', description: 'Custom sink' },
      ],
    };
    const merged = mergeCatalogs(userConfig);
    const compiledSources = compilePatterns(merged.sources);
    const compiledSinks = compilePatterns(merged.sinks);

    // User-defined source should be detected
    const content = `function handle() { const data = myCustomInput(); dangerousOp(data); }`;
    const matchedSources = getMatchingSources(content, undefined, compiledSources);
    expect(matchedSources.some(s => s.pattern === 'myCustomInput')).toBe(true);

    // User-defined sink should be detected
    const matchedSinks = getMatchingSinks(content, undefined, compiledSinks);
    expect(matchedSinks.some(s => s.pattern === 'dangerousOp')).toBe(true);
  });

  it('does not modify built-in catalog arrays', () => {
    const originalSourceCount = SOURCE_CATALOG.length;
    const originalSinkCount = SINK_CATALOG.length;
    mergeCatalogs({
      sources: [{ pattern: 'x', category: 'user_input', description: 'test' }],
      sinks: [{ pattern: 'y', owasp: 'A03-injection', severity: 'high', description: 'test' }],
    });
    expect(SOURCE_CATALOG.length).toBe(originalSourceCount);
    expect(SINK_CATALOG.length).toBe(originalSinkCount);
  });
});

describe('buildSourceSinkPaths', () => {
  it('finds path from source to sink through CALLS chain', () => {
    const sources = [{ id: 'func:handlePOST', name: 'handlePOST', filePath: 'route.ts', sourcePatterns: ['req.body'] }];
    const sinks = [{ id: 'func:createGrant', name: 'createGrant', filePath: 'service.ts', sinkPatterns: ['prisma.'], owasp: 'A03-injection' as const }];
    const callsGraph = new Map([
      ['func:handlePOST', ['func:validateInput']],
      ['func:validateInput', ['func:createGrant']],
    ]);

    const paths = buildSourceSinkPaths(sources, sinks, callsGraph, 5);
    expect(paths).toHaveLength(1);
    expect(paths[0].source.name).toBe('handlePOST');
    expect(paths[0].sink.name).toBe('createGrant');
    expect(paths[0].path).toEqual(['func:handlePOST', 'func:validateInput', 'func:createGrant']);
    expect(paths[0].depth).toBe(2);
  });

  it('returns empty when no path exists', () => {
    const sources = [{ id: 'func:a', name: 'a', filePath: 'a.ts', sourcePatterns: ['req.body'] }];
    const sinks = [{ id: 'func:z', name: 'z', filePath: 'z.ts', sinkPatterns: ['eval'], owasp: 'A03-injection' as const }];
    const callsGraph = new Map([
      ['func:a', ['func:b']],
      // func:b doesn't call func:z
    ]);

    const paths = buildSourceSinkPaths(sources, sinks, callsGraph, 5);
    expect(paths).toHaveLength(0);
  });

  it('respects maxDepth', () => {
    const sources = [{ id: 'func:a', name: 'a', filePath: 'a.ts', sourcePatterns: ['req.body'] }];
    const sinks = [{ id: 'func:d', name: 'd', filePath: 'd.ts', sinkPatterns: ['eval'], owasp: 'A03-injection' as const }];
    const callsGraph = new Map([
      ['func:a', ['func:b']],
      ['func:b', ['func:c']],
      ['func:c', ['func:d']],
    ]);

    // maxDepth 2 should not reach func:d (3 hops away)
    const paths = buildSourceSinkPaths(sources, sinks, callsGraph, 2);
    expect(paths).toHaveLength(0);

    // maxDepth 3 should find it
    const paths3 = buildSourceSinkPaths(sources, sinks, callsGraph, 3);
    expect(paths3).toHaveLength(1);
  });
});
