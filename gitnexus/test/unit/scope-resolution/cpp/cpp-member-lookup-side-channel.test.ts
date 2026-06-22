import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyCppMemberLookupSideChannel,
  clearCppMemberLookupState,
  collectCppMemberLookupSideChannel,
  type CppMemberLookupSideChannel,
} from '../../../../src/core/ingestion/languages/cpp/member-lookup.js';

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
});
