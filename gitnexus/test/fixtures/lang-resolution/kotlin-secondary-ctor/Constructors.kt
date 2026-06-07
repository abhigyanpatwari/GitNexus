package coverage

class Point(val x: Int) {
    constructor(a: Int, b: String) : this(a) { }
    constructor() : this(0) { }
    fun describe(): String = "p"
}

class OnlyPrimary(val v: Int) {
    fun method(): Int = v
}
