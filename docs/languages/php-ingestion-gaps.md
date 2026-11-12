# PHP Ingestion Gaps

Audited on 2026-10-23 with freshly built production sources at `c35806d24` and
the accompanying benchmark changes. See the [measurement audit](receiver-resolution-audit.md)
for commands, target checks, exclusions and test limits. Historical reports below
remain separate from freshly measured receiver cases; broader ingestion is not
exhaustively assessed.

## Receiver shape snapshot

States below come from [baseline.json](../../gitnexus/bench/receiver-resolution/baseline.json).
The [harness](../../gitnexus/bench/receiver-resolution/measure.mjs) defines each
spelling and its N/A reason. RESOLVES requires the exact expected declaration ID
and no same-named call to a different owner. WRONG-TARGET records incorrect edges.

| Shape                   | Recorded state | Expression or exclusion                                      |
| ----------------------- | -------------- | ------------------------------------------------------------ |
| `arrowCallChain`        | VISIBLE-GAP    | `$svc->getUser()->save();` (intentional untyped control)     |
| `arrowPropertyPath`     | RESOLVES       | `$this->repo->save();`                                       |
| `plainChain`            | RESOLVES       | `$svc->getUserTyped()->save();`                              |
| `plainDeepChain`        | RESOLVES       | `$svc->getUserTyped()->address->save();`                     |
| `optionalChain`         | RESOLVES       | `$svc?->getUserTyped()->save();`                             |
| `nonNullAssert`         | N/A            | PHP has no non-null assertion operator.                      |
| `awaitParen`            | N/A            | PHP has no await expression in the core language.            |
| `explicitTypeArgs`      | N/A            | PHP has no generic type-argument syntax at a call site.      |
| `indexElement`          | VISIBLE-GAP    | `$repos[0]->save();`                                         |
| `fieldReceiverCall`     | RESOLVES       | `$this->repo->save();`                                       |
| `decoratedReceiverBase` | N/A            | PHP `$this` carries no type decoration on a method receiver. |
| `decoratedFieldType`    | RESOLVES       | `$this->repo->save();`                                       |

Typed return annotations make the plain/deep/nullsafe chains resolve. `indexElement` stays visible: PHPDoc `User[]` is normalized to `User`, losing container evidence, and PHP has no `elementTypeOf` hook. `arrowCallChain` deliberately calls an unannotated producer and remains a negative control.

### Boundaries chosen for precision (missing beats wrong)

- A PHPDoc `@param` types only a name that is one of the callable's formal parameters (a promoted by-reference `public &$x` included), is never rebound anywhere in the body (`$x = …`, `[$a, $x] = …`/`list()`, `.=`/`??=`, `$x =& $y` and `$y =& $x`, `foreach … as $x`/`as &$x`, `catch (E $x)`, a nested closure/arrow parameter, a closure `use (&$x)`, `static $x`/`global $x`/`unset($x)`), and is not `$this`. A by-value `use ($x)` is not a rebinding: it copies the value when the closure is created. A write INTO the variable (`$x->p = …`, `$x[0] = …`, `unset($x->p)`, `[$x->p => $v] = …`) does not decline the tag.
- A declined tag SHADOWS its name in the declaring callable. Declining alone left the name to whatever other evidence the engine holds, none of it flow-sensitive, and each route turned an edge the tag got right into a wrong one: a constructor-inferred local applied to an earlier call (`$x->save(); $x = new AuditLog();`), a call-result alias typed by method name (`$q = $q->where(); $q->get();`), the single-owner method-name fallback (`php-unresolved-receiver-fallback`), and a climb to a same-named module-scope variable in another file. The callable's scope now masks every declined formal (`@receiver-owner.declined-doc-params` → `Scope.ownsReceivers`), so the site is suppressed before lookup with reason `receiver-owned-but-unbound` and neither the fallback nor the module climb runs; the local inference bindings for that name in that callable (`$x = new A()`, `$x = $y`, `$x = f()`, `$x = $o->m()`, a foreach element type) are dropped, since the mask yields to a binding in the same scope. Recall cost: `$x = new User(); $x->save();` on a documented, rebound `$x` gives no edge — the engine keeps one binding per name per scope and cannot tell that order from a write after the call. A native type hint on the formal is not dropped and still wins, as before; undocumented parameters are unchanged.
- Decline-all boundary: a body containing a dynamic variable (`$$name = …`, `${'x'} = …`, `"${$x}"`, `"${expr}"`, or a mere `$$x` read — the grammar cannot tell them apart) or a call to `extract()`, `eval()` or `parse_str()` — spelled bare, upper-cased (`EXTRACT()`), or fully qualified (`\extract()`; `Foo\extract()` and `\Foo\extract()` are other functions); `parse_str` in its one-argument form, with ANY named argument (`result: $x`, in any order), or as a first-class callable `extract(...)` / `parse_str(...)` — declines EVERY `@param` tag of that callable, since any local may have been overwritten. `"${name}"` / heredoc `${name}` interpolation of a plain variable is a read and does not trip it. Two-argument positional `parse_str($q, $out)` is not opaque: it rebinds only `$out` (comments between arguments are skipped). Missing edges there are accepted.
- A reference taken in the callable's body counts as a rebinding: `$x =& $y`, `$y =& $x`, `[&$x]` in an array literal, `use (&$x)`, `foreach (… as &$x)`, and the call-time `f(&$x)` form (removed in PHP 5.4) — the alias can be written through later. NOT seen: a variable handed to a by-reference PARAMETER of a callee (`preg_match($re, $s, $m)`, a user `function fill(&$out)` called as `fill($x)`); the guard does not read callee signatures, so such a write keeps the tag, as on the base.
- Safe-direction declines: a plain variable used as a destructuring KEY (`[$k => $v] = …`) counts as bound; a nested closure's own `$x = …` declines the outer tag for `$x`; a nested NAMED function `function inner($x) {}` declines the outer tag for `$x` (kept deliberately: an untyped `$x` inside `inner` would otherwise climb the scope chain to the outer tag; with the shadow it now stops there).
- Cost: one decision per documented callable, shared by the parameter binding, the foreach element type, the mask and the local-binding drop, from one descendant scan of the body (linear in the body, whatever the number of tags). Callables without a `@param` tag do no scan.
- Pre-existing, unchanged: `[$a, $user] = …`, `foreach (<array literal> as $user)` and `$user ??= …` get no constructor/element type from the PHP queries, so a call on such a local stays unresolved. An interface method's `@param` never leaked: its binding landed on the interface's own scope, which is not an ancestor of the implementing class's methods. The four routes above still apply to an UNDOCUMENTED parameter or local; this guard only stops a documented parameter from reaching them.

## Planning candidates

| ID     | Evidence            | Gap or boundary                                                                                                                                                             | Next planning step and acceptance                                                                                                                              |
| ------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHP-01 | Measured gap        | `$repos[0]->save()` cannot use the PHPDoc element type.                                                                                                                     | Preserve both the container and its element type, then add provider-owned element resolution. Check the exact target plus untyped arrays and same-name decoys. |
| PHP-02 | Documented boundary | Functions in multi-namespace files remain ambiguity evidence but are refused as qualified call targets, function imports and factory producers while ownership is unproven. | Capture declaration-local namespace ownership before increasing recall. Preserve single-namespace positives and cross-namespace collision negatives.           |
| PHP-03 | Negative control    | `arrowCallChain` is VISIBLE-GAP for an unannotated return.                                                                                                                  | Keep this control unresolved; a member-name match is not evidence of a receiver type.                                                                          |
| PHP-04 | Fixed               | A PHPDoc `@param` on a BODYLESS method (abstract, or a trait's abstract method) was hoisted onto the class/trait scope, so a sibling method's same-named untyped parameter borrowed its type: `abstract function typed($user)` + `function plain($user) { $user->save(); }` gave `plain → User::save` in either declaration order. In a bodied method the tag also outranked a local's constructor-inferred type (`@param AuditLog $user` + `$user = new User()` typed the call as AuditLog::save). | Fixed: `phpBindingScopeFor` pins `@type-binding.parameter` to the declaring callable; one `PhpDocParamDecision` per callable admits a `@param` only for a formal parameter the body never rebinds (see the boundaries above), never `$this`, and never in a body with opaque writes. A declined tag shadows its name: the callable's scope masks it (`receiver-owned-but-unbound` suppression before lookup) and the local inference bindings for it in that callable are dropped, so a later constructor, a call-result alias, the single-owner name fallback and a module-scope climb cannot type it either. The foreach element-type consumer shares the same decision (the type-env reader in `type-extractors/php.ts` is a separate consumer; measured with `/** @param AuditLog $ghost */ function f($unused) { $ghost->save(); }`: no edge). Regression: `php-docblock-param-scope.test.ts` (82 cases). |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/php/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/php/scope-resolver.ts).
- [php-qualified-factory-review.test.ts](../../gitnexus/test/integration/php-qualified-factory-review.test.ts).
- [php-coverage.test.ts](../../gitnexus/test/integration/resolvers/php-coverage.test.ts).
- [php-scope-capture-tripwire.test.ts](../../gitnexus/test/integration/php-scope-capture-tripwire.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
