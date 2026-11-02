import { describe, expect, it } from 'vitest';
import {
  assertSymbolFilePath,
  SymbolIdentityError,
} from '../../src/core/lbug/query-result-integrity.js';

describe('source UID/path consistency (#3527)', () => {
  it.each([
    ['Method:checks/test_batch.py:Batch.test_run#0', 'Sources/Unrelated.swift'],
    ['Struct:Sources/Widget.swift:Widget', 'Sources/Other.swift'],
    ['File:src/actual.ts', 'src/unrelated.ts'],
    ['Folder:src/actual', 'src/unrelated'],
    ['Function:src/actual.ts:run', 'src/actual'],
  ])('rejects a printable mixed tuple: %s', (id, filePath) => {
    expect(() => assertSymbolFilePath(id, filePath)).toThrow(SymbolIdentityError);
  });

  it.each([
    ['Method:checks/test_batch.py:Batch.test_run#0', 'checks/test_batch.py'],
    ['Struct:Sources/Widget.swift:Widget', 'Sources/Widget.swift'],
    ['File:src/part:one.ts', 'src/part:one.ts'],
    ['Folder:src/part:one', 'src/part:one'],
    ['Function:src/part:one.ts:run', 'src/part:one.ts'],
    ['Method:src/a.cpp:Owner::run#0', 'src/a.cpp'],
    ['Function:src/space .ts:run', 'src/space .ts'],
    ['func:alpha ', 'src/legacy.ts'],
    ['Function:legacy', 'src/legacy.ts'],
    ['Function:legacy:run', 'src/legacy.ts'],
    ['Class:vendor.v2:Widget', 'src/Widget.ts'],
    ['Class:objc:class:Widget', 'Sources/Widget.h'],
    ['Method:objc:method:Widget:-:load:', 'Sources/Widget.m'],
    ['Function:objc:function:helper', 'Sources/Widget.m'],
    ['Property:spring-config:application.properties:payment.timeout', 'application.properties'],
    ['CodeElement:spring-bean:Method:src/Config.java:Config.bean#0', 'src/Config.java'],
    ['CodeElement:spring-aop:Class:src/Service.java:Service:transactional', 'src/Service.java'],
    ['Route:GET:/api/items', 'src/routes.ts'],
    ['Tool:server:search', 'src/tools.ts'],
    ['Method:checks/test_batch.py:Batch.test_run#0', undefined],
    ['Method:checks/test_batch.py:Batch.test_run#0', null],
    ['Method:checks/test_batch.py:Batch.test_run#0', ''],
  ])('preserves valid paths and legacy/synthetic identities: %s / %j', (id, filePath) => {
    expect(() => assertSymbolFilePath(id, filePath)).not.toThrow();
  });
});
