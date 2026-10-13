data class Pair2(val first: Int, val second: Int)

fun move(pair: Pair2): Pair2 = pair.copy(first = 3)
