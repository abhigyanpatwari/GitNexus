open class Base<T> { open fun accept(value: T) {} }
open class Mid<X> : Base<X?>()
class Generic<T> : Mid<T>() { override fun accept(value: T?) {} }
class Concrete : Mid<String>() { override fun accept(value: String?) {} }
open class Bounded<X : Any> : Base<X?>()
class BoundedGeneric<T : Any> : Bounded<T>() { override fun accept(value: T?) {} }
class Direct : Base<String?>() { override fun accept(value: String?) {} }
class Unrelated : Mid<String>() { fun accept(value: Int) {} }
class ListConcrete : Mid<List<String>>() { override fun accept(value: List<String>?) {} }
class NestedConcrete : Mid<Map<String,List<Int?>>?>() {
    override fun accept(value: Map<String, List<Int?>>?) {}
}
class `Element With Spaces`
class ElementWithSpaces
class EscapedConcrete : Mid<List<`Element With Spaces`>>() {
    override fun accept(value: List<`Element With Spaces`>?) {}
}
