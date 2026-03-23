package models

class User(val name: String) {
    fun save() {}
}

fun getUsers(): List<User> {
    return listOf(User("alice"))
}
