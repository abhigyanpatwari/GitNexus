// Fixture for U3 (#1756 remediation plan): extend the `isStaticOnly`
// crossover filter to receiver-bound dispatch cases beyond Case 4.
//
// Three target cases:
//   - Case 0 (compound receiver): the call site's `receiverName`
//     contains `.` or `(`, so `resolveCompoundReceiverClass` is used
//     to resolve the receiver's class. e.g. `Logger.create("a").create("b")`
//     — the OUTER `.create("b")` has compound receiver `Logger.create("a")`
//     and `resolveCompoundReceiverClass` resolves it to `Logger`.
//     `findOwnedMember(Logger, "create")` then returns the static-only
//     companion-promoted `create`. Pre-U3, Case 0 would emit a CALLS
//     edge to the companion `create`. Post-U3, the static-only filter
//     suppresses the edge.
//   - Case 3b (chain-typebinding): the call site's receiver has a
//     typeBinding whose `rawName` is a dotted chain expression (e.g.,
//     a chain-bound value). For Kotlin, this fires when an expression
//     produces a typeBinding that walks through chained receivers.
//   - Case 5 (value-receiver bridge): the receiver is a Const/Variable
//     without a class-like or typeBinding match; resolved via
//     `findValueBindingInScope` + `pickOverload` on a single owner.
//
// The legitimate edges (e.g., `Logger.create("a")` via class-name receiver)
// must continue to emit, so we test both the crossover (zero edges) AND
// the happy paths (exact-count edges).

class Logger {
    fun log(s: String) {}
    companion object {
        fun create(name: String): Logger = Logger()
    }
}

class Service {
    fun perform() {}
    companion object {
        fun build(): Service = Service()
    }
}

class Repo {
    fun getAll(): List<Service> = listOf()
}

// Case 0 (compound receiver) — outer `.create("b")` on a Logger instance
// returned by `Logger.create("a")`. The receiverName is the compound
// expression `Logger.create("a")` which resolves to `Logger`; then
// looking up `create` on Logger returns the companion-promoted static-
// only `create`. That edge must be suppressed.
//
// The INNER `Logger.create("a")` is a Case 2 class-name receiver — it
// resolves through `findClassBindingInScope` and `findOwnedMember`
// returns the companion-promoted `create` (legitimate). Companion
// dispatch through the class name is the canonical happy path; that
// edge must emit.
fun useCompoundCrossover() {
    Logger.create("a").create("b")
}

// Case 3b (chain-typebinding) — `services` has a chain typeBinding for
// `Service` (inferred via the chain from `r.getAll()`), so calling
// `.build()` on `services.first()` looks up `build` on `Service`
// through Case 3b's `resolveCompoundReceiverClass(rawName, ...)` path
// where `rawName` contains a dot from the chain. The static-only
// companion `build` must be suppressed.
//
// The legitimate edge in this function is `r.getAll()`; that edge
// must emit (resolves through Case 4 simple-typeBinding `r: Repo`).
fun useChainTypeBindingCrossover() {
    val r = Repo()
    val services = r.getAll()
    services.first().build()
}

// Case 5 (value-receiver bridge) — `l` is a Const/Variable whose
// typeBinding would normally route to Case 4. Listed here as a
// defensive wire-up site: Kotlin annotations make Case 4 the
// primary path even for `val l: Logger = ...`, but adding the
// filter at Case 5 preserves contract symmetry for any future
// shape where the value-binding is hit (e.g., object-literal-like
// receivers via cross-language conventions).
//
// We split the legitimate `Logger.create(...)` setup into a helper
// function so the crossover assertion can target the
// `useValueReceiverCrossover → create` edge count directly without
// having to subtract the legitimate setup edge.
fun makeLoggerForCrossover(): Logger = Logger.create("v")

fun useValueReceiverCrossover() {
    val l = makeLoggerForCrossover()
    l.create("nope")
}
