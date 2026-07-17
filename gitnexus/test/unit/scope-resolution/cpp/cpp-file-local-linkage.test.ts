/**
 * Pins the `hasFileLocalCallableLinkage` contract (#2522 review, M2): the
 * hook must answer language-level internal linkage ONLY. The name-keyed
 * file-local set is populated from every `static` declaration in a file, so
 * a class member sharing a name with a static free function was over-marked
 * — but class members have EXTERNAL linkage even when declared `static`
 * (in-class `static` means "no instance"), and refusing their cross-file
 * declaration/definition join under-links member-pointer seeds.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { SymbolDefinition } from 'gitnexus-shared';
import { cppScopeResolver } from '../../../../src/core/ingestion/languages/cpp/scope-resolver.js';
import {
  clearFileLocalNames,
  markFileLocal,
} from '../../../../src/core/ingestion/languages/cpp/file-local-linkage.js';

describe('cppScopeResolver.hasFileLocalCallableLinkage (#2522 review, M2)', () => {
  beforeEach(() => {
    clearFileLocalNames();
  });

  it('treats a static namespace-scope free function as file-local', () => {
    markFileLocal('w.cpp', 'helper');
    const def: SymbolDefinition = {
      nodeId: 'Function:w.cpp:helper#0',
      filePath: 'w.cpp',
      type: 'Function',
      qualifiedName: 'helper',
    };
    expect(cppScopeResolver.hasFileLocalCallableLinkage?.(def)).toBe(true);
  });

  it('never treats a class member as file-local, even when a same-named static free function over-marked the file', () => {
    markFileLocal('w.cpp', 'helper');
    const method: SymbolDefinition = {
      nodeId: 'Method:w.cpp:Widget.helper#0',
      filePath: 'w.cpp',
      type: 'Method',
      qualifiedName: 'Widget.helper',
    };
    expect(cppScopeResolver.hasFileLocalCallableLinkage?.(method)).toBe(false);
  });

  it('never treats a constructor as file-local', () => {
    markFileLocal('w.cpp', 'Widget');
    const ctor: SymbolDefinition = {
      nodeId: 'Constructor:w.cpp:Widget.Widget#0',
      filePath: 'w.cpp',
      type: 'Constructor',
      qualifiedName: 'Widget.Widget',
    };
    expect(cppScopeResolver.hasFileLocalCallableLinkage?.(ctor)).toBe(false);
  });
});
