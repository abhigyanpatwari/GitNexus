class Logger(val name: String) {
    fun log(message: String): String {
        return "$name: $message"
    }

    companion object {
        fun create(name: String): Logger {
            return Logger(name)
        }
    }
}

// Companion call via the class name — must resolve to Logger.create().
fun makeLogger() {
    val logger = Logger.create("app")
    // Instance call via a value receiver — must resolve to the instance log(),
    // not to the companion's create().
    logger.log("hello")
}

// Direct instance call on a freshly-constructed Logger — must resolve to
// the instance log().
fun directLog() {
    val logger = Logger("direct")
    logger.log("hi")
}

// Adversarial call: `logger.create(...)` is invalid Kotlin (you can't call a
// companion-object method through an instance receiver — it's a compile
// error). A code-intelligence tool that emits an edge here would be telling
// readers the call resolves when it doesn't. Test asserts no CALLS edge.
fun crossover() {
    val logger = Logger("x")
    logger.create("nope")
}
