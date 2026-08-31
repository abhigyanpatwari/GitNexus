import { describe, expect, it } from 'vitest';
import { groupSwiftFilesBySpmTarget } from '../../../src/core/ingestion/languages/swift/target-grouping.js';

describe('groupSwiftFilesBySpmTarget', () => {
  it('matches a later segment-aligned target prefix after an earlier partial occurrence', () => {
    const targets = new Map([['Core', 'Modules/Core']]);
    const items = ['vendor/SubModules/Core/shim/Modules/Core/Thing.swift'];

    const groups = groupSwiftFilesBySpmTarget(items, (item) => item, targets);

    expect(groups.get('Core')).toEqual(items);
    expect(groups.get('__default__')).toBeUndefined();
  });

  it('does not treat a partial path segment as a target match', () => {
    const targets = new Map([['Core', 'Modules/Core']]);
    const item = 'vendor/SubModules/Core/Thing.swift';

    const groups = groupSwiftFilesBySpmTarget([item], (value) => value, targets);

    expect(groups.get('Core')).toBeUndefined();
    expect(groups.get('__default__')).toEqual([item]);
  });

  it('keeps first-target-wins behavior when target paths overlap', () => {
    const targets = new Map([
      ['Outer', 'Sources'],
      ['Inner', 'Sources/Feature'],
    ]);
    const item = 'Sources/Feature/Thing.swift';

    const groups = groupSwiftFilesBySpmTarget([item], (value) => value, targets);

    expect(groups.get('Outer')).toEqual([item]);
    expect(groups.get('Inner')).toBeUndefined();
  });
});
