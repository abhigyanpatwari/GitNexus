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

val handler = object {
    fun sibling() {}

    fun callSibling() {
        sibling()
    }
}
