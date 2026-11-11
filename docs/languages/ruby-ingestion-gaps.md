# Ruby Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                                             |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `plainChain`            | RESOLVES       | `plain_svc.get_user.save`                                                           |
| `untypedChain`          | VISIBLE-GAP    | `untyped_svc.get_user.save` (intentional untyped control)                           |
| `plainDeepChain`        | VISIBLE-GAP    | `deep_svc.get_user.address.save`                                                    |
| `optionalChain`         | RESOLVES       | `opt_svc&.get_user.save`                                                            |
| `nonNullAssert`         | N/A            | Ruby has no non-null assertion operator.                                            |
| `awaitParen`            | N/A            | Ruby has no await expression in the core language.                                  |
| `explicitTypeArgs`      | N/A            | Ruby has no type-argument syntax.                                                   |
| `indexElement`          | VISIBLE-GAP    | `idx_repos[0].save`                                                                 |
| `fieldReceiverCall`     | RESOLVES       | `@repo.save`                                                                        |
| `decoratedReceiverBase` | N/A            | Ruby method receivers carry no type decoration.                                     |
| `decoratedFieldType`    | N/A            | Ruby instance variables carry no declared type, so there is no decoration to strip. |

The typed plain and safe-navigation chains resolve. The baseline records YARD parameter bindings landing on Module scope: a typed sibling can lend its type to an untyped parameter with the same name, in either declaration order. The benchmark avoids the collision with distinct parameter names; that workaround does not fix the product. Fresh probes using the same `svc` parameter reproduced the wrong `User.save` edge from the untyped sibling in both declaration orders; see the audit receipt.

## Bare identifier reads (RUBY-04, fixed)

A receiver-less, paren-less identifier that is a statement of its own is captured as a zero-arity call (`(body_statement (identifier)) @reference.call.free`). Ruby decides that question lexically: the name is a variable read once a formal parameter, a block parameter or an assignment seen earlier in the enclosing scope has bound it, and a method call otherwise. Before the fix `class Host; def target; end; def run(target); target; end; end` produced a wrong `run → Host#target` CALLS edge. `emitRubyScopeCaptures` now drops the capture when the name is bound; [ruby-bare-read-shadows-method.test.ts](../../gitnexus/test/integration/resolvers/ruby-bare-read-shadows-method.test.ts) pins every case below against the exact `Host#target` ID with a decoy `Other#target`.

- Bindings that make the bare name a read (no edge): the enclosing `def` / lambda's formal parameters (positional, optional, keyword, splat, hash-splat, `&block`, destructured), a `|x|` block parameter or `|x; y|` block local of an enclosing block, and a local bound earlier in the same scope by assignment (plain, multiple, `||=`), `for`, `rescue =>`, or a `case … in` / `=>` / `in` pattern (including the hash shorthand `{target:}`). A block sees the names of every enclosing block and the method; a nested `def` starts a fresh scope and sees none of them.
- Kept as calls: `target()`, `self.target`, `target arg`, a bare name with no binding in scope, a read BEFORE the assignment (`target; target = 1` — Ruby registers a local when the parser passes its assignment), a bare name after a block whose parameter or local had that name (block bindings do not leak), and a nested `def` body reading a name only its enclosing method binds.
- Not captured either way (pre-existing): a bare name inside a brace block body (`block_body`), a `begin … end` body, an `if` / `case` / `rescue` branch (`then`) or a `for` / `while` body (`do`), which the statement pattern never matched. Not guarded (the capture stays): a regex named capture `/(?<target>…)/ =~ s`, `binding.local_variable_set`, `eval`.
- Pre-existing, unchanged: an explicit `target()` beside a same-named parameter resolves to nothing (`RUBY_CALLABLE_CAPTURE_OPTIONS` models `param()` as an invoke through the parameter cell), so that edge is still missing; this fix only removes the wrong edge of the bare read.

### Round 2 (review: parameters bind left-to-right; per-scope index)

- Correctness: a parameter binds a bare read only when the parameter's NAME node starts before the read. Ruby registers a parameter as the parser passes its name, so a default expression sees the parameters declared before it and the parameter it belongs to, never a later one: `def run(x = [1].each do |a| target end, target: nil)` calls the method (edge kept), `def run(target = nil, x = [1].each do |a| target end)` reads the parameter (no edge), and `def run(target = [1].each do |a| target end)` reads the nil local — a circular reference (no edge). Verified on Ruby 2.6 for method, keyword, block (`|a = …, target|`) and lambda parameter lists. The first cut treated every parameter as bound throughout the method. A default is reachable by the statement pattern only through a `do` block or lambda body nested in it: the review's `def run(x = begin; target; end, target: nil)` spelling is never captured (no edge before or after, pinned as `[]`), while the `do`-block spelling was captured and the first cut dropped its edge (pinned as kept). The ordering rule is implemented for every spelling and unit-pinned directly on parsed trees ([ruby-bare-read-order.test.ts](../../gitnexus/test/unit/scope-resolution/ruby/ruby-bare-read-order.test.ts)).
- Performance: bindings are indexed once per scope per file — `rubyScopeBindings` records, for a `method` / `singleton_method` / `block` / `do_block` / `lambda` (or class / module / program) node, the earliest offset at which each name is bound (parameters at their name node, binding sites at the binding node, nested scopes skipped), cached by tree-sitter node id for the file's capture pass — so each bare read costs one map lookup per enclosing scope instead of re-walking the scope and rebuilding parameter lists. Decision-identical on the fixture corpus (Ruby golden and scope-capture fingerprint unchanged from the round-1 rebaseline).
- Where a name binds (cubic rounds 2 and 3): at the offset where it is WRITTEN — a parameter at its name node, an assignment target or pattern variable at its identifier — which is the rule Ruby's parser follows. So a bare read inside the value of a rightward `value => target` / `value in target` (`[1].each do |a| target end => target`) and inside an earlier multiple-assignment target's subscript (`arr[[1].map do |x| target end], target = [], 1`) is still a call (edge kept), while a read after either statement is a read. Pinned in both test files.
- Round 5 (mirrored from the enterprise port's second-vendor review, PR Akon-Labs/gitnexus-enterprise#681; also closes the cubic round-4 follow-up): three shapes where the filter dropped a REAL call. (1) A header expression Ruby evaluates in the ENCLOSING scope — a singleton method's receiver (`def (target = Object.new).run; target; end`), a class's superclass, a `class << value` value — is left out of that scope's own index and included in the enclosing scope's, so the body read keeps its call and a later bare `target` in the enclosing scope is a read; a read INSIDE such a header (reachable through a `do` block or lambda body, `def outer(target); def ([1].each do target end).inner; end; end`) is answered by the enclosing scope (no edge, outer's parameter), while a bare header NAME (`class << make_base`) is not a binding site. (2) `BEGIN { … }` / `END { … }` bodies are closed scopes, so `BEGIN { target = 1 }; target` keeps the call. (3) The pattern collector is an allow-list of pattern containers (array / find / hash / alternative / parenthesized) and binding positions (identifier, keyword pattern incl. `{target:}`, as-pattern, splat / hash-splat); a string / regex / symbol / subshell `interpolation`, a `lambda` pattern, a `^pin`, a constant and a range bind nothing, so `in "x#{target}"` keeps the later call. Each shape is pinned fail-first in both test files. When #3871's YARD `@param` guard lands beside this, its pattern walker should adopt the same allow-list: strictly fewer declines, no new ones.
- Mutation audit of the guard over the regression fixture: ignoring position wrongly drops the four later-default cases and `read_before_assign`; removing the parameter index wrongly keeps 19 parameter cases; removing the binding-site walk wrongly keeps 9 local cases; descending into nested scopes wrongly drops `sibling_block_local_does_not_leak`; not stopping at a closed scope wrongly drops `nested_def_reads_method`.

## Planning candidates

| ID      | Evidence     | Gap or boundary                                                                                           | Next planning step and acceptance                                                                                                                                                                         |
| ------- | ------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RUBY-01 | Recorded gap | YARD parameter types can leak between sibling functions.                                                  | Bind annotations to the declaring function. Test typed/untyped siblings with the same parameter name in both orders; the typed call must hit its exact owner and the untyped call must remain unresolved. |
| RUBY-02 | Measured gap | `plainDeepChain` reaches an attr_reader property whose type is unavailable.                               | Reproduce the property-type loss before choosing a propagation rule. Preserve accessor dispatch and same-name owner boundaries.                                                                           |
| RUBY-03 | Measured gap | `indexElement` is visible after the walker learned element_reference, but there is no elementTypeOf hook. | Carry YARD Array<User> element evidence into a provider route. Keep unsupported arrays and the intentional untypedChain control unresolved.                                                               |
| RUBY-04 | Fixed        | A bare read of a name that is both a method on the enclosing class and a parameter or local resolved to the method (a local read misread as a call). | Fixed: `emitRubyScopeCaptures` drops the bare-identifier call capture when the enclosing scope binds the name (see "Bare identifier reads" above). The explicit `target()` beside a same-named parameter remains a missing edge. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/ruby/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/ruby/scope-resolver.ts).
- [ruby-accessor-dispatch.test.ts](../../gitnexus/test/integration/resolvers/ruby-accessor-dispatch.test.ts).
- [ruby-scope.test.ts](../../gitnexus/test/integration/resolvers/ruby-scope.test.ts).
- [ruby-captures-golden.test.ts](../../gitnexus/test/unit/scope-resolution/ruby/ruby-captures-golden.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
