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

- A PHPDoc `@param` types only a name that is one of the callable's formal parameters, is never rebound anywhere in the body (`$x = …`, `[$a, $x] = …`/`list()`, `.=`/`??=`, `$x =& $y` and `$y =& $x`, `foreach … as $x`/`as &$x`, `catch (E $x)`, a nested closure/arrow parameter, a closure `use ($x)`/`use (&$x)`, `static`/`global`/`unset($x)`), and is not `$this`. A declined tag types nothing — the parameter binding and the foreach element type share one decision; the local's own evidence (`new User()`) still resolves. A write INTO the variable (`$x->p = …`, `$x[0] = …`, `unset($x->p)`, `[$x->p => $v] = …`) does not decline the tag.
- Decline-all boundary: a body containing a dynamic variable (`$$name = …`, `${'x'} = …`, or a mere `$$x` read — the grammar cannot tell them apart) or a call to `extract()`, `eval()` or `parse_str()` — spelled bare, upper-cased (`EXTRACT()`), or fully qualified (`\extract()`); `parse_str` in its one-argument form, with ANY named argument (`result: $x`, in any order), or as a first-class callable `extract(...)` / `parse_str(...)` — declines EVERY `@param` tag of that callable, since any local may have been overwritten. Two-argument positional `parse_str($q, $out)` instead binds `$out` (comments between arguments are skipped). Missing edges there are accepted.
- A reference taken ANYWHERE counts as a rebinding: `$x =& $y`, `$y =& $x`, `[&$x]` in an array literal, `f(&$x)` as a by-reference call argument, `use (&$x)`, `foreach (… as &$x)` — the alias can be written through later.
- Safe-direction declines: a plain variable used as a destructuring KEY (`[$k => $v] = …`) counts as bound; a nested closure's own `$x = …` declines the outer tag for `$x`; a nested NAMED function `function inner($x) {}` declines the outer tag for `$x` (kept deliberately: an untyped `$x` inside `inner` would otherwise climb the scope chain to the outer tag and type `inner`'s own call wrongly).
- Follow-up (not a correctness gap): the guard rescans the body once per tag and per consumer (O(tags × body)); a per-callable summary shared by both consumers would remove the repeat.
- Pre-existing, unchanged: `[$a, $user] = …`, `foreach (<array literal> as $user)` and `$user ??= …` get no constructor/element type from the PHP queries, so a call on such a local stays unresolved. An interface method's `@param` never leaked: its binding landed on the interface's own scope, which is not an ancestor of the implementing class's methods.

## Planning candidates

| ID     | Evidence            | Gap or boundary                                                                                                                                                             | Next planning step and acceptance                                                                                                                              |
| ------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHP-01 | Measured gap        | `$repos[0]->save()` cannot use the PHPDoc element type.                                                                                                                     | Preserve both the container and its element type, then add provider-owned element resolution. Check the exact target plus untyped arrays and same-name decoys. |
| PHP-02 | Documented boundary | Functions in multi-namespace files remain ambiguity evidence but are refused as qualified call targets, function imports and factory producers while ownership is unproven. | Capture declaration-local namespace ownership before increasing recall. Preserve single-namespace positives and cross-namespace collision negatives.           |
| PHP-03 | Negative control    | `arrowCallChain` is VISIBLE-GAP for an unannotated return.                                                                                                                  | Keep this control unresolved; a member-name match is not evidence of a receiver type.                                                                          |
| PHP-04 | Fixed               | A PHPDoc `@param` on a BODYLESS method (abstract, or a trait's abstract method) was hoisted onto the class/trait scope, so a sibling method's same-named untyped parameter borrowed its type: `abstract function typed($user)` + `function plain($user) { $user->save(); }` gave `plain → User::save` in either declaration order. In a bodied method the tag also outranked a local's constructor-inferred type (`@param AuditLog $user` + `$user = new User()` typed the call as AuditLog::save). | Fixed: `phpBindingScopeFor` pins `@type-binding.parameter` to the declaring callable; `phpDocParamNameIsBindable` admits a `@param` only for a formal parameter the body never rebinds (assignment, destructuring, `.=`/`??=`, `=&` on either side, `foreach … as` incl. `&$x`, `catch`, nested closure/arrow parameters, closure `use`/`use (&$x)`, `static`/`global`/`unset`), never `$this`, and never in a body with opaque writes (`$$x`, `${'x'}`, `extract()`, `eval()`, one-argument `parse_str()` → every tag of that callable is declined, a `$$x` READ included — safe direction). Writes INTO the variable (`$x->p = …`, `$x[0] = …`, `$x?->p = …`, `unset($x->p)`, `[$x->p => $v] = …`) are not rebindings. The foreach element-type consumer shares the same decision, so a declined tag types nothing anywhere in scope resolution (the type-env reader in `type-extractors/php.ts` is a separate consumer; measured with `/** @param AuditLog $ghost */ function f($unused) { $ghost->save(); }`: no edge). Regression: `php-docblock-param-scope.test.ts` (54 cases). |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/php/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/php/scope-resolver.ts).
- [php-qualified-factory-review.test.ts](../../gitnexus/test/integration/php-qualified-factory-review.test.ts).
- [php-coverage.test.ts](../../gitnexus/test/integration/resolvers/php-coverage.test.ts).
- [php-scope-capture-tripwire.test.ts](../../gitnexus/test/integration/php-scope-capture-tripwire.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
