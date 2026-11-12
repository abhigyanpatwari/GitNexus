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

The typed plain and safe-navigation chains resolve. Before RUBY-01 was fixed, the baseline recorded YARD parameter bindings landing on Module scope: a typed sibling could lend its type to an untyped parameter with the same name, in either declaration order, and fresh probes using the same `svc` parameter reproduced the wrong `User.save` edge from the untyped sibling in both orders (see the audit receipt). `rubyBindingScopeFor` now keeps `@type-binding.parameter` on the declaring method; [ruby-yard-param-scope.test.ts](../../gitnexus/test/integration/resolvers/ruby-yard-param-scope.test.ts) pins typed/untyped siblings in both declaration orders against the exact owner ID with a decoy `save`, and carries the review corpus below as pin-only expectations. The benchmark keeps its distinct parameter names so each cell measures its own spelling.

### Boundaries chosen for precision (missing beats wrong)

- A YARD `@param` types only a name that is one of the method's formal parameters and that the body never REBINDS — binding-target semantics: the name itself, or the name reached through a destructuring list / splat (`a, user = …`, `(a, user), b = …`, `a, *user = …`), `||=`/`+=`, `for`, `rescue =>`, a block/lambda/nested-def parameter or block local (`|x; user|`), or a `case … in` / `=>` / `in` pattern (array/find/hash/as/splat patterns and the hash shorthand `{user:}`). A write INTO the parameter (`user.name = x`, `post.user = user`, `self.user = user`, `user[0] = 1`, `@cache[user.id] = user`, `user.count += 1`, `user&.name = x`, `user.a, user.b = …`), a block-parameter default reading it (`|x, y = user|`), a pinned `^user` or `^(user)`, and a read inside a nested block or lambda do NOT decline the tag (an assignment nested inside a pinned expression is a corner accepted unseen). In the method scope the tag's fact (strength 2) outranks a local's constructor-inferred type (strength 1), so without this a `# @param user [AuditLog]` would retype `user = User.new; user.save` as `AuditLog#save` (before the pin the local won by scope order) and a doc-drifted tag would type a name it never described. A declined tag types nothing. Shadowing declines are kept on purpose: a block `|user|`, a lambda `->(user)` or a nested `def inner(user)` declines the outer tag, because an untyped `user` inside them would otherwise climb the scope chain to it.
- Not guarded (documented gaps, the tag stays): a regex named capture `/(?<user>…)/ =~ s`, `binding.local_variable_set(:user, …)`, `eval`.
- With the tag declined, a rebound parameter resolves exactly as its untagged twin (and main) does: `user = AuditLog.new; user.save` → `AuditLog#save`, `user = UserDecorator.new(user); user.full_name` → `UserDecorator#full_name`, `opts = Options.new(opts); opts.save` → `Options#save`, `user = user.account; user.save` → no edge. A call before the rebinding (`user.save; user = AuditLog.new`) keeps the pre-existing flow-insensitive answer, the local's type (`AuditLog#save`, as on main and for the untagged twin); letting the tag win would get that order right but every reassign-then-use idiom above wrong.
- A YARD `@param` types the parameter and nothing else. `@user = user` in `initialize` does NOT type `@user`, so `@user.save` in a sibling method stays unresolved (as on main), and the `attr_reader :user` forms no longer resolve: `holder.user.save`, and inside the class the bare `user.save` and `self.user.save`. Main resolved those only through the leaked class-scope `user` binding that also produced the wrong sibling edges. A YARD `@return` on a hand-written reader still types its chain, and so does one on an `attr_reader`, except when the annotated `attr_reader` is the first statement of the class body (pre-existing: `findFollowingAttrCall` lacks the `body_statement` descent that `findFollowingMethod` has). `@user = User.new` still binds the field through the constructor pattern.
- Pre-existing, unchanged: an explicit `target()` beside a same-named parameter resolves to nothing (`RUBY_CALLABLE_CAPTURE_OPTIONS` models `param()` as an invoke through the parameter cell), while a bare `target` read beside that parameter still resolves to the method (a local read misread as a call). Both are measured identically with the main provider files.
- Pre-existing, unchanged: a method-local that gets no type binding at all (e.g. `user = 42`) walks to outer scopes for its type; Ruby parameters are not lexical claims, and claiming them would block the explicit calls above.
- Pre-existing, unchanged: `user ||= User.new` is an `operator_assignment`, which the constructor pattern does not bind, so `user.save` after it is unresolved; a declined `@param` tag on that name must not fill the gap (it would type it wrongly), so the edge stays missing.
- Pre-existing, unchanged: `@user = Const.new` in one method binds `@user → Const` on the class even when another method writes something else to it.
- Pre-existing, unchanged: a tag above `private def m(user)` or a `sig`-prefixed def is not attached (`findFollowingMethod` accepts only a `method` / `singleton_method` sibling), so its call is a missing edge; main typed it only when a sibling's same-named tag leaked onto the class.
- Pre-existing, unchanged (follow-up): a YARD `@return` on an `attr_reader` publishes the accessor's type on the class scope, so an untyped sibling parameter with the accessor's name borrows it: `# @return [User]` above `attr_reader :user`, then `def other(user); user.save; end` resolves to `User#save` (identical on main). This is the RUBY-01 shape from a different source, and the reason the first-statement `findFollowingAttrCall` descent is not added here: it would extend that leak to more classes.

### Future: field typing from typed parameters (parked design, not in this PR)

Inferring `@ivar → T` from `@ivar = param` with `# @param param [T]` was prototyped and withdrawn: per-file capture synthesis cannot see every write to the field, so the published type can be wrong, and a wrong field type reaches every reader of the ivar. Any future attempt must start from this hazard list and decline whenever one applies:

1. Writes the per-file collector cannot classify must veto, not be skipped: writes under a block body (`[..].each { |log| @user = log }`), `@user, x = …` multiple assignment, `@user ||= …` / `@user += …`, any non-parameter, non-`Const.new` value (`nil`, call results).
2. Ownership is the Ruby object, not the syntactic class body: reopened classes (same file or another file) and mixins (`module Storage` included into the class) all write the same ivar, so agreement must be established across every body that can write it — which a per-file capture layer cannot do.
3. Generated writers are writes: `attr_accessor :user` / `attr_writer :user` let `h.user = AuditLog.new` change the field without any `@user =` in the class.
4. `normalizeYardType` turns `Array<User>` into `User`; a container-typed parameter must never publish its element type as the field's scalar type.
5. Parameter rebinding before the ivar write must veto: plain and multiple assignment, `||=`/`+=`, `for x in`, `rescue => x`, block/lambda/nested-def parameters, `case … in` patterns, rightward `expr => x` / `expr in x` (node positions enumerated from the tree-sitter-ruby grammar).
6. Conflicting typed writes (`initialize(user)` `[User]` vs `replace(log)` `[AuditLog]`) must type nothing; agreeing writes must type once; a hand-written reader's own `@return` must win over any inferred accessor type.
7. The accessor name must never be published on the class scope (`user → T`): it is readable from every sibling method's same-named untyped parameter, because Ruby parameters are not lexical claims, and claiming them blocks explicit `name()` calls.

## Planning candidates

| ID      | Evidence     | Gap or boundary                                                                                           | Next planning step and acceptance                                                                                                                                                                         |
| ------- | ------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RUBY-01 | Fixed        | YARD parameter types leaked between sibling functions: the method-anchored binding was auto-hoisted.     | Fixed: `rubyBindingScopeFor` binds `@type-binding.parameter` to the declaring method; the tag binds only a formal parameter the body never rebinds (binding-target semantics — writes into the parameter and reads keep it; never `self`), and nothing else is inferred from it. Regression test covers typed/untyped siblings in both orders; the rebinding forms it guards — plain/multiple/splat assignment, `||=`/`+=`, `for`, `rescue =>`, block/lambda/nested-def parameters and block locals, `case … in` / `=>` / `in` patterns incl. the hash shorthand `{user:}` — each `[]` with the guard and a wrong `User#save` without; the kept write-into/read forms (ten lost on the mention-based guard, `^(user)` lost after it); and the construct coverage. Not guarded: regex named captures, `binding.local_variable_set`, `eval`; the pin-only ivar boundaries and the pre-existing explicit-call gap are pinned separately. Known unguarded rebindings listed above. |
| RUBY-02 | Measured gap | `plainDeepChain` reaches an attr_reader property whose type is unavailable.                               | Reproduce the property-type loss before choosing a propagation rule. Preserve accessor dispatch and same-name owner boundaries.                                                                           |
| RUBY-03 | Measured gap | `indexElement` is visible after the walker learned element_reference, but there is no elementTypeOf hook. | Carry YARD Array<User> element evidence into a provider route. Keep unsupported arrays and the intentional untypedChain control unresolved.                                                               |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/ruby/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/ruby/scope-resolver.ts).
- [ruby-accessor-dispatch.test.ts](../../gitnexus/test/integration/resolvers/ruby-accessor-dispatch.test.ts).
- [ruby-scope.test.ts](../../gitnexus/test/integration/resolvers/ruby-scope.test.ts).
- [ruby-captures-golden.test.ts](../../gitnexus/test/unit/scope-resolution/ruby/ruby-captures-golden.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
