package coverage

class C(val field: Int) {
    val classProp: Int = field

    fun process(map: Map<String, Int>) {
        for ((k, v) in map) {
            println(k)
            println(v)
        }
        val pair = Pair(1, 2)
        val (a, b) = pair
    }
}
