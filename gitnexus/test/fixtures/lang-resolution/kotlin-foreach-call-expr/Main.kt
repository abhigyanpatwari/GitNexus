import models.getUsers
import models.getRepos

fun processUsers() {
    for (user in getUsers()) {
        user.save()
    }
}

fun processRepos() {
    for (repo in getRepos()) {
        repo.save()
    }
}

fun main() {}
