import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Zig from '@tree-sitter-grammars/tree-sitter-zig';
import { getSyntaxLanguageFromFilename } from 'gitnexus-shared';
import { ZIG_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';
import { shouldIgnorePath } from '../../src/config/ignore-service.js';
import { extractFunctionName } from '../../src/core/ingestion/utils/ast-helpers.js';
import { highlightCodeHtml } from '../../../gitnexus-web/src/lib/code-highlighting';
import { shouldIgnorePath as webShouldIgnorePath } from '../../../gitnexus-web/src/config/ignore-service';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');
const nativeWasmPath = path.join(
  repoRoot,
  'gitnexus',
  'node_modules',
  '@tree-sitter-grammars',
  'tree-sitter-zig',
  'tree-sitter-zig.wasm',
);
const webWasmPath = path.join(repoRoot, 'gitnexus-web', 'public', 'wasm', 'zig', 'tree-sitter-zig.wasm');

const zigSource = `const std = @import("std");

pub const Config = struct {
    value: i32,

    pub fn init() Config {
        return .{ .value = 1 };
    }
};

pub const Payload = union(enum) {
    alpha: i32,
    beta: bool,
};

pub const FileHandle = opaque {};

export fn add(a: i32, b: i32) i32 {
    return a + b;
}

test "named" {
    _ = add(1, 2);
}

test {
    const cfg: Config = .{ .value = add(1, 2) };
    _ = cfg.value;
}
`;

const zigNestedSource = `const c = @cImport({
    @cInclude("stdio.h");
    @cInclude("stdlib.h");
});

pub const Http = struct {
    pub const Request = struct {
        value: u32,

        pub fn init() Request {
            return .{ .value = 1 };
        }
    };
};
`;

const parser = new Parser();
parser.setLanguage(Zig);

type ZigSummary = {
  definitions: string[];
  imports: string[];
  calls: string[];
};

const hashFile = (filePath: string): string =>
  createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const summarizeQuery = (queryText: string, source = zigSource): ZigSummary => {
  const tree = parser.parse(source);
  const query = new Parser.Query(Zig, queryText);
  const matches = query.matches(tree.rootNode);

  const definitions: string[] = [];
  const imports: string[] = [];
  const calls: string[] = [];

  for (const match of matches) {
    const defCapture = match.captures.find((capture: any) => capture.name.startsWith('definition.'));
    const nameCapture = match.captures.find((capture: any) => capture.name === 'name');

    if (defCapture) {
      const name = nameCapture?.node.text ?? extractFunctionName(defCapture.node).funcName;
      if (name) definitions.push(`${defCapture.name}:${name}`);
    }

    for (const capture of match.captures) {
      if (capture.name === 'import.source') imports.push(capture.node.text);
      if (capture.name === 'call.name') calls.push(capture.node.text);
    }
  }

  return {
    definitions: definitions.sort(),
    imports: imports.sort(),
    calls: calls.sort(),
  };
};

describe('Zig CLI/web parity', () => {
  it('produces the expected Zig captures for the shared fixture source', () => {
    expect(summarizeQuery(ZIG_QUERIES)).toEqual({
      definitions: [
        'definition.function:add',
        'definition.function:named',
        'definition.function:test@26',
        'definition.method:init',
        'definition.property:alpha',
        'definition.property:beta',
        'definition.property:value',
        'definition.struct:Config',
        'definition.type:FileHandle',
        'definition.union:Payload',
      ].sort(),
      imports: ['std'],
      calls: ['add', 'add'],
    });
  });

  it('maps Zig files to shared zig syntax highlighting and web Prism output', () => {
    expect(getSyntaxLanguageFromFilename('src/main.zig')).toBe('zig');
    const html = highlightCodeHtml('const value: i32 = 1;', 'zig');
    expect(html).toContain('token');
    expect(html).toContain('i32');
  });

  it('captures nested Zig containers and C interop imports', () => {
    expect(summarizeQuery(ZIG_QUERIES, zigNestedSource)).toEqual({
      definitions: [
        'definition.method:init',
        'definition.property:value',
        'definition.struct:Http',
        'definition.struct:Request',
      ].sort(),
      imports: ['stdio.h', 'stdlib.h'],
      calls: [],
    });
  });

  it('ships the same Zig WASM grammar as the native parser package', () => {
    // This suite executes queries through the native Node tree-sitter path.
    // Hash equality keeps the shipped web grammar bytes pinned to that same parser artifact.
    expect(hashFile(webWasmPath)).toBe(hashFile(nativeWasmPath));
  });

  it('keeps build.zig ignored in both CLI and web ignore services', () => {
    expect(shouldIgnorePath('build.zig')).toBe(true);
    expect(webShouldIgnorePath('build.zig')).toBe(true);
    expect(shouldIgnorePath('src/main.zig')).toBe(false);
    expect(webShouldIgnorePath('src/main.zig')).toBe(false);
  });
});
