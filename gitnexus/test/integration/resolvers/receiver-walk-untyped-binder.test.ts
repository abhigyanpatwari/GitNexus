/**
 * DART-11 — the receiver type walk stops at the NEAREST scope that binds the
 * receiver name, typed or not.
 *
 * A closure or local function that rebinds a name owns it: `cs` inside
 * `(cs) { cs.save(); }` is the closure's own parameter, whatever the enclosing
 * function's `Address cs` says. Before this change Dart gave inline closures and
 * local functions no scope and published no binder names on any Function scope,
 * so the walk climbed from the closure body straight to the enclosing typed
 * parameter and minted `f → Address.save` for a call the source never makes.
 *
 * Each pinned site asserts its exact CALLS edges, and every site whose decline
 * matters asserts the exact suppression outcome (by call site, `siteKind`
 * included) as well. A stop at an untyped binder is recorded as
 * `receiver-type-unresolved` with `declineDetail: 'untyped-binder'` and the
 * binder's scope id, so the decline is auditable rather than a silent miss.
 *
 * The TypeScript and Python shapes are already correct on this tree (their
 * name claims stop the walk); they are pinned so the shared change cannot
 * regress them. Ruby now publishes parameter names (RUBY-03), so its block
 * parameter stops the walk too. PHP emits no lexical binder names: its pins
 * characterize today's edges, including known wrong ones, until it opts in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, getResolutionOutcomes, writeFixtureRepo } from './helpers.js';

// The Dart grammar is optional; its suites skip where it cannot load.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

/** Materialize `files`, run the pipeline once, and clean up after the block. */
function useFixture(prefix: string, files: Record<string, string>): () => PipelineResult {
  let root = '';
  let result: PipelineResult | undefined;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), `gitnexus-${prefix}-`));
    writeFixtureRepo(root, files);
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);
  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });
  return () => {
    if (result === undefined) throw new Error('pipeline did not run');
    return result;
  };
}

/**
 * Every CALLS edge whose target is named `member`, as
 * `source -> target @line:col` — the call site comes from the relationship id
 * suffix, so two sites with the same endpoints stay distinct. `@-` marks an edge
 * whose id carries no site (a collapsed or fallback edge).
 */
function memberCalls(result: PipelineResult, member: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.target === member)
    .map((edge) => {
      const suffix = edge.rel.id.slice(
        edge.rel.id.lastIndexOf(edge.rel.targetId) + edge.rel.targetId.length,
      );
      const site = /^:(\d+):(\d+)/.exec(suffix);
      return `${edge.rel.sourceId} -> ${edge.rel.targetId} @${site === null ? '-' : `${site[1]}:${site[2]}`}`;
    })
    .sort();
}

/**
 * Every suppression recorded for the `siteKind` reference `name` at
 * `file:line:col`, with its decline detail and binder. A call and a read can
 * share a name and a start position, so the kind is part of the site.
 */
function declinesAt(
  result: PipelineResult,
  file: string,
  line: number,
  col: number,
  name: string,
  siteKind: 'call' | 'read' | 'write' = 'call',
): string[] {
  return getResolutionOutcomes(result)
    .flatMap((outcome) =>
      outcome.kind === 'suppressed' &&
      outcome.filePath === file &&
      outcome.range.startLine === line &&
      outcome.range.startCol === col &&
      outcome.name === name &&
      outcome.siteKind === siteKind
        ? [
            [outcome.reason, outcome.declineDetail, outcome.binderScopeId]
              .filter((part) => part !== undefined)
              .join(' '),
          ]
        : [],
    )
    .sort();
}

const UNTYPED = 'receiver-type-unresolved untyped-binder';

const DART_MODELS = `class Address {
  void save() {}
}

class Other {
  void save() {}
}
`;

// ── Dart: closures and local functions own their parameters ────────────────
describe.skipIf(!dartAvailable)(
  'Dart — a closure or local function that rebinds a name stops the receiver walk',
  () => {
    const run = useFixture('dart11-closures', {
      'models.dart': DART_MODELS,
      'app.dart': `import 'models.dart';

void f5(Address cs, List<dynamic> items) {
  items.forEach((cs) {
    cs.save();
  });
  cs.save();
}

void f5b(Address cs, List<dynamic> items) {
  items.forEach((cs) {
    cs.save();
  });
}

void f5c(Address cs, List<dynamic> items) {
  items.forEach((cs) => cs.save());
  cs.save();
}

void f5d(Address cs) {
  var h = (cs) {
    cs.save();
  };
  cs.save();
}

void f5e(Address cs) {
  void inner(cs) {
    cs.save();
  }
  cs.save();
}

class Svc {
  void m5(Address cs, List<dynamic> items) {
    items.forEach((cs) {
      cs.save();
    });
    cs.save();
  }
}

void f5f(Address cs, List<Other> items) {
  items.forEach((Other cs) {
    cs.save();
  });
  cs.save();
}

void f5g(Address cs) {
  var h = (Other cs) {
    cs.save();
  };
}
`,
    });

    it('s5: the inline closure site emits no edge and declines at its own binder; the outer site keeps Address.save', () => {
      const calls = memberCalls(run(), 'save').filter((e) => e.startsWith('Function:app.dart:f5 '));
      expect(calls).toEqual(['Function:app.dart:f5 -> Method:models.dart:Address.save#0 @7:5']);
      expect(declinesAt(run(), 'app.dart', 5, 7, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#4:16-6:3:Function`,
      ]);
      expect(declinesAt(run(), 'app.dart', 7, 5, 'save')).toEqual([]);
    });

    it('`untyped-binder` is the resolver’s view: `List<dynamic> items` declares a type the Dart interpreter does not keep', () => {
      // No edge either way (`forEach` is not in the workspace); the decline only
      // says the nearest binder of `items` carries no type fact.
      expect(declinesAt(run(), 'app.dart', 4, 8, 'forEach')).toEqual([
        `${UNTYPED} scope:app.dart#3:0-8:1:Function`,
      ]);
    });

    it('s5b: a function whose only site is the closure gets no edge at all', () => {
      expect(
        memberCalls(run(), 'save').filter((e) => e.startsWith('Function:app.dart:f5b ')),
      ).toEqual([]);
      expect(declinesAt(run(), 'app.dart', 12, 7, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#11:16-13:3:Function`,
      ]);
    });

    it('arrow closure: the expression body is the closure scope too', () => {
      expect(
        memberCalls(run(), 'save').filter((e) => e.startsWith('Function:app.dart:f5c ')),
      ).toEqual(['Function:app.dart:f5c -> Method:models.dart:Address.save#0 @18:5']);
      expect(declinesAt(run(), 'app.dart', 17, 27, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#17:16-17:33:Function`,
      ]);
    });

    it('a closure bound to a local declines inside its own scope; the outer site keeps its edge', () => {
      const calls = memberCalls(run(), 'save').filter(
        (e) => e.startsWith('Function:app.dart:f5d') && e.includes('Address.save'),
      );
      expect(calls).toEqual(['Function:app.dart:f5d -> Method:models.dart:Address.save#0 @25:5']);
      expect(declinesAt(run(), 'app.dart', 23, 7, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#22:10-24:3:Function`,
      ]);
    });

    it('a local function declines at its own parameter; the outer site keeps its edge', () => {
      expect(
        memberCalls(run(), 'save').filter((e) => e.startsWith('Function:app.dart:f5e')),
      ).toEqual(['Function:app.dart:f5e -> Method:models.dart:Address.save#0 @32:5']);
      expect(declinesAt(run(), 'app.dart', 30, 7, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#29:2-31:3:Function`,
      ]);
    });

    it('inside a method: the closure site declines, the method site keeps its edge', () => {
      expect(
        memberCalls(run(), 'save').filter((e) => e.startsWith('Method:app.dart:Svc.m5')),
      ).toEqual(['Method:app.dart:Svc.m5#2 -> Method:models.dart:Address.save#0 @40:7']);
      expect(declinesAt(run(), 'app.dart', 38, 9, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#37:18-39:5:Function`,
      ]);
    });

    it('a typed closure parameter types its own site: Other.save inside, Address.save outside', () => {
      expect(
        memberCalls(run(), 'save').filter((e) => e.startsWith('Function:app.dart:f5f ')),
      ).toEqual([
        'Function:app.dart:f5f -> Method:models.dart:Address.save#0 @48:5',
        'Function:app.dart:f5f -> Method:models.dart:Other.save#0 @46:7',
      ]);
      expect(declinesAt(run(), 'app.dart', 46, 7, 'save')).toEqual([]);
    });

    it('a typed parameter of a closure bound to a local types that closure’s site', () => {
      expect(
        memberCalls(run(), 'save').filter((e) => e.startsWith('Function:app.dart:f5g')),
      ).toEqual(['Function:app.dart:f5g.h@51:2 -> Method:models.dart:Other.save#0 @53:7']);
      expect(declinesAt(run(), 'app.dart', 53, 7, 'save')).toEqual([]);
    });
  },
);

// ── Dart: the new closure scopes must not cost recall ──────────────────────
describe.skipIf(!dartAvailable)(
  'Dart — closure scopes keep every edge that does not cross a rebinding',
  () => {
    const run = useFixture('dart11-controls', {
      'models.dart': DART_MODELS,
      'app.dart': `import 'models.dart';

void f6(Address cs, List<dynamic> items) {
  items.forEach((x) {
    cs.save();
  });
}

void f7(List<dynamic> items) {
  items.forEach((x) {
    var a = Address();
    a.save();
  });
}

class K {
  void helper() {}
  void run(List<dynamic> items) {
    items.forEach((x) {
      helper();
      this.helper();
    });
  }
}

void f8(List<dynamic> items) {
  items.forEach((x) {
    var g = (y) => y;
    g(x);
  });
}
`,
    });

    it('a closure that does not rebind the name still reaches the enclosing typed parameter', () => {
      expect(
        memberCalls(run(), 'save').filter((e) => e.startsWith('Function:app.dart:f6')),
      ).toEqual(['Function:app.dart:f6 -> Method:models.dart:Address.save#0 @5:7']);
      expect(declinesAt(run(), 'app.dart', 5, 7, 'save')).toEqual([]);
    });

    it('a constructor-typed local declared inside a closure still types its receiver', () => {
      expect(
        memberCalls(run(), 'save').filter((e) => e.startsWith('Function:app.dart:f7')),
      ).toEqual(['Function:app.dart:f7 -> Method:models.dart:Address.save#0 @12:6']);
    });

    it('implicit and explicit `this` inside a closure in a method still reach the class member', () => {
      expect(memberCalls(run(), 'helper')).toEqual([
        'Method:app.dart:K.run#1 -> Method:app.dart:K.helper#0 @-',
        'Method:app.dart:K.run#1 -> Method:app.dart:K.helper#0 @21:11',
      ]);
    });

    it('a closure bound inside an inline closure is still called through callable-value flow', () => {
      expect(memberCalls(run(), 'g')).toEqual([
        'Function:app.dart:f8 -> Function:app.dart:f8.fn@26:16.g@27:4 @29:4',
      ]);
    });
  },
);

// ── Dart: plan §6 shapes 1-4 (no edge before or after; the decline is now named) ─
describe.skipIf(!dartAvailable)(
  'Dart — module-level names shadowed by an untyped local or parameter',
  () => {
    const run = useFixture('dart11-module-var', {
      'models.dart': DART_MODELS,
      'app.dart': `import 'models.dart';

Address cs = Address();

void f2(List<dynamic> items) {
  var cs = items[0];
  cs.save();
}

void g4(dynamic cs) {
  cs.save();
}

void g4a(cs) {
  cs.save();
}

void fc1() {
  cs.save();
}
`,
    });

    it('shape 2: an untyped local shadowing a module variable declines at the function scope', () => {
      expect(memberCalls(run(), 'save')).toEqual([]);
      expect(declinesAt(run(), 'app.dart', 7, 5, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#5:0-8:1:Function`,
      ]);
    });

    it('shape 4: a `dynamic` or untyped parameter declines at the function scope', () => {
      expect(declinesAt(run(), 'app.dart', 11, 5, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#10:0-12:1:Function`,
      ]);
      expect(declinesAt(run(), 'app.dart', 15, 5, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#14:0-16:1:Function`,
      ]);
    });

    it('control: an unshadowed read records no decline (the module variable is not walkable here)', () => {
      expect(declinesAt(run(), 'app.dart', 19, 5, 'save')).toEqual([]);
    });
  },
);

describe.skipIf(!dartAvailable)('Dart — a module getter shadowed by an untyped local', () => {
  const run = useFixture('dart11-module-getter', {
    'models.dart': DART_MODELS,
    'app.dart': `import 'models.dart';

Address get cs => Address();

void f1(List<dynamic> items) {
  var cs = items[0];
  cs.save();
}
`,
  });

  it('shape 1: no edge, and the decline names the function scope', () => {
    expect(memberCalls(run(), 'save')).toEqual([]);
    expect(declinesAt(run(), 'app.dart', 7, 5, 'save')).toEqual([
      `${UNTYPED} scope:app.dart#5:0-8:1:Function`,
    ]);
  });
});

describe.skipIf(!dartAvailable)('Dart — class members shadowed inside a method', () => {
  const run = useFixture('dart11-members', {
    'models.dart': DART_MODELS,
    'app.dart': `import 'models.dart';

class Box3 {
  Address get cs => Address();
  void m3(List<dynamic> items) {
    var cs = items[0];
    cs.save();
  }
}

class Box3b {
  Address cs = Address();
  void m3b(List<dynamic> items) {
    var cs = items[0];
    cs.save();
  }
}

class Box4b {
  Address cs = Address();
  void m4b(dynamic cs) {
    cs.save();
  }
}

class Box4d {
  Address get cs => Address();
  void m4d(dynamic cs) {
    cs.save();
  }
}

class Box4 {
  Address cs = Address();
  void mc4() {
    cs.save();
  }
}
`,
  });

  it('only the unshadowed field read keeps an edge', () => {
    expect(memberCalls(run(), 'save')).toEqual([
      'Method:app.dart:Box4.mc4#0 -> Method:models.dart:Address.save#0 @36:7',
    ]);
  });

  it('shape 3 / getter variants decline as untyped binders', () => {
    expect(declinesAt(run(), 'app.dart', 7, 7, 'save')).toEqual([
      `${UNTYPED} scope:app.dart#5:2-8:3:Function`,
    ]);
    expect(declinesAt(run(), 'app.dart', 29, 7, 'save')).toEqual([
      `${UNTYPED} scope:app.dart#28:2-30:3:Function`,
    ]);
  });

  it('field variants keep the shadowed-field mask outcome, which runs first', () => {
    expect(declinesAt(run(), 'app.dart', 15, 7, 'save')).toEqual(['receiver-owned-but-unbound']);
    expect(declinesAt(run(), 'app.dart', 22, 7, 'save')).toEqual(['receiver-owned-but-unbound']);
  });
});

// ── TypeScript and Python: already stopped by name claims; pinned ──────────
describe('TypeScript — untyped parameters and arrow parameters (already stopped by name claims)', () => {
  const run = useFixture('dart11-ts', {
    'models.ts': `export class Address {
  saveTs() {}
}

export class Other {
  saveTs() {}
}
`,
    'app.ts': `import { Address } from './models';

export const cs: Address = new Address();

export function gTs(cs) {
  cs.saveTs();
}

export function fTs(cs: Address) {
  const inner = (cs) => {
    cs.saveTs();
  };
  cs.saveTs();
}

export function fPlain(cs: Address, items) {
  {
    const cs = items[0];
    cs.saveTs();
  }
}
`,
  });

  it('only the typed outer parameter site resolves', () => {
    expect(memberCalls(run(), 'saveTs')).toEqual([
      'Function:app.ts:fTs -> Method:models.ts:Address.saveTs#0 @13:2',
    ]);
  });

  it('records no lexical-binder decline: TypeScript stops through name claims, not lexical names', () => {
    expect(declinesAt(run(), 'app.ts', 6, 2, 'saveTs')).toEqual([]);
    expect(declinesAt(run(), 'app.ts', 11, 4, 'saveTs')).toEqual([]);
    expect(declinesAt(run(), 'app.ts', 19, 4, 'saveTs')).toEqual([]);
  });
});

describe('Python — nested def parameter and untyped parameter (already stopped by name claims)', () => {
  const run = useFixture('dart11-py', {
    'models.py': `class Address:
    def save_py(self):
        pass


class Other:
    def save_py(self):
        pass
`,
    'app.py': `from models import Address


cs: Address = Address()


def f_py(cs: Address):
    def inner(cs):
        cs.save_py()

    cs.save_py()


def g_py(cs):
    cs.save_py()
`,
  });

  it('only the typed outer parameter site resolves', () => {
    expect(memberCalls(run(), 'save_py')).toEqual([
      'Function:app.py:f_py -> Method:models.py:Address.save_py#0 @11:4',
    ]);
  });

  it('records no lexical-binder decline at the stopped sites', () => {
    expect(declinesAt(run(), 'app.py', 9, 8, 'save_py')).toEqual([]);
    expect(declinesAt(run(), 'app.py', 15, 4, 'save_py')).toEqual([]);
  });
});

// ── Ruby opts into lexical binder names; PHP remains a characterization ───
describe('Ruby — a block parameter stops the receiver walk (RUBY-03)', () => {
  const run = useFixture('dart11-rb', {
    'models.rb': `class Address
  def save_rb; end
end

class Other
  def save_rb; end
end
`,
    'app.rb': `require_relative 'models'

def f_rb(items)
  cs = Address.new
  items.each do |cs|
    cs.save_rb
  end
  cs.save_rb
end
`,
  });

  it('records the untyped block binder and preserves the typed outer use', () => {
    expect(memberCalls(run(), 'save_rb')).toEqual([
      'Method:app.rb:f_rb#1 -> Method:models.rb:Address.save_rb#0 @8:2',
    ]);
    expect(declinesAt(run(), 'app.rb', 6, 4, 'save_rb')).toEqual([
      `${UNTYPED} scope:app.rb#5:13-7:5:Block`,
    ]);
  });
});

describe('PHP — characterization: closure and module climbs, and the unique-name fallback', () => {
  const run = useFixture('dart11-php', {
    'models.php': `<?php
class Address { public function savePhp() {} }
class Other { public function savePhp() {} }
class Address2 { public function savePhp() {} }
class User { public function savePhp() {} }
class AuditLog { public function savePhp() {} }
class Query { public function savePhp() {} public function wherePhp() { return $this; } }
class FormatOwner { public function formatCoal() {} }
class OnlyFormat { public function formatOnly() {} }
`,
    'php_closure.php': `<?php
require_once 'models.php';

function f_php(Address $cs, $items) {
  $items->each(function ($cs) {
    $cs->savePhp();
  });
  $cs->savePhp();
}
`,
    'php_module.php': `<?php
require_once 'models.php';
$cs = new Address2();
function g_php($cs) {
  $cs->savePhp();
}
`,
    'php_routes.php': `<?php
require_once 'models.php';

function before_then_rebind($account) {
  $account->savePhp();
  $account = new AuditLog();
}

function render_date_default($date = null) {
  $date = $date ?? new FormatOwner();
  $date->formatCoal();
}

function rebind_query($query) {
  $query->savePhp();
  $query = $query->wherePhp();
}

function only_fallback($date) {
  $date->formatOnly();
}
`,
  });

  it('KNOWN WRONG EDGES at the closure site (6:4) and in g_php (5:2): PHP publishes no lexical binders', () => {
    expect(memberCalls(run(), 'savePhp')).toEqual([
      'Function:php_closure.php:f_php -> Method:models.php:Address.savePhp#0 @6:4',
      'Function:php_closure.php:f_php -> Method:models.php:Address.savePhp#0 @8:2',
      'Function:php_module.php:g_php -> Method:models.php:Address2.savePhp#0 @5:2',
      'Function:php_routes.php:before_then_rebind -> Method:models.php:AuditLog.savePhp#0 @5:2',
    ]);
  });

  it('the 0.6 unique-name fallback is unchanged: no PHP site stops at a lexical binder today', () => {
    expect(memberCalls(run(), 'formatCoal')).toEqual([
      'Function:php_routes.php:render_date_default -> Method:models.php:FormatOwner.formatCoal#0 @-',
    ]);
    expect(memberCalls(run(), 'formatOnly')).toEqual([
      'Function:php_routes.php:only_fallback -> Method:models.php:OnlyFormat.formatOnly#0 @-',
    ]);
    for (const [file, line, col, name] of [
      ['php_closure.php', 6, 4, 'savePhp'],
      ['php_module.php', 5, 2, 'savePhp'],
      ['php_routes.php', 11, 2, 'formatCoal'],
      ['php_routes.php', 20, 2, 'formatOnly'],
    ] as const) {
      expect(
        declinesAt(run(), file, line, col, name).filter((d) =>
          d.startsWith('receiver-type-unresolved'),
        ),
      ).toEqual([]);
    }
  });
});

// ── Review round 1: each shape the maintainer reproduced ───────────────────
const REVIEW_MODELS = `class Address {
  void save() {}
  void run() {}
  static Address parse(String s) => Address();
}

class Other {
  void save() {}
  void run() {}
  static Other parse(String s) => Other();
}

class Box {
  Address get cs => Address();
}

void helper() {}
`;

describe.skipIf(!dartAvailable)(
  'Dart — a name that declares nothing is not a binder (matching constants, labels, pattern assignment)',
  () => {
    const run = useFixture('dart11-r1-patterns', {
      'models.dart': REVIEW_MODELS,
      'app.dart': `import 'models.dart';
import 'models.dart' as api;

void handle(Object value, Address fallback) {
  switch (value.runtimeType) {
    case Address:
      fallback.save();
      Address.parse('x').save();
    case Other:
      Other.parse('y');
  }
}

void labels(Address cs, Object o) {
  var (api: value) = (api: 1);
  api.helper();
  if (o case Box(cs: var inner)) {}
  cs.save();
}

void assigns(Address cs, List<int> items) {
  items.forEach((x) {
    (cs,) = (Address(),);
    cs.save();
  });
}

void declares(Address cs, List<dynamic> items) {
  items.forEach((x) {
    var (cs, n) = (items[0], 1);
    cs.save();
  });
}
`,
    });

    it('a type-literal `case Address:` keeps every edge in the switch', () => {
      expect(
        getRelationships(run(), 'CALLS')
          .filter((e) => e.rel.sourceId === 'Function:app.dart:handle')
          .map((e) => e.rel.targetId)
          .sort(),
      ).toEqual([
        'Method:models.dart:Address.parse#1',
        'Method:models.dart:Address.save#0',
        'Method:models.dart:Other.parse#1',
      ]);
      expect(memberCalls(run(), 'save').filter((e) => e.includes('handle'))).toEqual([
        'Function:app.dart:handle -> Method:models.dart:Address.save#0 @7:15',
      ]);
    });

    it('a record label and an object-pattern label leave the import prefix and the parameter reachable', () => {
      expect(memberCalls(run(), 'helper')).toEqual([
        'Function:app.dart:labels -> Function:models.dart:helper @16:6',
      ]);
      expect(memberCalls(run(), 'save').filter((e) => e.includes('labels'))).toEqual([
        'Function:app.dart:labels -> Method:models.dart:Address.save#0 @18:5',
      ]);
    });

    it('a pattern assignment declares nothing: the closure still reads the outer typed parameter', () => {
      expect(memberCalls(run(), 'save').filter((e) => e.includes('assigns'))).toEqual([
        'Function:app.dart:assigns -> Method:models.dart:Address.save#0 @24:7',
      ]);
      expect(declinesAt(run(), 'app.dart', 24, 7, 'save')).toEqual([]);
    });

    it('a declaration pattern does declare: the closure stops at its own `cs`', () => {
      expect(memberCalls(run(), 'save').filter((e) => e.includes('declares'))).toEqual([]);
      expect(declinesAt(run(), 'app.dart', 31, 7, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#29:16-32:3:Function`,
      ]);
    });
  },
);

describe.skipIf(!dartAvailable)(
  'Dart — a closure inside a getter keeps the enclosing class as `this`',
  () => {
    const run = useFixture('dart11-r2-accessor', {
      'models.dart': REVIEW_MODELS,
      'app.dart': `import 'models.dart';

class Svc {
  Address addr = Address();
  List<int> seed = [];
  Other get viaClosure {
    seed.forEach((x) {
      this.addr.save();
    });
    return Other();
  }
}
`,
    });

    it('`this.addr.save()` in a name-binding closure under a getter still reaches Address.save', () => {
      expect(memberCalls(run(), 'save')).toEqual([
        'Class:app.dart:Svc -> Method:models.dart:Address.save#0 @8:16',
      ]);
      expect(declinesAt(run(), 'app.dart', 8, 16, 'save')).toEqual([]);
    });
  },
);

describe.skipIf(!dartAvailable)(
  'Dart — a comment between a local function signature and its body',
  () => {
    const run = useFixture('dart11-r3-comment', {
      'models.dart': REVIEW_MODELS,
      'app.dart': `import 'models.dart';

void k1(Address cs) {
  void inner(Other cs) // note
  {
    cs.run();
  }
  cs.save();
}
`,
    });

    it('the typed parameter stays inside the local function; the outer site keeps Address.save', () => {
      expect(memberCalls(run(), 'save')).toEqual([
        'Function:app.dart:k1 -> Method:models.dart:Address.save#0 @8:5',
      ]);
      expect(memberCalls(run(), 'run')).toEqual([
        'Function:app.dart:k1 -> Method:models.dart:Other.run#0 @6:7',
      ]);
    });
  },
);

describe.skipIf(!dartAvailable)(
  'Dart — a block-local redeclaration hides the parameter (Block scopes)',
  () => {
    const run = useFixture('dart11-r4-block', {
      'models.dart': REVIEW_MODELS,
      'app.dart': `import 'models.dart';

void b1(List<Other> items, dynamic replacement) {
  items.forEach((Other cs) {
    {
      var cs = replacement;
      cs.save();
    }
  });
}

void b2(Other cs, dynamic replacement) {
  {
    var cs = replacement;
    cs.save();
  }
}
`,
    });

    it('neither a closure parameter nor a function parameter types the block-local `cs`', () => {
      expect(memberCalls(run(), 'save')).toEqual([]);
      expect(declinesAt(run(), 'app.dart', 7, 9, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#5:4-8:5:Block`,
      ]);
      expect(declinesAt(run(), 'app.dart', 15, 7, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#13:2-16:3:Block`,
      ]);
    });
  },
);

describe.skipIf(!dartAvailable)(
  'Dart — a loop or catch variable is scoped to its statement (Block scopes)',
  () => {
    const run = useFixture('dart11-r5-statement', {
      'models.dart': REVIEW_MODELS,
      'app.dart': `import 'models.dart';

class Tk {
  void tick() {}
  void m3(List<int> xs) {
    for (final tick in xs) {
      print(tick);
    }
    tick();
  }
}

void g4(Address cs, List<Other> xs) {
  xs.forEach((x) {
    for (final cs in xs) {
      print(cs);
    }
    cs.save();
  });
}

void h5(List<int> xs) {
  xs.forEach((x) {
    try {} catch (helper) {
      print(helper);
    }
    helper();
  });
}

void g5(Address cs, List<dynamic> xs) {
  for (final cs in xs) {
    cs.save();
  }
}
`,
    });

    it('after the loop, an implicit-`this` call reaches the method the loop variable no longer hides', () => {
      expect(memberCalls(run(), 'tick')).toEqual([
        'Method:app.dart:Tk.m3#1 -> Method:app.dart:Tk.tick#0 @-',
      ]);
    });

    it('after the loop in a closure, the receiver is the outer typed parameter again', () => {
      expect(memberCalls(run(), 'save').filter((e) => e.includes('g4'))).toEqual([
        'Function:app.dart:g4 -> Method:models.dart:Address.save#0 @18:7',
      ]);
    });

    it('after a catch, a free call reaches the function the catch parameter no longer hides', () => {
      expect(memberCalls(run(), 'helper')).toEqual([
        'Function:app.dart:h5 -> Function:models.dart:helper @-',
      ]);
    });

    it('inside the loop, the loop variable hides the typed parameter', () => {
      expect(memberCalls(run(), 'save').filter((e) => e.includes('g5'))).toEqual([]);
      expect(declinesAt(run(), 'app.dart', 33, 7, 'save')).toEqual([
        `${UNTYPED} scope:app.dart#32:2-34:3:Block`,
      ]);
    });
  },
);

describe.skipIf(!dartAvailable)(
  'Dart — a typed wildcard parameter `_` declares nothing (Dart 3.7)',
  () => {
    const run = useFixture('dart11-r6-wildcard', {
      'models.dart': REVIEW_MODELS,
      'app.dart': `import 'models.dart';

class Holder {
  final Address _ = Address();
  void run(List<Other> items) {
    items.forEach((Other _) {
      _.save();
    });
  }
  void bound() {
    var h = (Other _) {
      _.save();
    };
  }
}
`,
    });

    it('`_` inside the closure is the field, not an `Other`', () => {
      expect(memberCalls(run(), 'save')).toEqual([]);
      expect(declinesAt(run(), 'app.dart', 7, 8, 'save')).toEqual(['receiver-owned-but-unbound']);
      // A closure bound to a name always has its scope, so its `_` parameter
      // must not type it either.
      expect(declinesAt(run(), 'app.dart', 12, 8, 'save')).toEqual(['receiver-owned-but-unbound']);
    });
  },
);

describe.skipIf(!dartAvailable)('Dart — local function names and function-typed parameters', () => {
  const run = useFixture('dart11-r7-localfn', {
    'models.dart': REVIEW_MODELS,
    'app.dart': `import 'models.dart';

void q(Address cs, List<int> items) {
  items.forEach((x) {
    void cs() {}
    cs.save();
  });
}

void ft(Address a, List<int> items) {
  void inner(Other cs(int a)) {
    a.save();
  }
}
`,
  });

  it('a local function named `cs` hides the outer typed parameter', () => {
    expect(memberCalls(run(), 'save').filter((e) => e.includes(':q '))).toEqual([]);
    expect(declinesAt(run(), 'app.dart', 6, 7, 'save')).toEqual([
      `${UNTYPED} scope:app.dart#4:16-7:3:Function`,
    ]);
  });

  it("a function-typed parameter's own parameter `a` does not hide the outer `a`", () => {
    expect(memberCalls(run(), 'save').filter((e) => e.includes('ft'))).toEqual([
      'Function:app.dart:ft -> Method:models.dart:Address.save#0 @12:6',
    ]);
  });
});
