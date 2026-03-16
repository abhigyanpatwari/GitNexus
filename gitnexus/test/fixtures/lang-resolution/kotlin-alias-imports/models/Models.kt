package models

class User(val name: String) {
    fun save(): Boolean = true
}

class Repo(val url: String) {
    fun persist(): Boolean = true
}
