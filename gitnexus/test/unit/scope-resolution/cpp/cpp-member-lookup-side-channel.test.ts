import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyCppMemberLookupSideChannel,
  clearCppMemberLookupState,
  collectCppMemberLookupSideChannel,
  type CppMemberLookupSideChannel,
} from '../../../../src/core/ingestion/languages/cpp/member-lookup.js';
import { cppProvider } from '../../../../src/core/ingestion/languages/c-cpp.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import {
  collectCppCaptureSideChannel,
  type CppCaptureSideChannel,
} from '../../../../src/core/ingestion/languages/cpp/capture-side-channel.js';

describe('C++ member-lookup capture side-channel', () => {
  beforeEach(() => {
    clearCppMemberLookupState();
  });

  it('preserves qualified base identities through a worker-style JSON round trip', () => {
    const snapshot: CppMemberLookupSideChannel = {
      baseEdges: [
        {
          childName: 'Derived',
          childQualifiedName: 'app.Derived',
          baseName: 'Base',
          baseQualifiedName: 'detail.Base',
          isVirtual: true,
        },
      ],
      memberUsings: [
        {
          childName: 'Derived',
          childQualifiedName: 'app.Derived',
          baseName: 'Base',
          baseQualifiedName: 'detail.Base',
          memberName: 'select',
        },
      ],
    };
    const throughWorker = JSON.parse(JSON.stringify(snapshot)) as CppMemberLookupSideChannel;

    applyCppMemberLookupSideChannel('main.cpp', throughWorker);

    expect(collectCppMemberLookupSideChannel('main.cpp')).toEqual(snapshot);
  });

  it('retains namespace using positions while keeping inline-method facts out of member using', () => {
    const parsed = extractParsedFile(
      cppProvider,
      `struct Derived : Base {
  using Base::run;
  void call() { using helpers::work; work(); }
};`,
      'main.cpp',
    );
    const snapshot = JSON.parse(
      JSON.stringify(collectCppCaptureSideChannel('main.cpp')),
    ) as CppCaptureSideChannel;
    expect(snapshot.memberLookup.memberUsings.map((using) => using.memberName)).toEqual(['run']);
    expect(snapshot.usingDeclarations).toEqual([
      {
        namespace: 'helpers',
        name: 'work',
        range: { startLine: 3, startCol: 16, endLine: 3, endCol: 36 },
      },
    ]);
    expect(parsed?.parsedImports).toEqual([]);
  });
});
