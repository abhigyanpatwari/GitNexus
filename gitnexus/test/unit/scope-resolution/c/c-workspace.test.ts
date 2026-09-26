import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cScopeResolver } from '../../../../src/core/ingestion/languages/c/scope-resolver.js';
import { scanCppHeaderFiles } from '../../../../src/core/ingestion/languages/cpp/header-scan.js';
import { cppScopeResolver } from '../../../../src/core/ingestion/languages/cpp/scope-resolver.js';
import {
  C_HEADER_EXTENSIONS,
  CPP_HEADER_EXTENSIONS,
  loadCFamilyResolutionConfig,
} from '../../../../src/core/ingestion/languages/c/resolution-config.js';
import type { ImportResolutionContext } from '../../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';

const TMP = join(__dirname, '__c_workspace_tmp__');

function touch(rel: string, contents = ''): void {
  const full = join(TMP, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
}

function angle(targetRaw: string): ImportResolutionContext {
  return {
    parsedFiles: [],
    parsedImport: { kind: 'wildcard', targetRaw, isSystem: true },
  };
}

function quoted(targetRaw: string): ImportResolutionContext {
  return {
    parsedFiles: [],
    parsedImport: { kind: 'wildcard', targetRaw, isSystem: false },
  };
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('C/C++ workspace scan', () => {
  it('finds headers, skips build output, and records implicit include roots', () => {
    touch('include/util.h');
    touch('Headers/Widget.h');
    touch('inc/local.h');
    touch('src/stdio.h');
    touch('build/generated.h');
    touch('debug/generated.h');
    touch('release/generated.h');
    touch('cmake-build-debug/generated.h');
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(scanned.headers).toContain('include/util.h');
    expect(scanned.headers).toContain('src/stdio.h');
    expect(scanned.headers).not.toContain('build/generated.h');
    expect(scanned.headers).not.toContain('debug/generated.h');
    expect(scanned.headers).not.toContain('release/generated.h');
    expect(scanned.headers).not.toContain('cmake-build-debug/generated.h');
    expect(scanned.headerSearchPaths).toEqual(
      expect.arrayContaining(['include', 'Headers', 'inc']),
    );
    expect(scanned.headerSearchPaths).not.toContain('src');
  });

  it('scans C++ header extensions and still skips the build tree', () => {
    touch('include/util.hpp');
    touch('src/widget.hh');
    touch('build/generated.hpp');
    const scanned = loadCFamilyResolutionConfig(TMP, CPP_HEADER_EXTENSIONS);
    expect(scanCppHeaderFiles(TMP)).toEqual(scanned.headers);
    expect(scanned.headers).toContain('include/util.hpp');
    expect(scanned.headers).toContain('src/widget.hh');
    expect(scanned.headers).not.toContain('build/generated.hpp');
  });

  it('reads compile_commands.json and drops absolute system roots', () => {
    touch('include/util.h');
    touch('Headers/Widget.h');
    touch('private/local.h');
    touch('src/stdio.h');
    touch(
      'compile_commands.json',
      JSON.stringify([
        {
          directory: join(TMP, 'src'),
          file: 'main.c',
          command: 'gcc -I../include -isystem /usr/include -iquote ../private -c main.c',
        },
        {
          directory: TMP,
          file: 'a.c',
          arguments: ['cl', '/I', 'msvc', '/I/usr/include'],
        },
      ]),
    );
    touch('compile_flags.txt', '-Iignored\n');
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    const main = scanned.translationUnits.get('src/main.c');
    const other = scanned.translationUnits.get('a.c');
    expect(main?.headerSearchPaths).toContain('include');
    expect(main?.userHeaderSearchPaths).toEqual(['private']);
    expect(main?.headerSearchPaths).not.toContain('msvc');
    expect(other?.headerSearchPaths).toContain('msvc');
    expect(other?.headerSearchPaths).not.toContain('private');
    expect(scanned.headerSearchPaths).toContain('Headers');
    expect(scanned.headerSearchPaths).not.toContain('msvc');
    expect(scanned.headerSearchPaths).not.toContain('ignored');
    expect(scanned.headerSearchPaths.join('\n')).not.toContain('usr');
    const workspace = new Set([
      'src/main.c',
      'a.c',
      'include/util.h',
      'msvc/only.h',
      'src/stdio.h',
    ]);
    expect(
      cScopeResolver.resolveImportTarget(
        'util.h',
        'src/main.c',
        workspace,
        scanned,
        angle('util.h'),
      ),
    ).toBe('include/util.h');
    expect(
      cScopeResolver.resolveImportTarget(
        'only.h',
        'src/main.c',
        workspace,
        scanned,
        angle('only.h'),
      ),
    ).toBeNull();
    expect(
      cScopeResolver.resolveImportTarget('only.h', 'a.c', workspace, scanned, angle('only.h')),
    ).toBe('msvc/only.h');
    expect(
      cScopeResolver.resolveImportTarget(
        'stdio.h',
        'src/main.c',
        workspace,
        scanned,
        angle('stdio.h'),
      ),
    ).toBeNull();
  });

  it('honors a .clangd CompilationDatabase and still applies CompileFlags.Add', () => {
    touch('extras/extra.h');
    touch('fromdb/db.h');
    touch(
      '.clangd',
      ['CompilationDatabase: build', 'CompileFlags:', '  Add: [-Iextras]', ''].join('\n'),
    );
    touch(
      'build/compile_commands.json',
      JSON.stringify([
        {
          directory: TMP,
          arguments: ['gcc', '-Ifromdb', '-c', 'main.c'],
          file: 'main.c',
        },
      ]),
    );
    touch(
      'compile_commands.json',
      JSON.stringify([
        { directory: TMP, arguments: ['gcc', '-Iignored-root', '-c', 'main.c'], file: 'main.c' },
      ]),
    );
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    const main = scanned.translationUnits.get('main.c');
    expect(main?.headerSearchPaths).toEqual(expect.arrayContaining(['fromdb', 'extras']));
    expect(scanned.headerSearchPaths).toContain('extras');
    expect(scanned.headerSearchPaths).not.toContain('fromdb');
    expect(scanned.headerSearchPaths).not.toContain('ignored-root');
    const workspace = new Set(['main.c', 'fromdb/db.h', 'extras/extra.h']);
    expect(
      cScopeResolver.resolveImportTarget('db.h', 'main.c', workspace, scanned, angle('db.h')),
    ).toBe('fromdb/db.h');
    expect(
      cScopeResolver.resolveImportTarget('db.h', 'other.c', workspace, scanned, angle('db.h')),
    ).toBeNull();
  });

  it('reads c_cpp_properties.json includePath when no compilation database exists', () => {
    touch('src/main.c');
    touch(
      '.vscode/c_cpp_properties.json',
      JSON.stringify({
        configurations: [
          {
            name: 'Linux',
            includePath: ['${workspaceFolder}/include', '${workspaceFolder}/**'],
            compileCommands: '${workspaceFolder}/missing/compile_commands.json',
          },
        ],
      }),
    );
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(scanned.headerSearchPaths).toContain('include');
    expect(scanned.headerSearchPaths).not.toContain('src');
  });

  it('reads compile_flags.txt and .ccls as the fallback flag files', () => {
    touch(
      'compile_flags.txt',
      ['-Iinclude', '-isystem', '/usr/include', '-iquote', 'private'].join('\n'),
    );
    touch('.ccls', ['%clang', '-Ithird'].join('\n'));
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(scanned.headerSearchPaths).toEqual(expect.arrayContaining(['include', 'third']));
    expect(scanned.userHeaderSearchPaths).toEqual(['private']);
    expect(scanned.headerSearchPaths.join('\n')).not.toContain('usr');
  });
});

describe('C/C++ workspace import resolution', () => {
  const files = new Set([
    'src/stdio.h',
    'src/cstdio.h',
    'include/util.h',
    'include/util.hpp',
    'src/main.c',
    'src/main.cpp',
  ]);

  it('lets a quoted include resolve and refuses an angle include that only matches by name', () => {
    touch('src/stdio.h');
    touch('include/util.h');
    touch('src/main.c');
    const loaded = cScopeResolver.loadResolutionConfig?.(TMP);
    expect(loaded).toEqual(
      expect.objectContaining({ headerSearchPaths: expect.arrayContaining(['include']) }),
    );
    expect(
      cScopeResolver.resolveImportTarget('stdio.h', 'src/main.c', files, loaded, angle('stdio.h')),
    ).toBeNull();
    expect(
      cScopeResolver.resolveImportTarget('util.h', 'src/main.c', files, loaded, quoted('util.h')),
    ).toBe('include/util.h');
  });

  it('resolves an angle include on one declared include root', () => {
    const config = {
      headers: new Set(['include/util.h', 'src/stdio.h']),
      headerSearchPaths: ['include'],
      userHeaderSearchPaths: [],
    };
    expect(
      cScopeResolver.resolveImportTarget('util.h', 'src/main.c', files, config, angle('util.h')),
    ).toBe('include/util.h');
    expect(
      cppScopeResolver.resolveImportTarget(
        'util.hpp',
        'src/main.cpp',
        files,
        {
          headers: new Set(['include/util.hpp', 'src/cstdio.h']),
          headerSearchPaths: ['include'],
          userHeaderSearchPaths: [],
        },
        angle('util.hpp'),
      ),
    ).toBe('include/util.hpp');
    expect(
      cppScopeResolver.resolveImportTarget(
        'cstdio.h',
        'src/main.cpp',
        files,
        {
          headers: new Set(['include/util.hpp', 'src/cstdio.h']),
          headerSearchPaths: ['include'],
          userHeaderSearchPaths: [],
        },
        angle('cstdio.h'),
      ),
    ).toBeNull();
  });

  it('accepts a raw header set so the import-target bench shape still resolves', () => {
    const sources = new Set(['src/main.c']);
    const headers = new Set(['include/util.h', 'src/stdio.h']);
    expect(cScopeResolver.resolveImportTarget('util.h', 'src/main.c', sources, headers)).toBe(
      'include/util.h',
    );
    expect(
      cScopeResolver.resolveImportTarget(
        'stdio.h',
        'src/main.c',
        sources,
        headers,
        angle('stdio.h'),
      ),
    ).toBeNull();
  });

  it('keeps -iquote off the angle search', () => {
    const config = {
      headers: new Set(['private/util.h']),
      headerSearchPaths: [],
      userHeaderSearchPaths: ['private'],
    };
    const workspace = new Set(['src/main.c', 'private/util.h']);
    expect(
      cScopeResolver.resolveImportTarget(
        'util.h',
        'src/main.c',
        workspace,
        config,
        quoted('util.h'),
      ),
    ).toBe('private/util.h');
    expect(
      cScopeResolver.resolveImportTarget(
        'util.h',
        'src/main.c',
        workspace,
        config,
        angle('util.h'),
      ),
    ).toBeNull();
  });
});

describe('C/C++ include robustness', () => {
  it('tries the shallower implicit include root first', () => {
    touch('include/util.h');
    touch('deps/include/util.h');
    touch('src/main.c');
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(scanned.headerSearchPaths.indexOf('include')).toBeLessThan(
      scanned.headerSearchPaths.indexOf('deps/include'),
    );
    const workspace = new Set(['src/main.c', 'include/util.h', 'deps/include/util.h']);
    expect(
      cScopeResolver.resolveImportTarget(
        'util.h',
        'src/main.c',
        workspace,
        scanned,
        angle('util.h'),
      ),
    ).toBe('include/util.h');
  });

  it('keeps Windows backslashes in a compile_commands command string', () => {
    touch('include/util.h');
    touch('src/main.c');
    touch(
      'compile_commands.json',
      JSON.stringify([
        {
          directory: join(TMP, 'src'),
          file: 'main.c',
          command: 'gcc -I..\\include -c main.c',
        },
      ]),
    );
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(scanned.translationUnits.get('src/main.c')?.headerSearchPaths).toContain('include');
    const workspace = new Set(['src/main.c', 'include/util.h']);
    expect(
      cScopeResolver.resolveImportTarget(
        'util.h',
        'src/main.c',
        workspace,
        scanned,
        angle('util.h'),
      ),
    ).toBe('include/util.h');
  });

  it('does not treat bazel-out include directories as search roots', () => {
    touch('include/api.h');
    touch('bazel-out/k8-fastbuild/bin/include/api.h');
    touch('src/main.c');
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(scanned.headers).toContain('include/api.h');
    expect(scanned.headers).not.toContain('bazel-out/k8-fastbuild/bin/include/api.h');
    expect(scanned.headerSearchPaths).toContain('include');
    expect(scanned.headerSearchPaths.join('\n')).not.toContain('bazel-out');
    const workspace = new Set([
      'src/main.c',
      'include/api.h',
      'bazel-out/k8-fastbuild/bin/include/api.h',
    ]);
    expect(
      cScopeResolver.resolveImportTarget('api.h', 'src/main.c', workspace, scanned, angle('api.h')),
    ).toBe('include/api.h');
  });

  it('falls through to compile_flags.txt when compile_commands.json is not JSON', () => {
    touch('compile_commands.json', '{ this is not json');
    touch('compile_flags.txt', '-Iinclude\n');
    touch('include/util.h');
    touch('src/main.c');
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(scanned.translationUnits.size).toBe(0);
    expect(scanned.headerSearchPaths).toContain('include');
    const workspace = new Set(['src/main.c', 'include/util.h']);
    expect(
      cScopeResolver.resolveImportTarget(
        'util.h',
        'src/main.c',
        workspace,
        scanned,
        angle('util.h'),
      ),
    ).toBe('include/util.h');
  });

  it('does not let an angle include climb out of its search root', () => {
    const config = {
      headers: new Set(['src/stdio.h', 'include/util.h']),
      headerSearchPaths: ['include'],
      userHeaderSearchPaths: [],
    };
    const workspace = new Set(['src/main.c', 'src/stdio.h', 'include/util.h']);
    expect(
      cScopeResolver.resolveImportTarget(
        '../../src/stdio.h',
        'src/main.c',
        workspace,
        config,
        angle('../../src/stdio.h'),
      ),
    ).toBeNull();
  });
});
