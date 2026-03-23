package app

import models.User
import models.Repo

fun processUsers(users: List<User>) {
    for (user: User in users) {
        user.save()
    }
}

fun processRepos(repos: List<Repo>) {
    for (repo: Repo in repos) {
        repo.save()
    }
}
