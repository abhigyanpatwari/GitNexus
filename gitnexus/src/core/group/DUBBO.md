# Dubbo dependencies across repositories

Group analysis can discover Java Dubbo RPC dependencies, including when the
interface source is in a separate contract repository. This is opt-in: existing
groups keep their current behavior.

Index the consumer, interface and provider repositories, using distinct registry
names, then create a group:

```sh
gitnexus analyze /path/to/consumer --name account-consumer --index-only
gitnexus analyze /path/to/api --name account-api --index-only
gitnexus analyze /path/to/provider --name account-provider --index-only
gitnexus group create accounts
```

Edit the generated `group.yaml`:

```yaml
version: 1
name: accounts
repos:
  consumer: account-consumer
  api: account-api
  provider: account-provider
detect:
  dubbo: true
```

Run `gitnexus group sync accounts`. To find callers across the group:

```sh
gitnexus group impact accounts --repo provider --target AccountService --direction upstream
gitnexus group impact accounts --repo api --target Account --direction upstream
```

For MCP, call `impact` with `repo: "@accounts/provider"`, `target` (or
`target_uid`) and `direction: "upstream"`. The
`gitnexus://group/accounts/contracts?type=dubbo` resource exposes the discovered
contracts. Re-analyze changed member repositories before re-syncing.

## Extraction and identity

- Field injection with Apache `@DubboReference` / `@Reference`, and legacy
  Alibaba `@Reference`, identifies consumer calls on the injected field.
- Apache `@DubboService` / `@Service`, and legacy Alibaba `@Service`, identify
  provider classes. `interfaceClass` and `interfaceName` are supported; without
  either, a single directly implemented interface is required.
- Annotations must have a matching import or fully qualified name. A Spring
  `@Service` does not declare a Dubbo provider.
- Interface, group, version, method and erased parameter types form a
  case-sensitive contract identity. Empty group/version values match only the
  same empty values. Values resolved from external Dubbo configuration are not
  inferred. Different service groups or versions never match by simple name.
- A consumer call selects a method only when its name and argument count identify
  one supported declaration. Same-arity overloads, unresolved parameter types,
  generic service types/methods and varargs are skipped, not guessed.
- Interface and implementation methods, plus service-level type anchors, resolve
  to real symbols in each member's index. Interface declarations are exported
  only for services selected by Dubbo annotations. No synthetic graph UIDs are
  manufactured. Duplicate interface FQNs across members are treated as ambiguous.

Cross-repository relationships are stored as `dubbo` contracts and links in the
existing group bridge. They do not mutate per-repository `CALLS` edges. Single-repo
`context`/`impact` remain local; use group impact for the cross-repository boundary.
Interface declarations and implementations are both provider anchors for the
same RPC contract, so either can lead back to the real calling method.

## Current boundaries

This implementation supports top-level Java types with interface source available
in the group. It does not infer inherited interface methods, nested types,
method/bean injection, XML configuration, generic `$invoke` calls, remote
interfaces available only as JARs, or runtime-selected group/version values.
Reassigned or shadowed proxy fields are skipped conservatively. Runtime
placeholders and wildcard service selectors are also skipped.

Source scans honor the repository ignore rules and file-size limit, reject
symlink escapes, and release native parser trees between batches. Group discovery
shares plain source facts, while each member resolves symbols using its own
leased database connection. Unreadable graph members use the existing group
sync completeness diagnostics.

## Verification

After `cd gitnexus && npm ci && npm run build`:

```sh
node --import tsx --test tools/compiler-conformance/java/test/provider/dubbo-contracts.ts
node --import tsx --test tools/compiler-conformance/java/product/dubbo-cross-repo.ts
npm test -- test/unit/group
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
```

Both new suites are discovered by `npm run test:conformance:java`. The product
test creates and indexes three separate Git repositories, runs production sync,
queries the persisted bridge, and checks group impact from the interface and
implementation back to the consumer. It requires no embedding provider or
external Java project.
