// Kotlin CFG hazard fixture (#2195) — one of every control-flow shape the Kotlin
// CfgVisitor models, so the worker-roundtrip / integration passes exercise the
// real (vendored) grammar end-to-end. Mirrors the sibling fixtures
// (swift-hazards, java-hazards, go-hazards). Kotlin's grammar is field-less for
// control flow and `if`/`when`/`try` are expressions — this fixture stresses both
// statement-position constructs and a value-position one.

package fixtures

// if / else-if / else (statement position) + a value-position `if` (stays inline)
fun branching(x: Int): Int {
    if (x > 0) {
        positive()
    } else if (x < 0) {
        negative()
    } else {
        zero()
    }
    val sign = if (x >= 0) 1 else -1 // value-position if — not modeled as a branch
    return sign
}

// when — with subject (no fallthrough) + range/type tests + else
fun dispatch(x: Any) {
    when (x) {
        1, 2 -> small()
        in 3..10 -> medium()
        is String -> text(x)
        else -> other()
    }
    after()
}

// when — without subject (guard form) + a short-circuit guard
fun guarded(x: Int, y: Int) {
    when {
        x > 0 && y < 5 -> both()
        x > 0 -> onlyX()
        else -> neither()
    }
}

// for-in (binds the loop var) + while + do-while (bottom-test)
fun loops(xs: List<Int>) {
    for (item in xs) {
        consume(item)
    }
    while (running()) {
        tick()
    }
    do {
        retry()
    } while (shouldRetry())
}

// destructuring + elvis (`?:`) + safe call (`?.`) — harvest may-defs, not branches
fun harvest(p: Pair<Int, Int>, s: String?): Int {
    val (a, b) = p
    val len = s?.length ?: 0
    var total = a
    total += b
    return total + len
}

// try / catch / finally — the finally runs on both normal and exception exit; a
// return inside the try threads through the finally
fun protect(): Int {
    try {
        val r = risky()
        return r
    } catch (e: Exception) {
        handle(e)
        return -1
    } finally {
        cleanup()
    }
}

// labeled break@outer / continue@loop escaping nested loops
fun labeled(xs: List<Int>, ys: List<Int>) {
    outer@ for (i in xs) {
        for (j in ys) {
            if (i == j) break@outer
            if (i < 0) continue@outer
            pair(i, j)
        }
    }
    done()
}

// while (true) {} — keeps EXIT reverse-reachable via the structural escape edge
fun spin(flag: Boolean) {
    while (true) {
        if (flag) {
            step()
        }
    }
}

// throw with no enclosing try/catch routes to EXIT
fun maybeThrow(x: Boolean) {
    if (x) throw RuntimeException("bad")
    finish()
}

// a lambda is its own CFG; return@label routes to the lambda's EXIT
fun lambdas(xs: List<Int>) {
    xs.forEach { x ->
        if (x < 0) return@forEach
        use(x)
    }
}

// expression-body function
fun square(n: Int) = n * n
