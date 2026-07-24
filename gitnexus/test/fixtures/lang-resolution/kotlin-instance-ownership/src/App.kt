open class Base {
    fun inherited() {}
}

class Owner : Base() {
    fun own() {}

    fun callOwn() {
        own()
    }

    fun callInherited() {
        inherited()
    }
}

class Unrelated {
    fun collide() {}
}

class Caller {
    fun run() {
        collide()
    }
}

class Outer {
    fun outerMethod() {}

    inner class Inner {
        fun callOuter() {
            outerMethod()
        }
    }
}

val handler = object {
    fun sibling() {}

    fun callSibling() {
        sibling()
    }
}
