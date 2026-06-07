package coverage

class Point(val x: Int) {
    constructor(a: Int, b: String) : this(a) { helper() }
    constructor() : this(0) { helper(); other() }
    fun describe(): String = "p"
}

class OnlyPrimary(val v: Int) {
    fun method(): Int = v
}

fun helper() {}
fun other() {}
