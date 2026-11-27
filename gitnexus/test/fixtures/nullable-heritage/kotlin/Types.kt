open class Base<T> { open fun accept(value: T) {} }
open class Mid<X> : Base<X?>()
class Generic<T> : Mid<T>() { override fun accept(value: T?) {} }
class Concrete : Mid<String>() { override fun accept(value: String?) {} }
open class Bounded<X : Any> : Base<X?>()
class BoundedGeneric<T : Any> : Bounded<T>() { override fun accept(value: T?) {} }
class Direct : Base<String?>() { override fun accept(value: String?) {} }
class Unrelated : Mid<String>() { fun accept(value: Int) {} }
