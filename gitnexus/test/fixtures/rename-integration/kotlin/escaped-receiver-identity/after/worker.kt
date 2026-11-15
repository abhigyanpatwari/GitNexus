class `Worker` {
    fun readValue(): Int { return 1 }
}
fun run(): Int {
    val `worker`: `Worker` = `Worker`()
    return `worker`.readValue()
}
