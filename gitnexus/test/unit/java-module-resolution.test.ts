/**
 * Java import resolution against declared packages (#2953).
 *
 * The property: an import names a type in a package, and what puts a file in a
 * package is that file's own `package` declaration. Every arm below is a case
 * where the answer differs from what the file's PATH suggests — which is the
 * point, because path shape is what the previous resolver used and why it could
 * not tell a JDK import from a local one.
 */
import { describe, it, expect } from 'vitest';
import {
  buildJavaPackageIndex,
  resolveJavaModule,
  type JavaPackageIndex,
} from '../../src/core/ingestion/languages/java/module-resolution.js';
import { interpretJavaImport } from '../../src/core/ingestion/languages/java/interpret.js';
import type { JvmPackageFact } from '../../src/core/ingestion/languages/jvm/package-facts.js';
import type { Capture, CaptureMatch, ParsedFile } from 'gitnexus-shared';

/** Build an index from `filePath -> declared package`. */
function indexOf(declarations: Readonly<Record<string, string | null>>): JavaPackageIndex {
  const parsedFiles = Object.keys(declarations).map(
    (filePath) => ({ filePath }) as unknown as ParsedFile,
  );
  const packageOf = (filePath: string): JvmPackageFact | undefined => {
    const declared = declarations[filePath];
    if (declared === undefined) return undefined;
    // `null` models a malformed package header, which `extractJvmPackageFact`
    // reports as `unknown` — the file is in no package anyone can name.
    return declared === null ? { status: 'unknown' } : { status: 'known', packageName: declared };
  };
  return buildJavaPackageIndex(parsedFiles, packageOf);
}

function capture(text: string): Capture {
  return { text } as Capture;
}

const WORKSPACE = indexOf({
  'src/main/java/com/example/App.java': 'com.example',
  'src/main/java/com/example/Utils.java': 'com.example',
  'src/main/java/com/example/model/User.java': 'com.example.model',
  'src/main/java/com/example/model/Order.java': 'com.example.model',
  // Path and package deliberately disagree: this is legal Java, and the
  // declaration is what counts.
  'weird/place/Detached.java': 'com.example.detached',
  // A file whose PATH looks like the JDK's but which declares its own package.
  'vendor/java/util/List.java': 'vendor.java.util',
});

describe('type imports', () => {
  it('resolves a type to the file declaring its package', () => {
    expect(resolveJavaModule('com.example.model.User', WORKSPACE)).toBe(
      'src/main/java/com/example/model/User.java',
    );
  });

  it('resolves a file whose path does not match its package', () => {
    // Nothing about `weird/place/Detached.java` suggests `com.example.detached`
    // except the declaration, which is exactly what a path matcher cannot read.
    expect(resolveJavaModule('com.example.detached.Detached', WORKSPACE)).toBe(
      'weird/place/Detached.java',
    );
  });

  it('resolves a static member import to the type that owns it', () => {
    // `com.example.Utils` is the type; `format` is a member inside it. The
    // longest DECLARED package prefix is `com.example`, so the split lands
    // there rather than treating `Utils` as a package.
    expect(resolveJavaModule('com.example.Utils.format', WORKSPACE)).toBe(
      'src/main/java/com/example/Utils.java',
    );
  });

  it('prefers the longest declared package prefix', () => {
    // `com.example` also declares types, so a shorter split would have to be
    // rejected on the type name alone; the longest package wins first.
    expect(resolveJavaModule('com.example.model.Order', WORKSPACE)).toBe(
      'src/main/java/com/example/model/Order.java',
    );
  });
});

describe('imports of things outside the repository (#2953)', () => {
  it('does not resolve a JDK import onto a same-named local file', () => {
    // The reported defect. `vendor/java/util/List.java` ends in `java/util/List`
    // and the old resolver bound `java.util.List` straight to it. No file
    // declares package `java.util`, so there is nothing here to name.
    expect(resolveJavaModule('java.util.List', WORKSPACE)).toBeNull();
  });

  it('still resolves the local file under the package it DOES declare', () => {
    // The paired positive: the same file is reachable, just not by the JDK's
    // name for it. Without this arm the one above could pass by resolving
    // nothing at all.
    expect(resolveJavaModule('vendor.java.util.List', WORKSPACE)).toBe(
      'vendor/java/util/List.java',
    );
  });

  it('does not resolve a third-party import', () => {
    expect(resolveJavaModule('org.springframework.stereotype.Service', WORKSPACE)).toBeNull();
    expect(resolveJavaModule('com.google.common.collect.Lists', WORKSPACE)).toBeNull();
  });

  it('does not resolve a declared package with an undeclared type', () => {
    // `com.example` is real; `Missing` is not. A partial match is not a match.
    expect(resolveJavaModule('com.example.Missing', WORKSPACE)).toBeNull();
  });

  it('does not resolve a bare single-segment name', () => {
    // Java forbids importing from the default package, so there is no spelling
    // of a one-segment import that names an in-repo type.
    expect(resolveJavaModule('App', WORKSPACE)).toBeNull();
  });
});

describe('wildcard imports', () => {
  it('answers with EVERY file in the package, not one', () => {
    // The old resolver returned the first `.java` in the package directory in
    // file-set iteration order — an answer decided by the file list rather than
    // by the import.
    expect(resolveJavaModule('com.example.model.*', WORKSPACE)).toEqual([
      'src/main/java/com/example/model/User.java',
      'src/main/java/com/example/model/Order.java',
    ]);
  });

  it('keeps a static wildcard on a type distinct from a same-named package', () => {
    const index = indexOf({
      'src/main/java/com/example/Utils.java': 'com.example',
      'src/main/java/com/example/Utils/Nested.java': 'com.example.Utils',
    });
    const parsed = interpretJavaImport({
      '@import.kind': capture('static-wildcard'),
      '@import.source': capture('com.example.Utils'),
      '@import.name': capture('*'),
    } as CaptureMatch);

    expect(parsed).toEqual({ kind: 'wildcard', targetRaw: 'com.example.Utils' });
    if (parsed === null || parsed.targetRaw === null) throw new Error('import was not interpreted');
    expect(resolveJavaModule(parsed.targetRaw, index)).toBe('src/main/java/com/example/Utils.java');
    expect(resolveJavaModule('com.example.Utils.*', index)).toEqual([
      'src/main/java/com/example/Utils/Nested.java',
    ]);
  });

  it('resolves nothing for a wildcard on an undeclared package', () => {
    expect(resolveJavaModule('java.util.*', WORKSPACE)).toBeNull();
  });
});

describe('the index itself', () => {
  it('counts files whose package header could not be read', () => {
    const index = indexOf({ 'src/Broken.java': null, 'src/Fine.java': 'ok.pkg' });

    expect(index.unreadablePackageFiles).toBe(1);
    // The unreadable file is in no package, so nothing can import it — but the
    // readable one beside it is unaffected.
    expect(resolveJavaModule('ok.pkg.Fine', index)).toBe('src/Fine.java');
  });

  it('indexes the default package but refuses imports from it', () => {
    const index = indexOf({ 'Root.java': '' });

    // Same-package visibility still needs the file bucketed…
    expect(index.filesByPackage.get('')).toEqual(['Root.java']);
    // …but `import Root;` is not legal Java and resolves to nothing.
    expect(resolveJavaModule('Root', index)).toBeNull();
  });

  it('is empty for an empty workspace, and resolves nothing', () => {
    const empty = buildJavaPackageIndex([], () => undefined);

    expect(resolveJavaModule('com.example.model.User', empty)).toBeNull();
  });
});
