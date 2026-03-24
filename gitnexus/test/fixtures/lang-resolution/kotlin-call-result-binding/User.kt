class User(val name: String) {
    fun save(): Boolean {
        return true
    }
}

fun getUser(name: String): User {
    return User(name)
}

fun processUser() {
    val user = getUser("alice")
    user.save()
}
