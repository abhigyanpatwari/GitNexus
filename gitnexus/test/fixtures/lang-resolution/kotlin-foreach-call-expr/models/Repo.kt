package models

class Repo(val name: String) {
    fun save() {}
}

fun getRepos(): List<Repo> {
    return listOf(Repo("main"))
}
