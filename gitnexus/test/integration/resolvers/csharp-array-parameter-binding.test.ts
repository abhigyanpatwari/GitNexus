/**
 * C# array-typed parameters (CSHARP-01, #4098).
 *
 * A parameter typed `T[]` binds its `[]` spelling, and the `elementTypeOf`
 * index route peels it to `T`, so `repos[0].Save()` reaches `T.Save`. The
 * binding is deliberately narrow:
 *
 * - the element must be a plain identifier or a predefined type. A generic
 *   element (`Box<User>[]`, `Cell<User>[,]`) is not bound, because later
 *   spelling reductions would read the type argument or the generic owner as
 *   the receiver type;
 * - the parameter must belong to a scoped owner (method, constructor, local
 *   function, operator, conversion operator). Delegate, indexer,
 *   anonymous-method and lambda parameters have no scope, so their binding
 *   would land in the enclosing namespace and leak to same-named receivers in
 *   other files.
 *
 * `params T[]` is not bound either: tree-sitter-c-sharp puts its `type` and
 * `name` fields directly on `parameter_list`, with no `parameter` node, so the
 * pattern cannot match it. Its receiver stays unbound, which is what lets the
 * `UseParams` row observe a leak from the delegate.
 *
 * Classes that could be confused for each other share member names (User,
 * Repo and Box declare Save and Clone; Cell declares Save; Order and Invoice
 * declare Ship), so a wrong owner shows up as a wrong target instead of a
 * silent miss.
 */
import { describe, it, expect } from 'vitest';
import { getRelationships, useFixture } from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const MODELS = `namespace App;

public class User {
    public void Save() {}
    public User Clone() { return this; }
}

public class Repo {
    public void Save() {}
    public Repo Clone() { return this; }
}

public class Box<T> {
    public void Save() {}
    public Box<T> Clone() { return this; }
}

public class Cell<T> {
    public void Save() {}
}

public class Order {
    public void Ship() {}
}

public class Invoice {
    public void Ship() {}
}
`;

const ARRAYS = `namespace App;

public class Holder {
    // Same-named field decoy: a parameter must shadow it.
    public Repo repos;

    void IndexElement(User[] repos) {
        repos[0].Save();
    }
    void OptionalElement(User[] repos) {
        repos?[0].Save();
    }
    void LocalFunctionOwner() {
        void Inner(User[] items) {
            items[0].Save();
        }
    }
    void DirectArrayCall(User[] repos) {
        repos.Save();
    }
    void JaggedIndexedOnce(User[][] grid) {
        grid[0].Save();
    }
    void RankArray(User[,] grid) {
        grid[0, 0].Save();
    }
    void GenericRankElement(Cell<User>[,] cells) {
        cells[0, 0].Save();
    }
    void GenericArrayDirect(Box<User>[] boxes) {
        boxes.Clone();
    }
    void GenericArrayElement(Box<User>[] boxes) {
        boxes[0].Save();
    }
}
`;

// A delegate's parameter list has no scope. Its array parameter must not bind
// \`filerows\` for the sibling file in the same file-scoped namespace.
const EVENTS = `namespace App;

public delegate void FileReady(Order[] filerows);
`;

const HANDLERS = `using System;

namespace App;

public class Handlers {
    void UseParams(params Invoice[] filerows) {
        filerows[0].Ship();
    }
    void UseLambda() {
        Action<Invoice[]> f = filerows => filerows[0].Ship();
    }
}
`;

interface Row {
  readonly source: string;
  readonly member: string;
  /** Every CALLS target id of `member` from `source`, sorted. Empty = no edge. */
  readonly targets: readonly string[];
}

const ROWS: readonly Row[] = [
  // Positive: the exact element owner, not the same-named Repo field decoy.
  { source: 'IndexElement', member: 'Save', targets: ['Method:Models.cs:User.Save#0'] },
  { source: 'OptionalElement', member: 'Save', targets: ['Method:Models.cs:User.Save#0'] },
  { source: 'Inner', member: 'Save', targets: ['Method:Models.cs:User.Save#0'] },
  // The array itself has no Save. Before #4098 the unbound parameter fell
  // through to the `Repo repos` field and reached Repo.Save.
  { source: 'DirectArrayCall', member: 'Save', targets: [] },
  // Unsupported shapes stay unresolved rather than guessing an owner.
  { source: 'JaggedIndexedOnce', member: 'Save', targets: [] },
  { source: 'RankArray', member: 'Save', targets: [] },
  // Generic elements are not bound: neither the type argument (User) nor the
  // generic owner (Box) is the receiver type here.
  { source: 'GenericRankElement', member: 'Save', targets: [] },
  { source: 'GenericArrayDirect', member: 'Clone', targets: [] },
  { source: 'GenericArrayElement', member: 'Save', targets: [] },
  // The delegate's `Order[] filerows` must not leak into another file. Both
  // receivers are unbound here (`params` has no `parameter` node; lambda
  // parameters are unscoped), so any edge would come from the leak.
  { source: 'UseParams', member: 'Ship', targets: [] },
  { source: 'UseLambda', member: 'Ship', targets: [] },
];

describe.skipIf(!isLanguageAvailable(SupportedLanguages.CSharp))(
  'C# array-typed parameter binding (CSHARP-01)',
  () => {
    const result = useFixture('csharp-array-parameter-binding', {
      'Models.cs': MODELS,
      'Arrays.cs': ARRAYS,
      'Events.cs': EVENTS,
      'Handlers.cs': HANDLERS,
    });

    it.each(ROWS)('$member called from $source reaches $targets', ({ source, member, targets }) => {
      const reached = getRelationships(result(), 'CALLS')
        .filter((edge) => edge.source === source && edge.target === member)
        .map((edge) => edge.rel.targetId)
        .sort();
      expect(reached).toEqual(targets);
    });
  },
);
