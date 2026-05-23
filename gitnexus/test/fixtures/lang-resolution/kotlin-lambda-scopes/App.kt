// Kotlin lambda scopes fixture — issue #1757.
//
// Each function exercises a different lambda-binding shape; assertions
// in kotlin.test.ts verify the lambda parameter / implicit `it` binds
// only inside the lambda body and resolves to the correct stdlib idiom.

class User(val name: String) {
    fun save() {}
    fun isActive(): Boolean = true
}

class Post(val title: String) {
    fun like() {}
}

fun println(message: String) {}

fun explicitParam(users: List<User>) {
    users.forEach { user -> user.save() }
}

fun implicitIt(users: List<User>) {
    users.forEach { it.save() }
}

fun chained(users: List<User>) {
    users.map { it.name }.forEach { name -> println(name) }
}

fun nested(users: List<User>, posts: Map<User, List<Post>>) {
    users.forEach { user ->
        posts[user]?.forEach { it.like() }
    }
}

fun letScope(user: User?) {
    user?.let { it.save() }
}

fun applyScope(user: User) {
    user.apply { save() }
}

fun outerItShadow(users: List<User>) {
    val it = "outer"
    users.forEach { it.save() }
}
