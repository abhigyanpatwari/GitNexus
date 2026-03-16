package models

class User(val name: String) {
    fun save() {}
}

fun getUser(name: String): User {
    return User(name)
}
