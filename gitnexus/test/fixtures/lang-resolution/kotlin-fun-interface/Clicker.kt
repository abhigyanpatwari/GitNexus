package fixtures

// Functional (SAM) interfaces — the `fun interface` modifier.
// Before tree-sitter-kotlin gained `fun interface` support (fwcd #169), the
// vendored 0.3.8 grammar parsed these as an ERROR node and dropped the whole
// declaration, so neither the interface nor its abstract method was extracted.
fun interface Clicker {
    fun onClick(id: Int): Boolean
}

fun interface Mapper<T> {
    fun map(value: T): String
}

// A regular interface alongside, to confirm both shapes coexist.
interface Plain {
    fun plain(): Int
}

class Button : Plain {
    override fun plain(): Int = 0

    fun bind(clicker: Clicker) {
        clicker.onClick(1)
    }
}
