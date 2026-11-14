import Parser from 'tree-sitter';
import { emitDartScopeCaptures } from '../../src/core/ingestion/languages/dart/index.ts';

/** Deterministic work guards, separate from timing. In particular, a cheap
 * per-binder scan of all scopes must fail even below the timer's noise floor. */
export function captureWork(files) {
  const work = {
    parent_reads: 0,
    sibling_reads: 0,
    child_reads: 0,
    map_visits: 0,
    function_scopes: 0,
  };
  const restores = [];
  const replace = (prototype, name, descriptor) => {
    const original = Object.getOwnPropertyDescriptor(prototype, name);
    restores.push(() => Object.defineProperty(prototype, name, original));
    Object.defineProperty(prototype, name, { ...original, ...descriptor });
  };
  try {
    const prototype = Parser.SyntaxNode.prototype;
    const parent = Object.getOwnPropertyDescriptor(prototype, 'parent').get;
    replace(prototype, 'parent', {
      get() {
        work.parent_reads++;
        return parent.call(this);
      },
    });
    // Sibling getters re-descend from the root exactly like `parent`.
    for (const name of [
      'previousSibling',
      'nextSibling',
      'previousNamedSibling',
      'nextNamedSibling',
    ]) {
      const sibling = Object.getOwnPropertyDescriptor(prototype, name).get;
      replace(prototype, name, {
        get() {
          work.sibling_reads++;
          return sibling.call(this);
        },
      });
    }
    const child = prototype.namedChild;
    replace(prototype, 'namedChild', {
      value(index) {
        work.child_reads++;
        return child.call(this, index);
      },
    });
    const children = Object.getOwnPropertyDescriptor(prototype, 'namedChildren').get;
    replace(prototype, 'namedChildren', {
      get() {
        const result = children.call(this);
        work.child_reads += 1 + result.length;
        return result;
      },
    });
    for (const name of [Symbol.iterator, 'entries', 'keys', 'values']) {
      const original = Map.prototype[name];
      replace(Map.prototype, name, {
        value: function* () {
          for (const entry of original.call(this)) {
            // tree-sitter batches freshly allocated node wrappers in a Map.
            // Its size depends on native-cache/GC state, not capture work.
            const value = name === 'values' ? entry : entry?.[1];
            if (!(value instanceof Parser.SyntaxNode)) work.map_visits++;
            yield entry;
          }
        },
      });
    }
    const forEach = Map.prototype.forEach;
    replace(Map.prototype, 'forEach', {
      value(callback, receiver) {
        return forEach.call(this, (value, key, map) => {
          if (!(value instanceof Parser.SyntaxNode)) work.map_visits++;
          callback.call(receiver, value, key, map);
        });
      },
    });
    for (const file of files) {
      for (const match of emitDartScopeCaptures(file.content, file.path)) {
        if (match['@scope.function'] !== undefined) work.function_scopes++;
      }
    }
    return work;
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}
