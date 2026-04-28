abstract class Animal {
    abstract fun speak(): String

    companion object {
        fun classify(name: String): String {
            return "mammal"
        }
    }

    fun breathe(): Boolean {
        return true
    }
}

class Dog : Animal() {
    override fun speak(): String {
        return "woof"
    }
}
