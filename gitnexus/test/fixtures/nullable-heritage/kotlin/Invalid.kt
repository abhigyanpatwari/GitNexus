// The Kotlin compiler rejects this override because the inherited parameter accepts null.
class Narrow : Mid<String>() { override fun accept(value: String) {} }
