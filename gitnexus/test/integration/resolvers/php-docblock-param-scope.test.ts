/**
 * PHP-04 — a PHPDoc `@param` type must bind to the DECLARING callable, never to
 * the enclosing class (docs/languages/php-ingestion-gaps.md).
 *
 * `synthesizePhpDocBindings` anchors a `@param` binding on the function body;
 * a BODYLESS declaration (abstract or interface method) falls back to the
 * declaration node, which is also that method's `@scope.function`. Pass 4 of
 * the scope extractor auto-hoists a binding whose anchor range equals the
 * innermost scope's range to the parent, so the parameter type used to land
 * on the Class scope — and every sibling with a same-named untyped parameter
 * borrowed it. `phpBindingScopeFor` now pins `@type-binding.parameter` to the
 * innermost (callable) scope.
 *
 * The pin moves the docblock binding into the scope where Pass 4 keeps the
 * stronger of two same-named facts, and a `parameter-annotation` outranks a
 * local's `constructor-inferred` type, so `@param AuditLog $user` beside
 * `$user = new User(); $user->save()` typed the call as AuditLog::save — a
 * pre-existing flip for bodied methods, measured before the fix. A `@param`
 * therefore binds only a name that is a formal parameter, is never rebound in
 * the body (assignment, list/array destructuring, `.=`/`??=`, `foreach … as`,
 * `catch`, nested closure/arrow parameters, `use (&$x)`, `static`, `global`,
 * `unset`, `$$x`), and is not `$this`.
 *
 * A declined tag SHADOWS its name: the declaring callable's scope masks it
 * (`Scope.ownsReceivers`) and the local inference bindings for it in that
 * callable are dropped, so neither a flow-insensitive local type, a call-result
 * alias, the single-owner method-name fallback nor a same-named module-scope
 * variable can type it. The site is suppressed before lookup with reason
 * `receiver-owned-but-unbound`. Missing beats wrong.
 *
 * Contract: typed call → exact `User::save` ID and only it; untyped sibling →
 * no edge; a declined tag → no edge and a `receiver-owned-but-unbound`
 * suppression at the site; the decoy is reached only where the documented
 * type IS the decoy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getNodesByLabel,
  getRelationships,
  runPipelineFromRepo,
  suppressionReasonsAt,
  writeFixtureRepo,
  type OutcomeSite,
  type PipelineResult,
  type RelEdge,
} from './helpers.js';

/**
 * The outcome site of the first `call` text (`$user->save(`) after
 * `function fn(` in a fixture file (or the one after `skip` more): 1-based
 * line, 0-based column of the receiver, member name, `call`.
 */
function siteIn(root: string, file: string, fn: string, call: string, skip = 0): OutcomeSite {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const start = text.indexOf(`function ${fn}(`);
  let at = start < 0 ? -1 : text.indexOf(call, start);
  for (let i = 0; i < skip && at >= 0; i++) at = text.indexOf(call, at + 1);
  if (at < 0) throw new Error(`fixture lost ${call} in ${fn}`);
  const before = text.slice(0, at);
  const arrow = call.lastIndexOf('->');
  const member = call.slice(arrow + 2, call.indexOf('(', arrow));
  return [file, before.split('\n').length, at - (before.lastIndexOf('\n') + 1), member, 'call'];
}

const MODELS = `<?php
class User {
    public function save(): void {}
}

class AuditLog {
    public function save(): void {}
}
`;

describe('PHP PHPDoc @param binds to the declaring method, not its siblings (PHP-04)', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let userSaveId: string;
  let decoySaveId: string;

  const saveCallsFrom = (source: string): RelEdge[] =>
    getRelationships(result, 'CALLS').filter((c) => c.source === source && c.target === 'save');
  const saveTargets = (source: string): string[] =>
    saveCallsFrom(source).map((e) => e.rel.targetId);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-docblock-param-scope-'));
    writeFixtureRepo(tmpDir, {
      'models.php': MODELS,
      'bodied.php': `<?php
require_once 'models.php';

class Bodied {
    /** @param User $user */
    public function bodied_typed($user) {
        $user->save();
    }

    public function bodied_untyped($user) {
        $user->save();
    }
}
`,
      'abstract_typed_first.php': `<?php
require_once 'models.php';

abstract class AbstractTypedFirst {
    /** @param User $user */
    abstract public function abstract_first_typed($user);

    public function abstract_first_untyped($user) {
        $user->save();
    }
}
`,
      'abstract_untyped_first.php': `<?php
require_once 'models.php';

abstract class AbstractUntypedFirst {
    public function abstract_second_untyped($user) {
        $user->save();
    }

    /** @param User $user */
    abstract public function abstract_second_typed($user);
}
`,
      'interface_holder.php': `<?php
require_once 'models.php';

interface Contract {
    /** @param User $user */
    public function contract_typed($user);
}

class Impl implements Contract {
    public function contract_typed($user) {}

    public function impl_untyped($user) {
        $user->save();
    }
}
`,
      'trait_holder.php': `<?php
require_once 'models.php';

trait Persisting {
    /** @param User $user */
    public function trait_typed($user) {
        $user->save();
    }

    public function trait_untyped($user) {
        $user->save();
    }

    /** @param User $user */
    abstract public function trait_abstract_typed($user);

    public function trait_abstract_sibling_untyped($user) {
        $user->save();
    }
}

class UsesTrait {
    use Persisting;

    public function trait_abstract_typed($user) {}
}
`,
      'static_holder.php': `<?php
require_once 'models.php';

class Statics {
    /** @param User $user */
    public static function static_typed($user) {
        $user->save();
    }

    public static function static_untyped($user) {
        $user->save();
    }
}
`,
      'promotion.php': `<?php
require_once 'models.php';

class Promoted {
    public function __construct(private User $user) {
        $user->save();
    }

    public function promoted_property_read() {
        $this->user->save();
    }

    public function promoted_sibling_untyped($user) {
        $user->save();
    }
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const own = (owner: string): string => {
      const edge = hasMethod.find((e) => e.source === owner && e.target === 'save');
      if (edge === undefined) throw new Error(`fixture lost ${owner}::save`);
      return edge.rel.targetId;
    };
    userSaveId = own('User');
    decoySaveId = own('AuditLog');
    expect(userSaveId).not.toBe(decoySaveId);
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    'bodied_typed',
    'trait_typed',
    'static_typed',
    '__construct',
    'promoted_property_read',
  ] as const)('%s (control) resolves $user->save() to the exact User::save', (fn) => {
    expect(saveTargets(fn)).toEqual([userSaveId]);
  });

  it.each([
    'abstract_first_untyped',
    'abstract_second_untyped',
    'trait_abstract_sibling_untyped',
  ] as const)('%s: a bodyless typed sibling no longer lends its type (both orders)', (fn) => {
    // Before the pin the docblock binding of the abstract method sat on the
    // class scope and this call resolved to User::save — a wrong edge.
    expect(saveCallsFrom(fn)).toEqual([]);
  });

  it.each([
    'bodied_untyped',
    'impl_untyped',
    'trait_untyped',
    'static_untyped',
    'promoted_sibling_untyped',
  ] as const)('%s (untyped sibling) stays unresolved', (fn) => {
    expect(saveCallsFrom(fn)).toEqual([]);
  });

  it('never picks the decoy AuditLog::save from any function', () => {
    const toDecoy = getRelationships(result, 'CALLS').filter((c) => c.rel.targetId === decoySaveId);
    expect(toDecoy.map((c) => `${c.source} -> ${c.rel.targetId}`)).toEqual([]);
  });
});

describe('PHP PHPDoc @param beside a rebound local, doc drift and $this (PHP-04 guard)', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let userSaveId: string;
  let decoySaveId: string;
  let ownId: string;

  const callsFrom = (source: string, target: string): RelEdge[] =>
    getRelationships(result, 'CALLS').filter((c) => c.source === source && c.target === target);
  const saveTargets = (source: string): string[] =>
    callsFrom(source, 'save').map((e) => e.rel.targetId);
  const declared = (name: string): boolean =>
    [...getNodesByLabel(result, 'Function'), ...getNodesByLabel(result, 'Method')].includes(name);
  const suppressedAt = (file: string, fn: string, call = '$user->save(', skip = 0): string[] =>
    suppressionReasonsAt(result, siteIn(tmpDir, file, fn, call, skip));

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-docblock-param-rebound-'));
    writeFixtureRepo(tmpDir, {
      'models.php': `<?php
class User {
    public $x;
    public function save(): void {}
}

class AuditLog {
    public function save(): void {}
}
`,
      'rebound.php': `<?php
require_once 'models.php';

class Rebound {
    /** @param AuditLog $user */
    public function ra($user) {
        $user = new User();
        $user->save();
    }

    /** @param AuditLog $user */
    public function dd($account) {
        $user = new User();
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_list($user) {
        [$first, $user] = [1, new User()];
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_nested_list($user) {
        [$first, [$second, $user]] = [1, [2, new User()]];
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_foreach($user) {
        foreach ([new User()] as $user) {
            $user->save();
        }
    }

    /** @param AuditLog $user */
    public function ra_foreach_ref($user) {
        foreach ([new User()] as &$user) {
            $user->save();
        }
    }

    /** @param AuditLog $user */
    public function ra_catch($user) {
        try {
            throw new Exception();
        } catch (Exception $user) {
            $user->save();
        }
    }

    /** @param AuditLog $user */
    public function ra_coalesce($user) {
        $user ??= new User();
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_ref($user) {
        $actual = new User();
        $user =& $actual;
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_ref_rhs($user) {
        $alias =& $user;
        $alias = new User();
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_dynamic($user) {
        $name = 'user';
        $$name = new User();
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_extract($user) {
        extract(['user' => new User()]);
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_dynamic_read($user) {
        $other = $$user;
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_closure($user) {
        $closureRun = function ($user) {
            $user->save();
        };
    }

    /** @param AuditLog $user */
    public function ra_arrow($user) {
        $arrowRun = fn($user) => $user->save();
    }

    /** @param AuditLog $user */
    public function ra_use($user) {
        $useRun = function () use ($user) {
            $user->save();
        };
    }

    /** @param AuditLog $user */
    public function ra_use_ref($user) {
        $useRefRun = function () use (&$user) {
            $user->save();
        };
    }

    /** @param AuditLog $this */
    public function self_tagged() {
        $this->own();
    }

    public function own() {}

    /** @param User $user */
    public function tagged_formal_kept($user) {
        $user->save();
    }
}
`,
      'recall.php': `<?php
require_once 'models.php';

class Recall {
    /** @param User $user */
    public function member_write($user) {
        $user->x = 1;
        $user->save();
    }

    /** @param User $user */
    public function subscript_write($user) {
        $user[0] = 1;
        $user->save();
    }

    /** @param User $user */
    public function nullsafe_write($user) {
        $user?->x = 1;
        $user->save();
    }

    /** @param User $user */
    public function member_augmented($user) {
        $user->x .= 'a';
        $user->save();
    }

    /** @param User $user */
    public function unset_member($user) {
        unset($user->x);
        $user->save();
    }

    /** @param User $user */
    public function keyed_destructure($user) {
        [$user->x => $item] = [1 => 2];
        $user->save();
    }
}
`,
      'round2.php': `<?php
require_once 'models.php';

class RoundTwo {
    /** @param AuditLog $user */
    public function ra_qualified_extract($user) {
        \\extract(['user' => new User()]);
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_qualified_parse_str($user) {
        \\parse_str('id=1', $user);
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_upper_extract($user) {
        EXTRACT(['user' => new User()]);
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_parse_str_named($user) {
        parse_str('id=1', result: $user);
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_parse_str_named_reordered($user) {
        parse_str(result: $user, string: 'id=1');
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_parse_str_commented($user) {
        parse_str(/* query */ 'id=1', /* out */ $user);
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_array_ref($user) {
        $aliases = [&$user];
        $aliases[0] = new User();
        $user->save();
    }

    /** @param AuditLog $user */
    public function ra_call_ref($user) {
        $this->replace(&$user);
        $user->save();
    }

    public function replace(&$slot) {
        $slot = new User();
    }

    /** @param AuditLog $user */
    public function first_class_callable($user) {
        $fn = extract(...);
        $user->save();
    }

    /** @param AuditLog $user */
    public function nested_named_fn($user) {
        function nested_inner($user) {
            $user->save();
        }
        $user->save();
    }

    /** @param AuditLog $ghost */
    public function ghost_param($unused) {
        $ghost->save();
    }
}
`,
      'foreach_consumer.php': `<?php
require_once 'models.php';

class ForeachConsumer {
    /** @param AuditLog[] $users */
    public function foreach_rebound($users) {
        $users = [new User()];
        foreach ($users as $user) {
            $user->save();
        }
    }

    /** @param AuditLog[] $users */
    public function foreach_drift($unused) {
        foreach ($users as $user) {
            $user->save();
        }
    }

    /** @param User[] $users */
    public function foreach_kept($users) {
        foreach ($users as $user) {
            $user->save();
        }
    }
}
`,
      'round3.php': `<?php
require_once 'models.php';

class RoundThree {
    /** @param User $user */
    public function use_by_value($user) {
        $cb = function () use ($user) { return 1; };
        $user->save();
    }

    /** @param User $account */
    public function use_by_value_inner($account) {
        $inner = function () use ($account) { $account->save(); };
    }

    /** @param User $account */
    public function dollar_brace($account, $table) {
        $sql = "SELECT * FROM \${table}";
        $account->save();
    }

    /** @param User $account */
    public function dollar_brace_heredoc($account, $table) {
        $sql = <<<SQL
SELECT * FROM \${table}
SQL;
        $account->save();
    }

    /** @param AuditLog $user */
    public function dollar_brace_variable($user, $name) {
        $sql = "\${$name}";
        $user->save();
    }

    /** @param AuditLog $user */
    public function dollar_brace_expression($user, $name) {
        $sql = "\${$name . 'x'}";
        $user->save();
    }

    /** @param User $user */
    public function bare_extract($user) {
        \\extract($user);
        $user->save();
    }

    /** @param User $user */
    public function ns_extract($user) {
        Foo\\extract($user);
        $user->save();
    }

    /** @param User $user */
    public function fq_ns_extract($user) {
        \\Foo\\extract($user);
        $user->save();
    }

    /** @param AuditLog $user */
    public function arm_static($user) {
        static $user;
        $user->save();
    }

    /** @param AuditLog $user */
    public function arm_global($user) {
        global $user;
        $user->save();
    }

    /** @param AuditLog $user */
    public function arm_unset($user) {
        unset($user);
        $user->save();
    }

    /** @param AuditLog $user */
    public function arm_eval($user) {
        eval('$user = new User();');
        $user->save();
    }

    /** @param AuditLog $user */
    public function arm_parse_str_one_arg($user) {
        parse_str('user=1');
        $user->save();
    }

    /** @param $user User */
    public function alt_order_kept($user) {
        $user->save();
    }

    /** @param $user AuditLog */
    public function alt_order_rebound($user) {
        $user = new User();
        $user->save();
    }
}

class Holder {
    /** @param User $user */
    public function __construct(public &$user) {
        $user->save();
    }
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const own = (owner: string, method: string): string => {
      const edge = hasMethod.find((e) => e.source === owner && e.target === method);
      if (edge === undefined) throw new Error(`fixture lost ${owner}::${method}`);
      return edge.rel.targetId;
    };
    userSaveId = own('User', 'save');
    decoySaveId = own('AuditLog', 'save');
    ownId = own('Rebound', 'own');
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dd: a tag naming no formal (doc drift) is ignored; the local `new User()` types the call', () => {
    expect(saveTargets('dd')).toEqual([userSaveId]);
  });

  it.each([
    ['ra', 'rebound.php'],
    ['ra_list', 'rebound.php'],
    ['ra_nested_list', 'rebound.php'],
    ['ra_foreach', 'rebound.php'],
    ['ra_foreach_ref', 'rebound.php'],
    ['ra_catch', 'rebound.php'],
    ['ra_coalesce', 'rebound.php'],
    ['ra_ref', 'rebound.php'],
    ['ra_ref_rhs', 'rebound.php'],
    ['ra_dynamic', 'rebound.php'],
    ['ra_extract', 'rebound.php'],
    ['ra_dynamic_read', 'rebound.php'],
  ] as const)(
    '%s: a declined tag shadows $user — no edge, suppressed before lookup',
    (fn, file) => {
      // `ra` (`$user = new User(); $user->save();`) is the recall cost of the
      // shadow: the engine keeps one binding per name per scope, so it cannot
      // tell this order from a write AFTER the call, where the local's type
      // would be wrong. Neither the tag nor the local types a declined name.
      expect(saveTargets(fn)).toEqual([]);
      expect(suppressedAt(file, fn)).toEqual(['receiver-owned-but-unbound']);
    },
  );

  it.each([
    ['ra_closure', '$closureRun'],
    ['ra_arrow', '$arrowRun'],
    ['ra_use_ref', '$useRefRun'],
  ] as const)(
    '%s: the nested callable %s that shadows or captures $user by reference is never typed',
    (outer, closure) => {
      // The assigned closure is its own call SOURCE (query.ts: the declaration
      // sits on the inner anonymous_function / arrow_function), so the edge
      // would be emitted from it, not from the enclosing method. Its lookup
      // climbs to the outer method's shadow and stops there.
      expect(declared(closure)).toBe(true);
      expect(saveTargets(closure)).toEqual([]);
      expect(suppressedAt('rebound.php', outer)).toEqual(['receiver-owned-but-unbound']);
    },
  );

  it('ra_use: a by-value `use ($user)` cannot rebind, so the tag still types the captured value', () => {
    // The fixture documents `AuditLog $user`, so AuditLog::save is the correct
    // target here, not a decoy.
    expect(declared('$useRun')).toBe(true);
    expect(saveTargets('$useRun')).toEqual([decoySaveId]);
  });

  it('self_tagged: `@param $this` never retypes the receiver ($this->own() stays Rebound::own)', () => {
    expect(callsFrom('self_tagged', 'own').map((e) => e.rel.targetId)).toEqual([ownId]);
  });

  it('tagged_formal_kept: a well-formed tag still types its formal parameter', () => {
    expect(saveTargets('tagged_formal_kept')).toEqual([userSaveId]);
  });

  it.each([
    'member_write',
    'subscript_write',
    'nullsafe_write',
    'member_augmented',
    'unset_member',
    'keyed_destructure',
  ] as const)(
    'recall: %s writes INTO the variable, not the variable, so the tag still types it',
    (fn) => {
      expect(saveTargets(fn)).toEqual([userSaveId]);
    },
  );

  it.each(['foreach_rebound', 'foreach_drift'] as const)(
    '%s: the foreach element type never resurrects a declined tag',
    (fn) => {
      // `$user` is not a documented formal here, so nothing shadows it; it is
      // simply untyped, and `save` has two owners.
      expect(saveTargets(fn)).toEqual([]);
    },
  );

  it('foreach_kept: a well-formed `User[]` tag still types the loop variable', () => {
    expect(saveTargets('foreach_kept')).toEqual([userSaveId]);
  });

  it.each([
    'ra_qualified_extract',
    'ra_qualified_parse_str',
    'ra_upper_extract',
    'ra_parse_str_named',
    'ra_parse_str_named_reordered',
    'ra_parse_str_commented',
    'first_class_callable',
    'ra_array_ref',
    'ra_call_ref',
  ] as const)(
    '%s: a qualified/upper-cased/named-argument/first-class builtin write or a reference declines the tag and shadows $user',
    (fn) => {
      expect(saveTargets(fn)).toEqual([]);
      expect(suppressedAt('round2.php', fn)).toEqual(['receiver-owned-but-unbound']);
    },
  );

  it('nested_named_fn: a nested named function declines the outer tag (safe direction); both calls are shadowed', () => {
    expect(saveTargets('nested_named_fn')).toEqual([]);
    // The outer method's own call comes after the nested function's body.
    expect(suppressedAt('round2.php', 'nested_named_fn', '$user->save(', 1)).toEqual([
      'receiver-owned-but-unbound',
    ]);
    // The nested function's untyped `$user` climbs to the outer shadow and stops there.
    expect(declared('nested_inner')).toBe(true);
    expect(saveTargets('nested_inner')).toEqual([]);
    expect(suppressedAt('round2.php', 'nested_inner')).toEqual(['receiver-owned-but-unbound']);
  });

  it('ghost_param: a tag naming no formal types nothing and shadows nothing', () => {
    expect(saveTargets('ghost_param')).toEqual([]);
    expect(suppressedAt('round2.php', 'ghost_param', '$ghost->save(')).toEqual([]);
  });

  it.each(['use_by_value', 'use_by_value_inner'] as const)(
    '%s: a by-value closure `use` does not decline the tag',
    (fn) => {
      const source = fn === 'use_by_value' ? fn : '$inner';
      expect(saveTargets(source)).toEqual([userSaveId]);
    },
  );

  it.each(['dollar_brace', 'dollar_brace_heredoc'] as const)(
    '%s: `"${name}"` interpolation reads $table and does not decline the tag',
    (fn) => {
      expect(saveTargets(fn)).toEqual([userSaveId]);
    },
  );

  it.each(['dollar_brace_variable', 'dollar_brace_expression'] as const)(
    '%s: `"${$x}"` / `"${expr}"` is still a variable variable and declines every tag',
    (fn) => {
      expect(saveTargets(fn)).toEqual([]);
      expect(suppressedAt('round3.php', fn)).toEqual(['receiver-owned-but-unbound']);
    },
  );

  it('bare_extract: `\\extract()` is the builtin and declines the tag', () => {
    expect(saveTargets('bare_extract')).toEqual([]);
    expect(suppressedAt('round3.php', 'bare_extract')).toEqual(['receiver-owned-but-unbound']);
  });

  it.each(['ns_extract', 'fq_ns_extract'] as const)(
    '%s: `Foo\\extract()` / `\\Foo\\extract()` is another function, so the tag still types $user',
    (fn) => {
      expect(saveTargets(fn)).toEqual([userSaveId]);
    },
  );

  it.each(['arm_static', 'arm_global', 'arm_unset', 'arm_eval', 'arm_parse_str_one_arg'] as const)(
    '%s: `static`, `global`, `unset($user)`, `eval()` and one-argument `parse_str` decline the tag',
    (fn) => {
      expect(saveTargets(fn)).toEqual([]);
      expect(suppressedAt('round3.php', fn)).toEqual(['receiver-owned-but-unbound']);
    },
  );

  it('alt_order_kept: the `@param $name Type` order types its formal', () => {
    expect(saveTargets('alt_order_kept')).toEqual([userSaveId]);
  });

  it('alt_order_rebound: an `@param $name Type` tag on a rebound formal is declined and shadows it', () => {
    expect(saveTargets('alt_order_rebound')).toEqual([]);
    expect(suppressedAt('round3.php', 'alt_order_rebound')).toEqual(['receiver-owned-but-unbound']);
  });

  it('promoted by-reference formal: `public &$user` is a formal, so its tag types it', () => {
    expect(saveTargets('__construct')).toEqual([userSaveId]);
  });

  it('reaches AuditLog::save only from the one closure whose tag documents AuditLog', () => {
    const toDecoy = getRelationships(result, 'CALLS').filter((c) => c.rel.targetId === decoySaveId);
    expect(toDecoy.map((c) => `${c.source} -> ${c.rel.targetId}`)).toEqual([
      `$useRun -> ${decoySaveId}`,
    ]);
  });
});

describe('PHP declined @param shadows its name against every other route (PHP-04 review)', () => {
  // The four routes a declined tag used to leave open. Each needs its trap
  // armed: a method name with exactly ONE workspace owner (`format`, `where`,
  // `get`), top-level code in another file binding a same-named variable, and
  // a call BEFORE the rebinding. The untagged twins show each trap is live —
  // they reach the decoy on base and head alike, outside this guard.
  let result: PipelineResult;
  let tmpDir: string;
  const ids: Record<string, string> = {};

  const callsFrom = (source: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((c) => c.source === source)
      .map((c) => `${c.target} ${c.rel.targetId}`)
      .sort();
  const suppressedAt = (fn: string, call: string): string[] =>
    suppressionReasonsAt(result, siteIn(tmpDir, 'routes.php', fn, call));

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-docblock-param-routes-'));
    writeFixtureRepo(tmpDir, {
      'models.php': `<?php
class User {
    public function save(): void {}
}

class AuditLog {
    public function save(): void {}
    public function format(string $f): string { return ''; }
}

class Report {
    public function where(): Report { return $this; }
    public function get(): array { return []; }
}
`,
      'bootstrap.php': `<?php
require_once 'models.php';
$user = new AuditLog();
`,
      'helpers.php': `<?php
function make_user() { return null; }
`,
      'routes.php': `<?php
require_once 'models.php';

class Routes {
    /** @param User $account */
    public function before_then_rebind($account) {
        $account->save();
        $account = new AuditLog();
    }

    public function before_then_rebind_untagged($account) {
        $account->save();
        $account = new AuditLog();
    }
}

/** @param DateTime|null $date */
function render_date_default($date = null) {
    $date = $date ?? new DateTime();
    $date->format('c');
}

function render_date_default_untagged($date = null) {
    $date = $date ?? new DateTime();
    $date->format('c');
}

/** @param User $user */
function lib_reassign($user) {
    $user = $user ?? make_user();
    $user->save();
}

function lib_reassign_untagged($user) {
    $user = $user ?? make_user();
    $user->save();
}

/** @param Builder $query */
function query_alias($query) {
    $query = $query->where();
    $query->get();
}

function query_alias_untagged($query) {
    $query = $query->where();
    $query->get();
}

/** @param User $user */
function lib_closure_use($user) {
    $cb = function () use ($user) { return 1; };
    $user->save();
}

/** @param User $user */
function kept($user) {
    $user->save();
}
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    const hasMethod = getRelationships(result, 'HAS_METHOD');
    for (const [owner, method] of [
      ['User', 'save'],
      ['AuditLog', 'save'],
      ['AuditLog', 'format'],
      ['Report', 'where'],
      ['Report', 'get'],
    ] as const) {
      const edge = hasMethod.find((e) => e.source === owner && e.target === method);
      if (edge === undefined) throw new Error(`fixture lost ${owner}::${method}`);
      ids[`${owner}::${method}`] = edge.rel.targetId;
    }
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('kept (control): an undeclined tag types its formal — exact User::save', () => {
    expect(callsFrom('kept')).toEqual([`save ${ids['User::save']}`]);
  });

  it('lib_closure_use: a by-value `use ($user)` keeps the tag despite a top-level `$user = new AuditLog()`', () => {
    expect(callsFrom('lib_closure_use')).toEqual([`save ${ids['User::save']}`]);
  });

  it('route 1, rebind after use: a later `new AuditLog()` never types the earlier call', () => {
    // Only the constructor call itself remains.
    expect(callsFrom('before_then_rebind').filter((c) => !c.startsWith('AuditLog '))).toEqual([]);
    expect(suppressedAt('before_then_rebind', '$account->save(')).toEqual([
      'receiver-owned-but-unbound',
    ]);
  });

  it('route 2, single-owner method name: the name fallback never picks AuditLog::format', () => {
    expect(callsFrom('render_date_default')).toEqual([]);
    expect(suppressedAt('render_date_default', '$date->format(')).toEqual([
      'receiver-owned-but-unbound',
    ]);
  });

  it('route 3, module-scope climb: a top-level `$user` in another file never types the parameter', () => {
    expect(callsFrom('lib_reassign').filter((c) => c.startsWith('save '))).toEqual([]);
    expect(suppressedAt('lib_reassign', '$user->save(')).toEqual(['receiver-owned-but-unbound']);
  });

  it('route 4, call-result alias: `$query = $query->where()` never types the parameter by method name', () => {
    expect(callsFrom('query_alias')).toEqual([]);
    expect(suppressedAt('query_alias', '$query->where(')).toEqual(['receiver-owned-but-unbound']);
    expect(suppressedAt('query_alias', '$query->get(')).toEqual(['receiver-owned-but-unbound']);
  });

  it.each([
    ['before_then_rebind_untagged', 'AuditLog::save'],
    ['render_date_default_untagged', 'AuditLog::format'],
    ['lib_reassign_untagged', 'AuditLog::save'],
    ['query_alias_untagged', 'Report::get'],
    ['query_alias_untagged', 'Report::where'],
  ] as const)(
    'the trap is armed: untagged twin %s still reaches %s (pre-existing, outside the guard)',
    (fn, target) => {
      expect(callsFrom(fn)).toContain(`${target.split('::')[1]} ${ids[target]}`);
    },
  );
});
