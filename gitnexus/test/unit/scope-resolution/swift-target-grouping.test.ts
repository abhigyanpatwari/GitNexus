import { describe, expect, it } from 'vitest';
import { groupSwiftFilesByModule } from '../../../src/core/ingestion/languages/swift/target-grouping.js';

// #2931 made grouping accept a target prefix found anywhere in the path, as a
// stand-in for nested-package discovery. The workspace loader now rebases every
// target to the repo root (#3355), so matching is anchored there: a repeated
// layout further down the path is a different package, not this target.
describe('groupSwiftFilesByModule — anchored target matching', () => {
  const config = { targets: new Map([['Core', 'Modules/Core']]) };

  it('does not match a target prefix that appears only further down the path', () => {
    const items = ['vendor/SubModules/Core/shim/Modules/Core/Thing.swift'];

    const groups = groupSwiftFilesByModule(items, (item) => item, config);

    expect(groups.get('Core')).toBeUndefined();
    expect(groups.get('__default__')).toEqual(items);
  });

  it('matches a target dir at the repo root even when the name repeats below it', () => {
    const items = ['Modules/Core/Thing/SubModules/Core/Thing.swift'];

    const groups = groupSwiftFilesByModule(items, (item) => item, config);

    expect(groups.get('Core')).toEqual(items);
  });

  it('does not treat a partial path segment as a target match', () => {
    const item = 'vendor/SubModules/Core/Thing.swift';

    const groups = groupSwiftFilesByModule([item], (value) => value, config);

    expect(groups.get('__default__')).toEqual([item]);
  });

  it('prefers the deepest target when target paths overlap', () => {
    const overlapping = {
      targets: new Map([
        ['Outer', 'Sources'],
        ['Inner', 'Sources/Feature'],
      ]),
    };
    const item = 'Sources/Feature/Thing.swift';

    const groups = groupSwiftFilesByModule([item], (value) => value, overlapping);

    expect(groups.get('Inner')).toEqual([item]);
    expect(groups.get('Outer')).toBeUndefined();
  });
});
