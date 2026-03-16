package models

class Repo(val name: String) {
    fun save() {}
}

fun getRepo(name: String): Repo {
    return Repo(name)
}
