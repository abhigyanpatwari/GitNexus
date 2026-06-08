package coverage

class C {
    companion object {
        const val TAG = "c"
        val instances = 0
        fun create() {}
    }
}

class NamedComp {
    companion object Factory {
        val cfgX = 1
    }
}
