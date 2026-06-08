package coverage

fun useDestructuring(pair: Pair<Int, String>, map: Map<String, Int>) {
    val (a, b) = pair
    val (_, second) = pair
    for ((k, v) in map) { }
    val x = 1
}
