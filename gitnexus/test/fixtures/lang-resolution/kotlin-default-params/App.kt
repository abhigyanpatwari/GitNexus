fun greet(name: String, greeting: String = "Hello"): String = "$greeting, $name!"

fun process() {
    greet("Alice")
    greet("Bob", "Hi")
}
