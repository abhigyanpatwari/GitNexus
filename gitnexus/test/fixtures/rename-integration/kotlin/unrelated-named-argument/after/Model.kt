data class Pair2(val head: Int, val second: Int)

class Unrelated(val first: Int)

fun configure(first: Int) {}

fun make() {
    Unrelated(first = 1)
    configure(first = 2)
}

fun read(pair: Pair2): Int = pair.head
