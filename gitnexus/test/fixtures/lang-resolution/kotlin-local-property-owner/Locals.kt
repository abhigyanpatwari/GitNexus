package coverage

class C(val field: Int) {
    val classProp: Int = field

    // CF3 review (#1919): destructuring inside an init {} block is a
    // function-local binding (anonymous_initializer is an executable body),
    // NOT a class member — it must not be owned by C.
    init {
        val (ix, iy) = field to field
        println(ix)
        println(iy)
    }

    // ...and the same for locals inside a property accessor (getter) body.
    // `derived` is a genuine class property (owned); `gx`/`gy` are not.
    val derived: Int
        get() {
            val (gx, gy) = field to field
            return gx + gy
        }

    fun process(map: Map<String, Int>) {
        for ((k, v) in map) {
            println(k)
            println(v)
        }
        val pair = Pair(1, 2)
        val (a, b) = pair
    }
}
