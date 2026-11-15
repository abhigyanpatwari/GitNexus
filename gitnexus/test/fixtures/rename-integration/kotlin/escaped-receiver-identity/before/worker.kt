class `Worker` {
    fun read(): Int { return 1 }
}
fun run(): Int {
    val `worker`: `Worker` = `Worker`()
    return `worker`.read()
}
