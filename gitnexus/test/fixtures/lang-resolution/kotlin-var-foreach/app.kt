package app

import models.User
import models.Repo

fun processUsers(users: List<User>) {
    for (user in users) {
        user.save()
    }
}

fun processRepos(repos: List<Repo>) {
    for (repo in repos) {
        repo.save()
    }
}
