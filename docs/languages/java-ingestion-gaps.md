# Java Ingestion Gaps

The original audit measured `c35806d24` on 2026-10-23. On 2026-11-18 the
receiver benchmark and the Java examples below were run on `main` at
`7c312cffa` and on PR #3955 at `c36276c1e`. [Original measurement audit](receiver-resolution-audit.md) · [PR #3955](https://github.com/abhigyanpatwari/GitNexus/pull/3955).

## Receiver shape snapshot

The table shows the baseline on #3955. All five executable Java shapes reach
their exact expected declaration, and five shapes are inapplicable. Only
`indexElement` changed between the two revisions. [Main baseline](https://github.com/abhigyanpatwari/GitNexus/blob/7c312cffa6b70ddd89cc658118fc034044f34e5c/gitnexus/bench/receiver-resolution/baseline.json) · [PR baseline](https://github.com/abhigyanpatwari/GitNexus/blob/c36276c1eb2358efd195b2b40fb2a361fd8cd341/gitnexus/bench/receiver-resolution/baseline.json).

| Shape                   | Recorded state | Expression or exclusion                                                                                                                                                    |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.getUser().save();`                                                                                                                                                    |
| `plainDeepChain`        | RESOLVES       | `svc.getUser().address.save();`                                                                                                                                            |
| `optionalChain`         | N/A            | Java has no optional-chaining operator.                                                                                                                                    |
| `nonNullAssert`         | N/A            | Java has no non-null assertion operator.                                                                                                                                   |
| `awaitParen`            | N/A            | Java has no await expression in the core language.                                                                                                                         |
| `explicitTypeArgs`      | RESOLVES       | `svc.<User>getTyped().save();`                                                                                                                                             |
| `indexElement`          | RESOLVES       | `repos[0].save();` with a `User[] repos` parameter reaches `Method:User.java:User.save#0`.                                                                                  |
| `fieldReceiverCall`     | RESOLVES       | `this.repo.save();`                                                                                                                                                        |
| `decoratedReceiverBase` | N/A            | Java `this` carries no type decoration.                                                                                                                                    |
| `decoratedFieldType`    | N/A            | Java's only field-type decorations are containers (arrays, generics), which change the member set and are measured by indexElement rather than by a type-preserving strip. |

The `explicitTypeArgs` fixture declares `<T> User getTyped()`. Its return type
is already `User`. JAVA-04 below exercises a method that returns `T`. [Receiver fixtures](../../gitnexus/bench/receiver-resolution/measure.mjs).

## Planning candidates

| ID      | Status             | Evidence and remaining work |
| ------- | ------------------ | --------------------------- |
| JAVA-01 | Resolved on #3955  | `indexElement` recorded a receiver drop on `7c312cffa`. On `c36276c1e` it reaches only `User.save`. |
| JAVA-02 | Coverage audit     | #3955 tests block-local aliases, anonymous-class field shadowing and lambda parameters typed from workspace functional interfaces. A callback stays unresolved when competing wildcard imports leave its owner uncertain. Classpath and source-root behavior still need real-project coverage. [Lexical scope tests](https://github.com/abhigyanpatwari/GitNexus/blob/c36276c1eb2358efd195b2b40fb2a361fd8cd341/gitnexus/test/integration/java-lexical-scopes.test.ts) · [Callback import tests](https://github.com/abhigyanpatwari/GitNexus/blob/c36276c1eb2358efd195b2b40fb2a361fd8cd341/gitnexus/test/integration/java-sam-lambdas.test.ts#L335). |
| JAVA-03 | Gap on both builds | `repos[0][0].save()` emits no call to `User.save` for a `User[][]` parameter. On #3955, `grid()[0][0].save()` reaches `User.save` when `grid()` returns `User[][]`. [Producer and partial-index controls](https://github.com/abhigyanpatwari/GitNexus/blob/c36276c1eb2358efd195b2b40fb2a361fd8cd341/gitnexus/test/integration/java-member-types.test.ts#L325). |
| JAVA-04 | Gap on both builds | For `<T> T id(T value)`, both `this.<User>id(user).save()` and `id(user).save()` reach `Cases.id` and lose the terminal `User.save` call. Both builds resolve the control whose declared return is `User`. |

### Reproducing JAVA-03 and JAVA-04

Index this as `Cases.java` and inspect outgoing `CALLS` edges from each caller.
The expected terminal target for all six callers is `Method:Cases.java:User.save#0`.
`Other.save` provides a same-named method on a different owner.

```java
class User { void save() {} }
class Other { void save() {} }
class Cases {
  <T> T id(T value) { return value; }
  <T> User concrete(T value) { return null; }
  User[][] grid() { return null; }
  void one(User[] repos) { repos[0].save(); }
  void two(User[][] repos) { repos[0][0].save(); }
  void produced() { grid()[0][0].save(); }
  void concreteReturn(User user) { this.<User>concrete(user).save(); }
  void explicitReturn(User user) { this.<User>id(user).save(); }
  void inferredReturn(User user) { id(user).save(); }
}
```

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/java/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/java/scope-resolver.ts).
- [Receiver alias fixture](../../gitnexus/test/fixtures/compiler-conformance/java-receiver-alias/).
- [Local class naming fixture](../../gitnexus/test/fixtures/lang-resolution/java-local-class-naming/).
- [Java compiler and graph checks](../../gitnexus/tools/compiler-conformance/README.md).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
