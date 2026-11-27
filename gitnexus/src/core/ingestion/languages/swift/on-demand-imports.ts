/**
 * Persisted IMPORTS edges for Swift `import X`.
 *
 * `import X` binds no name per file: it makes every declaration of module X
 * visible, so resolution keeps every file of X. Persisting a File -> File edge
 * to each of them grows with importers x module size. The edge is kept to a
 * file of X only when the importer reaches something that file declares, by
 * the way Swift reaches it (`name-facts.ts`):
 *   - a top-level declaration, by spelling its name;
 *   - an extension member, by writing its name anywhere (after a dot, or bare
 *     through an implicit `self`), and an extension subscript by its argument
 *     label (`xs[safe: 3]`);
 *   - a static member or enum case of a type body, by an implicit member
 *     (`.primary`, `case .large:`, `if case .large = size`, `.true`);
 *   - a custom operator, by using its token;
 *   - an extension that adds a conformance, an initializer, a subscript,
 *     `callAsFunction` or a standard-operator overload (or nothing), by
 *     spelling the extended type;
 *   - a type the importer reaches through a top-level `typealias` of another
 *     file of the same import: once the alias's file is kept, every file of
 *     that import declaring a type the alias names at top level is kept too.
 * The answer for a pair depends on the importer and the target, and, through
 * that one alias hop, on the alias's file; nothing else. A target without
 * facts, or whose declarations the facts do not fully model (a parse error
 * that can hide declarations, an unknown declaration form, a failure while
 * gathering), is kept for every importer. Finalized imports, and so name
 * resolution, are unchanged.
 *
 * The match is by name, not by resolution, so it can keep a file the importer
 * does not use:
 *   - an importer that writes an implicit member such as `.none` or
 *     `.default` keeps every file of the module that declares a static
 *     member or enum case of that name (a name match cannot tell `.none` of
 *     Optional from a module enum's `case none`); the cost is bounded by the
 *     files declaring the implicit names the importer writes, which is every
 *     file of a module that declares such a name in each file;
 *   - an importer that writes a name `name` keeps every extension file of the
 *     module that declares a member `name`.
 * Known drops (the edge is dropped while resolution still sees the file); a
 * CALLS or ACCESSES edge into the file remains only where noted:
 *   - a type-body instance member reached through a value of an inferred type
 *     (`let t = make(); t.run()`; CALLS/ACCESSES remain);
 *   - a superclass member reached through a subclass (`Sub().configure()`;
 *     CALLS/ACCESSES into the superclass file often remain, with no IMPORTS
 *     pair);
 *   - a protocol-extension default the importer never names, taken through a
 *     conformance (IMPLEMENTS to the protocol remains);
 *   - an implicit `.init(...)` of an inferred type;
 *   - an overload of a standard operator used on a literal or a value of
 *     inferred type, declared at the top level, or declared in a type body;
 *   - an extension subscript without a label, used through a value whose type
 *     the importer never writes;
 *   - names the compiler synthesizes or calls on the importer's behalf: `$x`
 *     and `_x` of a wrapped global, peers of attached macros, result-builder
 *     `build*` statics in an extension;
 *   - a type reached through an alias the one hop does not follow: an alias
 *     of an alias in yet another file; a `typealias` declared inside a type
 *     body or an extension (`struct Svc { typealias Model = User }` used as
 *     `Svc.Model.shared`); an alias in a file whose declarations are unknown;
 *     an alias to a type nested in an extension in another file
 *     (`typealias Bar = Outer.Inner`, `Inner` declared in `extension Outer`);
 *     an alias to a type of another imported module or another import
 *     statement (`typealias Cash = Money` in `Facade`, `Money` in `Core`);
 *     and the extension files of the aliased type (`Bar(x: 1)` with
 *     `init(x:)` declared in `extension Foo`);
 *   - a name the importer writes only inside a parse error the grammar keeps
 *     as structure (bare words left as error leaves are recorded);
 *   - the same name spelled in different Unicode normal forms (NFC/NFD).
 */

import type { ImportEdge, ParsedFile } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { onDemandTargets } from '../../scope-resolution/graph-bridge/on-demand-targets.js';
import { readSwiftNameFacts, type SwiftNameFacts } from './name-facts.js';

/** The edge kind of `import X`; `import struct X.Y` is `named` and always kept. */
export const SWIFT_ON_DEMAND_IMPORT_KINDS: readonly ImportEdge['kind'][] = ['namespace'];
const KINDS: ReadonlySet<ImportEdge['kind']> = new Set(SWIFT_ON_DEMAND_IMPORT_KINDS);

function meets(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const name of small) if (large.has(name)) return true;
  return false;
}

/** Does a file with `uses` reach anything a file with `declares` declares? */
export function swiftReaches(
  uses: NonNullable<SwiftNameFacts['uses']>,
  declares: NonNullable<SwiftNameFacts['declares']>,
): boolean {
  return (
    meets(declares.top, uses.ids) ||
    meets(declares.extTypes, uses.ids) ||
    meets(declares.ext, uses.ids) ||
    meets(declares.statics, uses.implicit) ||
    meets(declares.ops, uses.ops)
  );
}

/** `ScopeResolver.onDemandImportTargets` for Swift. Undefined (keep every
 * edge) when the importer carries no usable name facts. */
export function swiftOnDemandImportTargets(
  parsed: ParsedFile,
  indexes: ScopeResolutionIndexes,
  parsedFileOf: (filePath: string) => ParsedFile | undefined,
): ReadonlySet<string> | undefined {
  const uses = readSwiftNameFacts(parsed)?.uses;
  if (uses === undefined) return undefined;
  const declaresOf = (file: string) => {
    const target = parsedFileOf(file);
    return target === undefined ? undefined : readSwiftNameFacts(target)?.declares;
  };
  return onDemandTargets(
    parsed,
    indexes,
    KINDS,
    (targetFile) => {
      const declares = declaresOf(targetFile);
      return declares === undefined || swiftReaches(uses, declares);
    },
    // One alias hop: a kept file's `typealias Bar = Foo` also keeps the files
    // of the same import that declare `Foo` at top level.
    (keptFile) => {
      const aliasOf = declaresOf(keptFile)?.aliasOf;
      if (aliasOf === undefined || aliasOf.size === 0) return undefined;
      return (candidate) => {
        const top = declaresOf(candidate)?.top;
        return top !== undefined && meets(top, aliasOf);
      };
    },
  );
}
