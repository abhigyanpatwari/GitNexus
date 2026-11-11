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
 * `catch`, nested closure/arrow parameters, closure `use`, `static`, `global`,
 * `unset`, `$$x`), and is not `$this`. A declined tag types nothing: missing
 * beats wrong.
 *
 * Contract: typed call → exact `User::save` ID and only it; untyped sibling →
 * no edge; a `@param` on a rebound name never yields `AuditLog::save`; the
 * decoy `AuditLog::save` is never chosen by any untyped program.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getNodesByLabel,
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
  type RelEdge,
} from './helpers.js';

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

  it.each(['ra', 'dd'] as const)(
    '%s: the local `new User()` beats the `@param AuditLog $user` tag (exact User::save)',
    (fn) => {
      expect(saveTargets(fn)).toEqual([userSaveId]);
    },
  );

  it.each([
    'ra_list',
    'ra_nested_list',
    'ra_foreach',
    'ra_foreach_ref',
    'ra_coalesce',
    'ra_ref',
    'ra_ref_rhs',
    'ra_dynamic',
    'ra_extract',
  ] as const)('%s: a rebinding the engine does not type is never typed by the tag', (fn) => {
    // These rebinding forms get no constructor/element type from the PHP
    // queries (pre-existing), so the call may stay untyped — but the declined
    // tag must never fill the gap with AuditLog::save.
    expect(saveTargets(fn)).not.toContain(decoySaveId);
  });

  it('ra_catch: `catch (Exception $user)` rebinds to an Exception — no save edge at all', () => {
    expect(saveTargets('ra_catch')).toEqual([]);
  });

  it('ra_dynamic_read: a `$$user` READ declines the tag too (documented safe-direction boundary)', () => {
    expect(saveTargets('ra_dynamic_read')).not.toContain(decoySaveId);
  });

  it.each([
    ['ra_closure', '$closureRun'],
    ['ra_arrow', '$arrowRun'],
    ['ra_use', '$useRun'],
    ['ra_use_ref', '$useRefRun'],
  ] as const)(
    '%s: the nested callable %s that shadows or captures the name is never typed by the tag',
    (_outer, closure) => {
      // The assigned closure is its own call SOURCE (query.ts: the declaration
      // sits on the inner anonymous_function / arrow_function), so the edge
      // would be emitted from it, not from the enclosing method.
      expect(declared(closure)).toBe(true);
      expect(saveTargets(closure)).not.toContain(decoySaveId);
    },
  );

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
      expect(saveTargets(fn)).not.toContain(decoySaveId);
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
  ] as const)(
    '%s: a qualified, upper-cased, named-argument or first-class builtin write declines every tag',
    (fn) => {
      expect(saveTargets(fn)).not.toContain(decoySaveId);
    },
  );

  it.each(['ra_array_ref', 'ra_call_ref'] as const)(
    '%s: a reference taken anywhere (array literal, call argument) counts as a rebinding',
    (fn) => {
      expect(saveTargets(fn)).not.toContain(decoySaveId);
    },
  );

  it('nested_named_fn: a nested named function declines the outer tag (safe direction) and never borrows it', () => {
    expect(saveTargets('nested_named_fn')).not.toContain(decoySaveId);
    expect(declared('nested_inner')).toBe(true);
    expect(saveTargets('nested_inner')).not.toContain(decoySaveId);
  });

  it('ghost_param: a tag naming no formal types nothing in scope resolution (measured)', () => {
    expect(saveTargets('ghost_param')).not.toContain(decoySaveId);
  });

  it('never picks the decoy AuditLog::save from any function', () => {
    const toDecoy = getRelationships(result, 'CALLS').filter((c) => c.rel.targetId === decoySaveId);
    expect(toDecoy.map((c) => `${c.source} -> ${c.rel.targetId}`)).toEqual([]);
  });
});
