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
      ['CompileFlags:', '  CompilationDatabase: build', '  Add: [-Iextras]', ''].join('\n'),
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
    const workspace = new Set(['main.c', 'util.h', 'lib/other.c', 'fromdb/db.h', 'extras/extra.h']);
    expect(
      cScopeResolver.resolveImportTarget('db.h', 'main.c', workspace, scanned, angle('db.h')),
    ).toBe('fromdb/db.h');
    // A header beside the listed translation unit uses that unit's -I.
    expect(
      cScopeResolver.resolveImportTarget('db.h', 'util.h', workspace, scanned, angle('db.h')),
    ).toBe('fromdb/db.h');
    // A file in another directory is not covered by this database entry.
    expect(
      cScopeResolver.resolveImportTarget('db.h', 'lib/other.c', workspace, scanned, angle('db.h')),
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
    expect(scanned.headerSearchPaths).not.toContain('');
    expect(scanned.headerSearchPaths).not.toContain('src');
  });

  it('keeps an in-repo include root named ..headers and still drops a parent escape', () => {
    touch('..headers/util.h');
    touch('compile_flags.txt', ['-I..headers', '-I..', '-I../outside'].join('\n'));
    const scanned = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(scanned.headerSearchPaths).toContain('..headers');
    expect(scanned.headerSearchPaths).not.toContain('..');
    expect(scanned.headerSearchPaths.join('\n')).not.toContain('../outside');
    const workspace = new Set(['src/main.c', '..headers/util.h']);
    expect(
      cScopeResolver.resolveImportTarget(
        'util.h',
        'src/main.c',
        workspace,
        scanned,
        angle('util.h'),
      ),
    ).toBe('..headers/util.h');
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

describe('C/C++ monorepo config', () => {
  function resolveAngle(
    config: ReturnType<typeof loadCFamilyResolutionConfig>,
    targetRaw: string,
    fromFile: string,
    workspace: ReadonlySet<string>,
  ): string | null {
    return cScopeResolver.resolveImportTarget(
      targetRaw,
      fromFile,
      workspace,
      config,
      angle(targetRaw),
    );
  }

  it('reads a compile_commands.json in each sub-project and lets the nearest one win', () => {
    touch('libs/a/public/a.h');
    touch('libs/b/api/b.h');
    touch('libs/a/src/a.c');
    touch('libs/b/src/b.c');
    touch(
      'compile_commands.json',
      JSON.stringify([
        { directory: TMP, file: 'libs/a/src/a.c', arguments: ['cc', '-Iroot-only', '-c'] },
      ]),
    );
    touch(
      'libs/a/compile_commands.json',
      JSON.stringify([
        { directory: join(TMP, 'libs/a'), file: 'src/a.c', arguments: ['cc', '-Ipublic', '-c'] },
      ]),
    );
    touch(
      'libs/b/build/compile_commands.json',
      JSON.stringify([
        { directory: join(TMP, 'libs/b'), file: 'src/b.c', arguments: ['cc', '-Iapi', '-c'] },
      ]),
    );
    const config = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(config.translationUnits.get('libs/a/src/a.c')?.headerSearchPaths).toEqual([
      'libs/a/public',
    ]);
    expect(config.translationUnits.get('libs/b/src/b.c')?.headerSearchPaths).toEqual([
      'libs/b/api',
    ]);
    const workspace = new Set([
      'libs/a/src/a.c',
      'libs/b/src/b.c',
      'libs/a/public/a.h',
      'libs/b/api/b.h',
    ]);
    expect(resolveAngle(config, 'a.h', 'libs/a/src/a.c', workspace)).toBe('libs/a/public/a.h');
    expect(resolveAngle(config, 'b.h', 'libs/b/src/b.c', workspace)).toBe('libs/b/api/b.h');
    expect(resolveAngle(config, 'b.h', 'libs/a/src/a.c', workspace)).toBeNull();
  });

  it('scopes a sub-project compile_flags.txt to its own subtree', () => {
    touch('libs/a/compile_flags.txt', '-Ipublic\n-iquote\nquoted\n');
    touch('libs/a/public/a.h');
    touch('libs/a/src/a.c');
    touch('libs/b/src/b.c');
    const config = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(config.directoryScopes.get('libs/a')).toEqual({
      headerSearchPaths: ['libs/a/public'],
      userHeaderSearchPaths: ['libs/a/quoted'],
    });
    expect(config.headerSearchPaths).not.toContain('libs/a/public');
    const workspace = new Set(['libs/a/src/a.c', 'libs/b/src/b.c', 'libs/a/public/a.h']);
    expect(resolveAngle(config, 'a.h', 'libs/a/src/a.c', workspace)).toBe('libs/a/public/a.h');
    expect(resolveAngle(config, 'a.h', 'libs/b/src/b.c', workspace)).toBeNull();
  });

  it('reads CMake include_directories and target_include_directories by visibility', () => {
    touch(
      'CMakeLists.txt',
      [
        'project(mono C)',
        'include_directories(common)',
        'add_subdirectory(libs/net)',
        'add_subdirectory(libs/other)',
        'add_executable(app app/main.c)',
        'target_link_libraries(app PRIVATE net)',
      ].join('\n'),
    );
    touch(
      'libs/net/CMakeLists.txt',
      [
        '# include_directories(commented-out)',
        'add_library(net src/net.c)',
        'target_include_directories(net',
        '  PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/api> $<INSTALL_INTERFACE:include>',
        '  PRIVATE src/internal ${CMAKE_CURRENT_BINARY_DIR}/gen',
        '  INTERFACE "${PROJECT_SOURCE_DIR}/shared")',
      ].join('\n'),
    );
    touch('common/common.h');
    touch('shared/shared.h');
    touch('libs/net/api/net.h');
    touch('libs/net/src/internal/internal.h');
    touch('libs/net/src/net.c');
    touch('app/main.c');
    touch('include/guess.h');
    touch('libs/other/src/other.c');
    touch('libs/other/CMakeLists.txt', 'add_library(other src/other.c)\n');
    const config = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(config.headerSearchPaths).toEqual(['common']);
    expect(config.directoryScopes.get('libs/net')?.headerSearchPaths).toEqual([
      'common',
      'libs/net/api',
      'libs/net/src/internal',
    ]);
    const workspace = new Set([
      'app/main.c',
      'libs/net/src/net.c',
      'common/common.h',
      'shared/shared.h',
      'libs/net/api/net.h',
      'libs/net/src/internal/internal.h',
      'include/guess.h',
      'libs/other/src/other.c',
    ]);
    expect(resolveAngle(config, 'net.h', 'app/main.c', workspace)).toBe('libs/net/api/net.h');
    expect(resolveAngle(config, 'shared.h', 'app/main.c', workspace)).toBe('shared/shared.h');
    expect(resolveAngle(config, 'net.h', 'libs/other/src/other.c', workspace)).toBeNull();
    expect(resolveAngle(config, 'shared.h', 'libs/other/src/other.c', workspace)).toBeNull();
    expect(resolveAngle(config, 'common.h', 'libs/net/src/net.c', workspace)).toBe(
      'common/common.h',
    );
    expect(resolveAngle(config, 'internal.h', 'libs/net/src/net.c', workspace)).toBe(
      'libs/net/src/internal/internal.h',
    );
    expect(resolveAngle(config, 'internal.h', 'app/main.c', workspace)).toBeNull();
    // Declared roots exist, so the implicit `include/` guess is off.
    expect(resolveAngle(config, 'guess.h', 'app/main.c', workspace)).toBeNull();
  });

  it('keeps the implicit include roots off a file the compilation database lists', () => {
    touch('include/guess.h');
    touch('src/main.c');
    touch(
      'compile_commands.json',
      JSON.stringify([{ directory: TMP, file: 'src/main.c', arguments: ['cc', '-c'] }]),
    );
    const config = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(config.translationUnits.get('src/main.c')?.headerSearchPaths).toEqual([]);
    expect(config.headerSearchPaths).toEqual(['include']);
    const workspace = new Set(['src/main.c', 'include/guess.h']);
    expect(resolveAngle(config, 'guess.h', 'src/main.c', workspace)).toBeNull();
    // The header is not a database key. Implicit `include/` must not bind it.
    expect(resolveAngle(config, 'guess.h', 'include/other.h', workspace)).toBeNull();
  });

  it('uses the listed translation unit -I for a header in the same directory', () => {
    touch('generated/real.h');
    touch('include/stdio.h');
    touch('src/main.c');
    touch('src/util.h');
    touch(
      'compile_commands.json',
      JSON.stringify([
        {
          directory: TMP,
          file: 'src/main.c',
          arguments: ['cc', '-Igenerated', '-c', 'src/main.c'],
        },
      ]),
    );
    const config = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    const workspace = new Set(['src/main.c', 'src/util.h', 'generated/real.h', 'include/stdio.h']);
    expect(resolveAngle(config, 'stdio.h', 'src/main.c', workspace)).toBeNull();
    expect(resolveAngle(config, 'real.h', 'src/main.c', workspace)).toBe('generated/real.h');
    expect(resolveAngle(config, 'stdio.h', 'src/util.h', workspace)).toBeNull();
    expect(resolveAngle(config, 'real.h', 'src/util.h', workspace)).toBe('generated/real.h');
  });

  it('does not install implicit include roots for a root flag file with no -I', () => {
    touch('include/stdio.h');
    touch('src/main.c');
    touch('compile_flags.txt', '-Wall\n');
    const config = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(config.headerSearchPaths).toEqual([]);
    const workspace = new Set(['src/main.c', 'include/stdio.h']);
    expect(resolveAngle(config, 'stdio.h', 'src/main.c', workspace)).toBeNull();
  });

  it('ignores include_directories inside a CMake bracket comment', () => {
    touch('decoy/sys.h');
    touch('src/main.c');
    touch('CMakeLists.txt', '#[[\ninclude_directories(decoy)\n]]\n');
    const config = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(config.headerSearchPaths).not.toContain('decoy');
    const workspace = new Set(['src/main.c', 'decoy/sys.h']);
    expect(resolveAngle(config, 'sys.h', 'src/main.c', workspace)).toBeNull();
  });

  it('does not treat ${workspaceFolder}/** as an empty search root', () => {
    touch('include/util.h');
    touch('src/main.c');
    touch(
      '.vscode/c_cpp_properties.json',
      JSON.stringify({
        configurations: [{ name: 'Linux', includePath: ['${workspaceFolder}/**'] }],
      }),
    );
    const config = loadCFamilyResolutionConfig(TMP, C_HEADER_EXTENSIONS);
    expect(config.headerSearchPaths).toEqual(['include']);
    expect(config.headerSearchPaths).not.toContain('');
    const workspace = new Set(['src/main.c', 'include/util.h']);
    expect(resolveAngle(config, 'util.h', 'src/main.c', workspace)).toBe('include/util.h');
  });
});
