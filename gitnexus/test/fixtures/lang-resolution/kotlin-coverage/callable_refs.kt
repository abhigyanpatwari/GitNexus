package coverage

fun topLevelFn(): Int = 1

class Obj {
    fun method(): String = "m"
}

fun useCallableRefs() {
    val a = ::topLevelFn
    val b = String::length
    val obj = Obj()
    val c = obj::method
    val d = Type::new
}
