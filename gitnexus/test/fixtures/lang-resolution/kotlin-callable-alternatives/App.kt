fun runSweep() {}
fun runThen() {}
fun runElse() {}

fun elvis(override: (() -> Unit)?) {
    val run = override ?: ::runSweep
    run()
}

fun runLeft() {}

fun callableLeft(fallback: () -> Unit) {
    val run = ::runLeft ?: fallback
    run()
}

fun ifExpression(fast: Boolean) {
    val run = if (fast) ::runThen else ::runElse
    run()
}

fun runBracedThen() {}
fun runBracedElse() {}

fun braced(fast: Boolean) {
    val run = if (fast) { ::runBracedThen } else { ::runBracedElse }
    run()
}

fun log() {}
fun runBlockThen() {}
fun runBlockElse() {}

fun multiStatement(fast: Boolean) {
    val run = if (fast) { log(); ::runBlockThen } else { ::runBlockElse }
    run()
}
