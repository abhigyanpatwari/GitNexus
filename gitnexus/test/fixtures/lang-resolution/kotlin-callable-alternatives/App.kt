fun runSweep() {}
fun runThen() {}
fun runElse() {}

fun elvis(override: (() -> Unit)?) {
    val run = override ?: ::runSweep
    run()
}

fun ifExpression(fast: Boolean) {
    val run = if (fast) ::runThen else ::runElse
    run()
}
