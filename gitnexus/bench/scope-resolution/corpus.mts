import { SupportedLanguages } from 'gitnexus-shared';

export interface SourceFile {
  path: string;
  content: string;
}

type Generator = (i: number, methods: number) => SourceFile | SourceFile[];
const members = (count: number, source: (j: number) => string) =>
  Array.from({ length: count }, (_, j) => source(j)).join('\n');
const previous = (i: number, source: (p: number) => string) => (i > 0 ? source(i - 1) : '');

const script = (i: number, count: number, typed: boolean, extension: string): string =>
  `${previous(i, (p) => `import { C${p} } from './C${p}.${extension}';`)}
export class C${i} {
${members(count, (j) => `  make${i}_${j}()${typed ? `: C${i}` : ''} { return this; }`)}
${previous(i, (p) => `  usePrevious() { return new C${p}().make${p}_0().make${p}_1(); }`)}
}`;

// Each arm has one chain of cross-file uses and distinct method names. Swift
// uses same-module visibility; COBOL uses program calls and procedure pointers;
// PL/SQL uses package-qualified calls.
export const generators = {
  javascript: (i, n) => ({ path: `src/C${i}.js`, content: script(i, n, false, 'js') }),
  typescript: (i, n) => ({ path: `src/C${i}.ts`, content: script(i, n, true, 'js') }),
  vue: (i, n) => ({
    path: `src/C${i}.vue`,
    content: `<script lang="ts">\n${script(i, n, true, 'vue')}\nexport default {};\n</script>\n<template><div /></template>`,
  }),
  python: (i, n) => ({
    path: `src/c${i}.py`,
    content: `${previous(i, (p) => `from c${p} import C${p}`)}
class C${i}:
${members(n, (j) => `    def make${i}_${j}(self) -> "C${i}":\n        return self`)}
${previous(i, (p) => `    def use_previous(self):\n        return C${p}().make${p}_0().make${p}_1()`)}
`,
  }),
  java: (i, n) => ({
    path: `src/p${i}/C${i}.java`,
    content: `package p${i};
${previous(i, (p) => `import p${p}.C${p};`)}
public class C${i} {
${members(n, (j) => `  public C${i} make${i}_${j}() { return this; }`)}
${previous(i, (p) => `  public C${p} previous${i}() { return new C${p}(); }`)}
${previous(i, (p) => `  public C${p} usePrevious(C${p} value) { return value.make${p}_0().make${p}_1(); }`)}
${i > 1 ? `  public void useTransitive(C${i - 1} value) { var older = value.previous${i - 1}(); older.make${i - 2}_0(); }` : ''}
  public void externalUsage(external.Client client) { client.externalBuild(); }
}`,
  }),
  c: (i, n) => ({
    path: `src/C${i}.h`,
    content: `#pragma once
${previous(i, (p) => `#include "C${p}.h"`)}
typedef struct C${i} { int value; } C${i};
${members(n, (j) => `static inline C${i}* make${i}_${j}(C${i}* value) { return value; }`)}
${previous(i, (p) => `static inline C${p}* usePrevious${i}(C${p}* value) { return make${p}_1(make${p}_0(value)); }`)}
`,
  }),
  cpp: (i, n) => ({
    path: `src/C${i}.hpp`,
    content: `#pragma once
${previous(i, (p) => `#include "C${p}.hpp"`)}
class C${i} { public:
${members(n, (j) => `  C${i}* make${i}_${j}() { return this; }`)}
};
${previous(i, (p) => `inline C${p}* usePrevious${i}(C${p}* value) { return value->make${p}_0()->make${p}_1(); }`)}
`,
  }),
  'objective-c': (i, n) => [
    {
      path: `src/C${i}.h`,
      content: `#import <Foundation/Foundation.h>
${previous(i, (p) => `#import "C${p}.h"`)}
@interface C${i} : NSObject
${members(n, (j) => `- (C${i} *)make${i}_${j};`)}
${previous(i, (p) => `- (C${p} *)usePrevious:(C${p} *)value;`)}
@end
`,
    },
    {
      path: `src/C${i}.m`,
      content: `#import "C${i}.h"
@implementation C${i}
${members(n, (j) => `- (C${i} *)make${i}_${j} { return self; }`)}
${previous(i, (p) => `- (C${p} *)usePrevious:(C${p} *)value { return [[value make${p}_0] make${p}_1]; }`)}
@end
`,
    },
  ],
  csharp: (i, n) => ({
    path: `src/P${i}/C${i}.cs`,
    content: `${previous(i, (p) => `using P${p};`)}
namespace P${i} {
public class C${i} {
${members(n, (j) => `  public C${i} Make${i}_${j}() { return this; }`)}
${previous(i, (p) => `  public C${p} UsePrevious(C${p} value) { return value.Make${p}_0().Make${p}_1(); }`)}
}}
`,
  }),
  go: (i, n) => ({
    path: `src/p${i}/c${i}.go`,
    content: `package p${i}
${previous(i, (p) => `import "bench/src/p${p}"`)}
type C${i} struct {}
${members(n, (j) => `func (value *C${i}) Make${i}_${j}() *C${i} { return value }`)}
${previous(i, (p) => `func UsePrevious(value *p${p}.C${p}) *p${p}.C${p} { return value.Make${p}_0().Make${p}_1() }`)}
`,
  }),
  ruby: (i, n) => ({
    path: `src/c${i}.rb`,
    content: `${previous(i, (p) => `require_relative 'c${p}'`)}
class C${i}
${members(n, (j) => `  def make${i}_${j}()\n    self\n  end`)}
${previous(i, (p) => `  def use_previous()\n    C${p}.new.make${p}_0().make${p}_1()\n  end`)}
end
`,
  }),
  rust: (i, n) => ({
    path: `src/c${i}.rs`,
    content: `${previous(i, (p) => `use crate::c${p}::C${p};`)}
pub struct C${i} {}
impl C${i} {
${members(n, (j) => `  pub fn make${i}_${j}(&self) -> C${i} { C${i} {} }`)}
}
${previous(i, (p) => `pub fn use_previous(value: C${p}) -> C${p} { value.make${p}_0().make${p}_1() }`)}
`,
  }),
  php: (i, n) => ({
    path: `src/P${i}/C${i}.php`,
    content: `<?php
namespace Bench\\P${i};
${previous(i, (p) => `use Bench\\P${p}\\C${p};`)}
class C${i} {
${members(n, (j) => `  public function make${i}_${j}(): C${i} { return $this; }`)}
${previous(i, (p) => `  public function usePrevious(C${p} $value): C${p} { return $value->make${p}_0()->make${p}_1(); }`)}
}
`,
  }),
  kotlin: (i, n) => ({
    path: `src/p${i}/C${i}.kt`,
    content: `package p${i}
${previous(i, (p) => `import p${p}.C${p}`)}
class C${i} {
${members(n, (j) => `  fun make${i}_${j}(): C${i} = this`)}
${previous(i, (p) => `  fun usePrevious(value: C${p}): C${p} = value.make${p}_0().make${p}_1()`)}
}
`,
  }),
  swift: (i, n) => ({
    path: `Sources/Bench/C${i}.swift`,
    content: `class C${i} {
${members(n, (j) => `  func make${i}_${j}() -> C${i} { return self }`)}
${previous(i, (p) => `  func usePrevious(_ value: C${p}) -> C${p} { return value.make${p}_0().make${p}_1() }`)}
}
`,
  }),
  dart: (i, n) => ({
    path: `lib/c${i}.dart`,
    content: `${previous(i, (p) => `import 'c${p}.dart';`)}
class C${i} {
${members(n, (j) => `  C${i} make${i}_${j}() { return this; }`)}
${previous(i, (p) => `  C${p} usePrevious(C${p} value) { return value.make${p}_0().make${p}_1(); }`)}
}
`,
  }),
  cobol: (i, n) => ({
    path: `src/C${i}.cbl`,
    content: `       IDENTIFICATION DIVISION.
       PROGRAM-ID. C${i}.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 TARGET-PTR USAGE PROCEDURE-POINTER.
       PROCEDURE DIVISION.
       MAIN-PARA.
${previous(i, (p) => `           SET TARGET-PTR TO ENTRY 'C${p}'\n           CALL TARGET-PTR`)}
           PERFORM MAKE-${i}-0
           GOBACK.
${members(n, (j) => `       MAKE-${i}-${j}.\n           CONTINUE.`)}
`,
  }),
  plsql: (i, n) => ({
    path: `src/pkg_c${i}.pck`,
    content: `CREATE OR REPLACE PACKAGE pkg_c${i} AS
${members(n, (j) => `  PROCEDURE make${i}_${j};`)}
  PROCEDURE use_previous;
END pkg_c${i};
/
CREATE OR REPLACE PACKAGE BODY pkg_c${i} AS
${members(n, (j) => `  PROCEDURE make${i}_${j} IS BEGIN NULL; END make${i}_${j};`)}
  PROCEDURE use_previous IS
  BEGIN
${previous(i, (p) => `    pkg_c${p}.make${p}_0;\n    pkg_c${p}.make${p}_1;`)}
    NULL;
  END use_previous;
END pkg_c${i};
/
`,
  }),
  zig: (i, n) => ({
    path: `src/c${i}.zig`,
    content: `${previous(i, (p) => `const previous = @import("c${p}.zig");`)}
pub const C${i} = struct {
${members(n, (j) => `  pub fn make${i}_${j}(self: C${i}) C${i} { return self; }`)}
};
${previous(i, (p) => `pub fn usePrevious(value: previous.C${p}) previous.C${p} { return value.make${p}_0().make${p}_1(); }`)}
`,
  }),
} satisfies Record<SupportedLanguages, Generator>;

export function corpus(language: SupportedLanguages, count: number, methods: number) {
  const files: SourceFile[] = Array.from({ length: count }, (_, i) =>
    generators[language](i, methods),
  ).flat();
  const config: SourceFile[] = [];
  if (language === SupportedLanguages.Java) {
    // The shared name is indexed, but unreachable from every chain file.
    // Repeated misses must not re-walk the whole import chain per caller.
    files.push({
      path: 'src/aux/Auxiliary.java',
      content:
        'package aux; public class Auxiliary { public Auxiliary externalBuild() { return this; } }',
    });
  } else if (language === SupportedLanguages.Go) {
    config.push({ path: 'go.mod', content: 'module bench\n\ngo 1.22\n' });
  } else if (language === SupportedLanguages.Rust) {
    files.push({ path: 'src/lib.rs', content: members(count, (i) => `pub mod c${i};`) });
    config.push({
      path: 'Cargo.toml',
      content: '[package]\nname = "bench"\nversion = "0.1.0"\nedition = "2021"\n',
    });
  } else if (language === SupportedLanguages.PHP) {
    config.push({
      path: 'composer.json',
      content: JSON.stringify({ autoload: { 'psr-4': { 'Bench\\': 'src/' } } }),
    });
  }
  return { files, config };
}
