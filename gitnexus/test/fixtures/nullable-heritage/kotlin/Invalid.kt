// The Kotlin compiler rejects this override because the inherited parameter accepts null.
class Narrow : Mid<String>() { override fun accept(value: String) {} }
class NarrowList : Mid<List<String>>() { override fun accept(value: List<String>) {} }
class WrongNested : Mid<List<String>>() { override fun accept(value: List<Int>?) {} }
class NullableReturn : Mid<() -> String>() { override fun accept(value: () -> String?) {} }
class EscapedMismatch : Mid<List<`Element With Spaces`>>() {
    override fun accept(value: List<ElementWithSpaces>?) {}
}
class WrongVariance : Mid<Slot<in String>>() { override fun accept(value: Slot<out String>?) {} }
class WrongStar : Mid<Slot<*>>() { override fun accept(value: Slot<String>?) {} }
class WrongName : Mid<Slot<out String>>() { override fun accept(value: Slot<outString>?) {} }
